// Local PGlite test for inventory metadata RPC and audit RLS.
// Run from the repository root with:
// NODE_PATH="$HYPER_SCRATCH_DIR/node_modules" node supabase/tests/inventory_metadata.cjs
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = process.cwd()
const migrations = [
  'supabase/migrations/20261105060039_initial_schema.sql',
  'supabase/migrations/20261105061109_transactional_operations.sql',
  'supabase/migrations/20261105065507_inventory_metadata.sql',
]
const ids = {
  f1: '00000000-0000-0000-0000-000000000001',
  f2: '00000000-0000-0000-0000-000000000002',
  medicine: '20000000-0000-0000-0000-000000000001',
  admin: '10000000-0000-0000-0000-000000000001',
  manager: '10000000-0000-0000-0000-000000000002',
  staff: '10000000-0000-0000-0000-000000000003',
  otherManager: '10000000-0000-0000-0000-000000000004',
  otherAdmin: '10000000-0000-0000-0000-000000000005',
  batch: '30000000-0000-0000-0000-000000000001',
  competingBatch: '30000000-0000-0000-0000-000000000002',
  otherBatch: '30000000-0000-0000-0000-000000000003',
}

async function main() {
  const db = new PGlite()
  let checks = 0
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows
  async function asUser(userId, operation) {
    await db.exec('reset role; set role authenticated;')
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId])
    try { return await operation() } finally {
      await db.exec('reset role;')
      await db.query("select set_config('request.jwt.claim.sub', '', false)")
    }
  }
  const update = (batchId, batchNumber, expiry, threshold, notes = 'metadata review') =>
    db.query('select public.update_inventory_batch($1,$2,$3,$4,$5) as id',
      [batchId, batchNumber, expiry, threshold, notes])
  async function denied(userId, operation, label) {
    await assert.rejects(() => asUser(userId, operation), undefined, label)
    checks++
  }

  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to authenticated;
    `)
    for (const migration of migrations) {
      const filename = path.join(root, migration)
      assert.ok(fs.existsSync(filename), `Missing migration: ${filename}`)
      await db.exec(fs.readFileSync(filename, 'utf8'))
    }
    await db.exec(`
      insert into public.facilities(id,name,facility_type,address) values
        ('${ids.f1}','Facility One','CLINIC','Test address'),
        ('${ids.f2}','Facility Two','PHARMACY','Test address');
      insert into auth.users(id) values
        ('${ids.admin}'),('${ids.manager}'),('${ids.staff}'),('${ids.otherManager}'),('${ids.otherAdmin}');
      insert into public.profiles(id,facility_id,full_name,role) values
        ('${ids.admin}','${ids.f1}','Facility Admin','FACILITY_ADMIN'),
        ('${ids.manager}','${ids.f1}','Inventory Manager','INVENTORY_MANAGER'),
        ('${ids.staff}','${ids.f1}','Requesting Staff','REQUESTING_STAFF'),
        ('${ids.otherManager}','${ids.f2}','Other Inventory Manager','INVENTORY_MANAGER'),
        ('${ids.otherAdmin}','${ids.f2}','Other Facility Admin','FACILITY_ADMIN');
      insert into public.medicines(id,name,strength,dosage_form,unit_of_measure)
        values ('${ids.medicine}','Test medicine','10 mg','tablet','tablet');
      insert into public.inventory_batches(
        id,facility_id,medicine_id,batch_number,quantity_on_hand,quantity_reserved,
        low_stock_threshold,expiry_date,last_updated_at
      ) values
        ('${ids.batch}','${ids.f1}','${ids.medicine}','BATCH-A',20,5,2,'2099-12-31','2020-01-02 03:04:05+00'),
        ('${ids.competingBatch}','${ids.f1}','${ids.medicine}','BATCH-B',9,0,1,'2099-12-31','2020-01-03 03:04:05+00'),
        ('${ids.otherBatch}','${ids.f2}','${ids.medicine}','BATCH-A',11,0,1,'2099-12-31','2020-01-04 03:04:05+00');
    `)

    const signature = 'public.update_inventory_batch(uuid,text,date,integer,text)'
    const security = await rows(`select prosecdef, proconfig,
      has_function_privilege('anon', oid, 'EXECUTE') as anon_exec,
      has_function_privilege('authenticated', oid, 'EXECUTE') as auth_exec
      from pg_proc where oid=$1::regprocedure`, [signature])
    assert.equal(security[0].prosecdef, true, 'RPC is SECURITY DEFINER')
    assert.ok(security[0].proconfig.includes('search_path=""'), 'RPC has an empty search_path')
    assert.equal(security[0].anon_exec, false, 'anonymous role cannot execute RPC')
    assert.equal(security[0].auth_exec, true, 'authenticated role can execute RPC')
    checks += 4

    await denied(ids.staff, () => update(ids.batch, 'NO', '2099-12-31', 1), 'requesting staff cannot edit inventory')
    await denied(ids.otherManager, () => update(ids.batch, 'NO', '2099-12-31', 1), 'other facility manager is denied')
    await denied(ids.manager, () => update(ids.batch, 'BATCH-A', '2098-12-31', 7), 'reserved stock expiry cannot change')
    await denied(ids.manager, () => update(ids.batch, 'BATCH-B', '2099-12-31', 7), 'facility/medicine batch number uniqueness is enforced')
    await denied(ids.manager, () => update(ids.batch, '  ', '2099-12-31', 7), 'blank batch number is rejected')
    await denied(ids.manager, () => update(ids.batch, 'VALID', '2099-12-31', -1), 'negative threshold is rejected')
    await denied(ids.manager, () => update(null, 'VALID', '2099-12-31', 1), 'null batch id is rejected')
    await denied(ids.manager, () => update(ids.batch, 'VALID', null, 1), 'null expiry is rejected')
    await denied(ids.manager, () => update(ids.batch, 'VALID', '2099-12-31', 1, '   '), 'blank notes are rejected')
    checks += 9

    const result = await asUser(ids.manager, () => update(ids.batch, '  BATCH-A-EDITED  ', '2099-12-31', 7, 'corrected label'))
    assert.equal(result.rows[0].id, ids.batch, 'RPC returns the batch UUID')
    checks++
    let state = await rows(`select batch_number,quantity_on_hand,quantity_reserved,low_stock_threshold,
      expiry_date::text,last_updated_at::text from public.inventory_batches where id=$1`, [ids.batch])
    assert.deepEqual(state[0], {
      batch_number: 'BATCH-A-EDITED', quantity_on_hand: 20, quantity_reserved: 5,
      low_stock_threshold: 7, expiry_date: '2099-12-31', last_updated_at: '2020-01-02 03:04:05+00',
    }, 'only editable metadata changes; stock and physical freshness timestamp remain unchanged')
    checks++

    let audit = await rows('select * from public.inventory_batch_changes where inventory_batch_id=$1', [ids.batch])
    assert.equal(audit.length, 1)
    assert.deepEqual(audit[0].before_metadata, {
      batch_number: 'BATCH-A', expiry_date: '2099-12-31', low_stock_threshold: 2,
    })
    assert.deepEqual(audit[0].after_metadata, {
      batch_number: 'BATCH-A-EDITED', expiry_date: '2099-12-31', low_stock_threshold: 7,
    })
    assert.equal(audit[0].actor_id, ids.manager)
    assert.equal(audit[0].notes, 'corrected label')
    assert.ok(audit[0].created_at)
    checks += 5

    await asUser(ids.admin, () => update(ids.batch, 'BATCH-A-EDITED', '2099-12-31', 7, 'no-op'))
    assert.equal((await rows('select count(*)::int as n from public.inventory_batch_changes')).at(0).n, 1,
      'metadata no-op does not add an audit row')
    checks++

    await asUser(ids.admin, () => update(ids.competingBatch, 'BATCH-B', '2098-12-31', 1, 'unreserved expiry edit'))
    const unlockedExpiry = await rows('select expiry_date::text from public.inventory_batches where id=$1', [ids.competingBatch])
    assert.equal(unlockedExpiry[0].expiry_date, '2098-12-31', 'expiry may change when reserved quantity is zero')
    checks += 2

    await asUser(ids.otherAdmin, () => update(ids.otherBatch, 'BATCH-A-OTHER', '2099-12-31', 4, 'facility two edit'))
    const visibleToF1 = await asUser(ids.manager, () => rows('select facility_id from public.inventory_batch_changes order by facility_id'))
    assert.deepEqual(visibleToF1.map(row => row.facility_id), [ids.f1, ids.f1], 'RLS exposes only audit rows for accessible facilities')
    const visibleToF2 = await asUser(ids.otherManager, () => rows('select facility_id from public.inventory_batch_changes'))
    assert.deepEqual(visibleToF2.map(row => row.facility_id), [ids.f2], 'RLS isolates another facility audit rows')
    checks += 2

    await denied(ids.manager, () => db.query(`insert into public.inventory_batch_changes(
      inventory_batch_id,facility_id,actor_id,before_metadata,after_metadata
    ) values ($1,$2,$3,'{}','{}')`, [ids.batch, ids.f1, ids.manager]
), 'authenticated direct audit writes are revoked')
    await denied(ids.manager, () => db.query('update public.inventory_batch_changes set notes=$2 where inventory_batch_id=$1', [ids.batch, 'tamper']), 'authenticated audit updates are revoked')
    await denied(ids.manager, () => db.query('delete from public.inventory_batch_changes where inventory_batch_id=$1', [ids.batch]), 'authenticated audit deletes are revoked')
    checks += 3

    await db.exec('reset role; set role anon;')
    await assert.rejects(() => update(ids.batch, 'ANON', '2099-12-31', 0), undefined, 'anonymous RPC execution is denied')
    await assert.rejects(() => db.query('select * from public.inventory_batch_changes'), undefined, 'anonymous audit reads are denied')
    checks += 2
    console.log(`PASS: inventory metadata migration and ${checks} authorization, validation, audit, RLS, and preservation checks`)
  } finally {
    await db.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
