// Real PostgreSQL 17 test. Requires embedded-postgres and pg in NODE_PATH.
// Creates an isolated, temporary server on localhost; it does not access Supabase.
const { default: EmbeddedPostgres } = require('embedded-postgres')
const { Client } = require('pg')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function waitForLock(client, pid) {
  for (let i = 0; i < 100; i++) {
    const { rows } = await client.query('select wait_event_type from pg_stat_activity where pid=$1', [pid])
    if (rows[0]?.wait_event_type === 'Lock') return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw Error('Second connection did not wait for the expected lock')
}
async function main() {
  const port = await freePort()
  const password = crypto.randomBytes(24).toString('hex')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'medinexus-pg-'))
  const server = new EmbeddedPostgres({ databaseDir: path.join(dir, 'data'), user: 'postgres', password, port,
    persistent: false, autoRehydrateSymlinks: true, postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: m => console.error(m) })
  const clients = []
  let started = false
  try {
    await server.initialise()
    await server.start()
    started = true
    async function connect() {
      const c = new Client({ host:'127.0.0.1', port, user:'postgres', password, database:'postgres' })
      await c.connect()
      clients.push(c)
      return c
    }
    const owner = await connect(), requester = await connect(), first = await connect(), second = await connect()
    await owner.query(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to authenticated;`)
    await owner.query(fs.readFileSync('supabase/migrations/20261105060039_initial_schema.sql', 'utf8'))
    await owner.query(fs.readFileSync('supabase/migrations/20261105061109_transactional_operations.sql', 'utf8'))
    const f1='00000000-0000-0000-0000-000000000001', f2='00000000-0000-0000-0000-000000000002'
    const u1='10000000-0000-0000-0000-000000000001', u2='10000000-0000-0000-0000-000000000002'
    const med='20000000-0000-0000-0000-000000000001'
    await owner.query(`insert into public.facilities(id,name,facility_type,address) values
      ('${f1}','Demo Clinic','CLINIC','Test'),('${f2}','Demo Supplier','PHARMACY','Test');
      insert into auth.users(id) values ('${u1}'),('${u2}');
      insert into public.profiles(id,facility_id,full_name,role) values
      ('${u1}','${f1}','Requester','REQUESTING_STAFF'),('${u2}','${f2}','Supplier','FACILITY_ADMIN');
      insert into public.medicines(id,name,strength,dosage_form,unit_of_measure) values
      ('${med}','Test medicine','10 mg','tablet','tablet');`)
    for (const [client,user] of [[requester,u1],[first,u2],[second,u2]]) {
      await client.query('set role authenticated')
      await client.query("select set_config('request.jwt.claim.sub',$1,false)", [user])
    }
    const batch = (await first.query('select public.create_inventory_batch($1,$2,$3,$4,$5,$6) id',
      [f2,med,'TEST',10,'2099-01-01',0])).rows[0].id
    const makeRequest = async () => (await requester.query('select public.create_supply_request($1,$2,$3,$4,$5) id',
      [f1,f2,med,7,'concurrency test'])).rows[0].id
    const r1 = await makeRequest(), r2 = await makeRequest()
    const pid = (await second.query('select pg_backend_pid() id')).rows[0].id
    // Hold the first approval open. The second must block on the same batch,
    // then fail after the first commits rather than double-reserving stock.
    await first.query('begin')
    await first.query('select public.approve_supply_request($1)', [r1])
    await second.query('begin')
    const pendingApproval = second.query('select public.approve_supply_request($1)', [r2])
      .then(() => ({ ok: true }), error => ({ error }))
    await waitForLock(owner, pid)
    await first.query('commit')
    const approvalResult = await pendingApproval
    assert.match(approvalResult.error?.message || '', /Insufficient eligible available stock/)
    await second.query('rollback')
    let stock = (await owner.query('select quantity_on_hand,quantity_reserved from public.inventory_batches where id=$1', [batch])).rows[0]
    assert.deepEqual(stock, { quantity_on_hand:10, quantity_reserved:7 })
    let requests = (await owner.query('select id,status from public.supply_requests where id=any($1::uuid[])', [[r1,r2]])).rows
    assert.equal(requests.find(r => r.id === r1).status, 'APPROVED')
    assert.equal(requests.find(r => r.id === r2).status, 'PENDING')

    // Two fulfilment attempts must serialize on the request row.
    await first.query('begin')
    await first.query('select public.fulfil_supply_request($1)', [r1])
    await second.query('begin')
    const pendingFulfilment = second.query('select public.fulfil_supply_request($1)', [r1])
      .then(() => ({ ok:true }), error => ({ error }))
    await waitForLock(owner, pid)
    await first.query('commit')
    const fulfilmentResult = await pendingFulfilment
    assert.match(fulfilmentResult.error?.message || '', /Only approved requests can be fulfilled/)
    await second.query('rollback')
    stock = (await owner.query('select quantity_on_hand,quantity_reserved from public.inventory_batches where id=$1', [batch])).rows[0]
    assert.deepEqual(stock, { quantity_on_hand:3, quantity_reserved:0 })
    const movements = (await owner.query("select count(*)::integer n from public.stock_movements where supply_request_id=$1 and movement_type='FULFILMENT_OUT'", [r1])).rows[0].n
    assert.equal(movements, 1)
    console.log('PASS: concurrent approval blocks over-allocation; concurrent duplicate fulfilment deducts once (PostgreSQL 17)')
  } finally {
    for (const client of clients) { try { await client.end() } catch {} }
    if (started) await server.stop()
    try { fs.rmdirSync(dir) } catch {}
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
