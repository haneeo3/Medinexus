// Independent PGlite coverage for aggregate medicine discovery.
// Run from the repository root:
// NODE_PATH="$HYPER_SCRATCH_DIR/node_modules" node supabase/tests/medicine_matching.cjs
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = process.cwd()
const migrations = [
  'supabase/migrations/20261105060039_initial_schema.sql',
  'supabase/migrations/20261105061109_transactional_operations.sql',
  'supabase/migrations/20261105065507_inventory_metadata.sql',
  'supabase/migrations/20261105072638_medicine_matching.sql',
]
const id = {
  requester: '00000000-0000-0000-0000-000000000001',
  near: '00000000-0000-0000-0000-000000000002',
  tie: '00000000-0000-0000-0000-000000000009',
  far: '00000000-0000-0000-0000-000000000003',
  partial: '00000000-0000-0000-0000-000000000004',
  stale: '00000000-0000-0000-0000-000000000005',
  missing: '00000000-0000-0000-0000-000000000006',
  expired: '00000000-0000-0000-0000-000000000007',
  inactive: '00000000-0000-0000-0000-000000000008',
  medicine: '20000000-0000-0000-0000-000000000001',
  admin: '10000000-0000-0000-0000-000000000001',
  manager: '10000000-0000-0000-0000-000000000002',
  requesterStaff: '10000000-0000-0000-0000-000000000003',
  supplierStaff: '10000000-0000-0000-0000-000000000004',
  otherUser: '10000000-0000-0000-0000-000000000005',
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
  async function deny(userId, operation, label) {
    await assert.rejects(() => asUser(userId, operation), undefined, label)
    checks++
  }
  const match = (facilityId = id.requester, medicineId = id.medicine, quantity = 10) =>
    db.query('select public.find_medicine_matches($1,$2,$3) as result', [facilityId, medicineId, quantity])

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
    checks += 4
    await db.exec(`
      insert into public.facilities(id,name,facility_type,address,latitude,longitude) values
        ('${id.requester}','Requester','CLINIC','Requester address',0,0),
        ('${id.near}','Near supplier','PHARMACY','Near address',0,0.1),
        ('${id.tie}','Near supplier','PHARMACY','Tie address',0,0.1),
        ('${id.far}','Far supplier','HOSPITAL','Far address',0,0.5),
        ('${id.partial}','Partial supplier','PHARMACY','Partial address',0,0.2),
        ('${id.stale}','Stale supplier','CLINIC','Stale address',0,0.3),
        ('${id.missing}','No-coordinate supplier','OTHER','Missing address',null,null),
        ('${id.expired}','Expired supplier','PHARMACY','Expired address',0,0.4),
        ('${id.inactive}','Inactive supplier','PHARMACY','Inactive address',0,0.6);
      update public.facilities set operational_status='INACTIVE' where id='${id.inactive}';
      insert into auth.users(id) values
        ('${id.admin}'),('${id.manager}'),('${id.requesterStaff}'),('${id.supplierStaff}'),('${id.otherUser}');
      insert into public.profiles(id,facility_id,full_name,role) values
        ('${id.admin}','${id.requester}','Admin','FACILITY_ADMIN'),
        ('${id.manager}','${id.requester}','Manager','INVENTORY_MANAGER'),
        ('${id.requesterStaff}','${id.requester}','Requester staff','REQUESTING_STAFF'),
        ('${id.supplierStaff}','${id.requester}','Supplier staff','SUPPLIER_STAFF'),
        ('${id.otherUser}','${id.near}','Other facility user','FACILITY_ADMIN');
      insert into public.medicines(id,name,strength,dosage_form,unit_of_measure)
        values ('${id.medicine}','Test medicine','10 mg','tablet','tablet');
      insert into public.inventory_batches(
        facility_id,medicine_id,batch_number,quantity_on_hand,quantity_reserved,expiry_date,last_updated_at
      ) values
        ('${id.requester}','${id.medicine}','SELF',100,0,current_date+100,now()-interval '1 hour'),
        ('${id.near}','${id.medicine}','NEAR-A',60,10,current_date+100,now()-interval '1 hour'),
        ('${id.near}','${id.medicine}','NEAR-B',70,0,current_date+100,now()-interval '20 hours'),
        ('${id.near}','${id.medicine}','NEAR-EMPTY',5,5,current_date+100,now()-interval '1000 hours'),
        ('${id.far}','${id.medicine}','FAR',100,0,current_date+100,now()-interval '1 hour'),
        ('${id.partial}','${id.medicine}','PARTIAL',8,2,current_date+100,now()-interval '2 hours'),
        ('${id.stale}','${id.medicine}','STALE',20,0,current_date+100,now()-interval '200 hours'),
        ('${id.missing}','${id.medicine}','MISSING',30,0,current_date+100,now()-interval '3 hours'),
        ('${id.expired}','${id.medicine}','EXPIRED',100,0,current_date-1,now()-interval '1 hour'),
        ('${id.inactive}','${id.medicine}','INACTIVE',100,0,current_date+100,now()-interval '1 hour');
      insert into public.inventory_batches(facility_id,medicine_id,batch_number,quantity_on_hand,expiry_date,last_updated_at)
        select '${id.tie}','${id.medicine}','TIE',120,current_date+100,min(last_updated_at)
        from public.inventory_batches where facility_id='${id.near}'
          and quantity_on_hand>quantity_reserved and expiry_date>=current_date;
    `)

    const signature = 'public.find_medicine_matches(uuid,uuid,integer)'
    const security = await rows(`select prosecdef,proconfig,
      has_function_privilege('anon',oid,'EXECUTE') as anon_exec,
      has_function_privilege('authenticated',oid,'EXECUTE') as auth_exec
      from pg_proc where oid=$1::regprocedure`, [signature])
    assert.equal(security[0].prosecdef, true, 'RPC is SECURITY DEFINER')
    assert.ok(security[0].proconfig.includes('search_path=""'), 'RPC uses an empty search_path')
    assert.equal(security[0].anon_exec, false, 'anon cannot execute matching RPC')
    assert.equal(security[0].auth_exec, true, 'authenticated can execute matching RPC')
    checks += 4

    const result = (await asUser(id.admin, () => match())).rows[0].result
    assert.deepEqual(Object.keys(result).sort(), ['insufficient','matches','medicine_id','requested_quantity','scoring'].sort())
    assert.equal(result.medicine_id, id.medicine)
    assert.equal(result.requested_quantity, 10)
    assert.deepEqual(result.scoring, {
      quantity_weight: 0.5, distance_weight: 0.3, freshness_weight: 0.2,
      stale_after_hours: 168, distance_max_km: 100, missing_distance_score: 50,
    })
    const itemKeys = [
      'facility_id','facility_name','facility_type','address','verification_status',
      'available_quantity','requested_quantity','unit_of_measure','distance_km','last_updated_at',
      'quantity_score','distance_score','freshness_score','match_score','reasons','warnings',
      'stale','availability_status',
    ].sort()
    for (const item of [...result.matches, ...result.insufficient]) {
      assert.deepEqual(Object.keys(item).sort(), itemKeys, 'every result object has the exact contract shape')
      assert.equal(item.availability_status, 'REQUIRES_CONFIRMATION')
      assert.equal(item.requested_quantity, 10)
      assert.equal(item.unit_of_measure, 'tablet')
      assert.ok(Array.isArray(item.reasons) && Array.isArray(item.warnings))
      assert.ok(item.warnings.some(warning => warning.includes('requires supplier confirmation')))
      checks++
    }
    assert.deepEqual(result.insufficient.map(item => item.facility_id), [id.partial],
      'positive eligible stock below request appears only in insufficient')
    assert.equal(result.insufficient[0].available_quantity, 6)
    assert.equal(result.insufficient[0].quantity_score, 60)
    assert.equal(result.insufficient[0].match_score, null, 'partial is never assigned a full-match score')
    assert.ok(result.insufficient[0].warnings.some(warning => warning.includes('Partial stock only')))
    checks += 4

    const fullIds = result.matches.map(item => item.facility_id)
    assert.ok(fullIds.includes(id.near) && fullIds.includes(id.far) && fullIds.includes(id.stale) && fullIds.includes(id.missing))
    assert.ok(!fullIds.includes(id.requester), 'requesting facility is never a supplier')
    assert.ok(!fullIds.includes(id.expired), 'expired stock is excluded')
    assert.ok(!fullIds.includes(id.inactive), 'inactive facility stock is excluded')
    assert.ok(!fullIds.includes(id.partial), 'insufficient stock is not a full match')
    assert.deepEqual(result.matches.map(item => item.match_score),
      [...result.matches].map(item => item.match_score).sort((a,b) => b-a), 'full matches rank by score descending')
    checks += 6

    const near = result.matches.find(item => item.facility_id === id.near)
    const far = result.matches.find(item => item.facility_id === id.far)
    const stale = result.matches.find(item => item.facility_id === id.stale)
    const missing = result.matches.find(item => item.facility_id === id.missing)
    assert.ok(near.match_score > far.match_score, 'near facility outranks farther facility')
    const tie = result.matches.find(item => item.facility_id === id.tie)
    assert.equal(tie.match_score, near.match_score, 'tie fixture has an exactly equal score')
    assert.ok(result.matches.findIndex(item => item.facility_id === id.near) <
      result.matches.findIndex(item => item.facility_id === id.tie), 'score ties use stable facility-name and ID ordering')
    assert.equal(near.available_quantity, 120, 'eligible batch quantities aggregate after reservations')
    assert.equal(near.distance_km, 11.1)
    assert.equal(near.quantity_score, 100)
    assert.equal(near.distance_score, 88.88)
    assert.equal(near.freshness_score, 88.1)
    assert.equal(near.match_score, 94.28)
    assert.equal(near.stale, false)
    assert.equal(new Date(near.last_updated_at).getTime(), new Date((await rows(`select min(last_updated_at)::text as t from public.inventory_batches
      where facility_id=$1 and quantity_on_hand>quantity_reserved and expiry_date>=current_date`, [id.near]))[0].t).getTime(),
      'freshness uses oldest eligible positive-availability batch timestamp')
    assert.equal(stale.stale, true, 'stock older than threshold is flagged, not excluded')
    assert.equal(stale.freshness_score, 0)
    assert.ok(stale.warnings.some(warning => warning.includes('stale')))
    assert.equal(missing.distance_km, null, 'no coordinates means no invented distance')
    assert.equal(missing.distance_score, 50, 'missing distance uses neutral default fallback')
    assert.ok(missing.warnings.some(warning => warning.includes('coordinates are missing')))
    checks += 15

    for (const authorized of [id.manager, id.requesterStaff, id.supplierStaff]) {
      const allowed = await asUser(authorized, () => match())
      assert.equal(allowed.rows[0].result.matches.length, result.matches.length,
        'all specified facility roles can use matching for their own active facility')
      checks++
    }

    await deny(id.admin, () => match(id.near), 'requester cannot search using another facility identity')
    await deny(id.admin, () => match(id.requester, '20000000-0000-0000-0000-000000000099'), 'unknown medicine is rejected')
    await deny(id.admin, () => match(id.requester, id.medicine, 0), 'zero quantity is rejected')
    await deny(id.admin, () => match(id.requester, id.medicine, -3), 'negative quantity is rejected')
    await deny(id.admin, () => match(null), 'null requesting facility is rejected')

    const ownStock = await asUser(id.admin, () => rows('select facility_id from public.inventory_batches order by facility_id'))
    assert.deepEqual([...new Set(ownStock.map(row => row.facility_id))], [id.requester],
      'authenticated direct inventory reads remain facility scoped')
    await deny(id.admin, () => rows('select * from public.medicine_matching_settings'),
      'authenticated clients cannot read or modify matching configuration table')
    checks++

    await db.exec('reset role; set role anon;')
    await assert.rejects(() => match(), undefined, 'anonymous callers cannot execute matching RPC')
    await assert.rejects(() => db.query('select * from public.inventory_batches'), undefined,
      'anonymous callers cannot read inventory')
    await db.exec('reset role;')
    await db.query("select set_config('request.jwt.claim.sub', '', false)")
    checks += 2

    await db.exec(`update public.medicine_matching_settings set
      quantity_weight=0.20000,distance_weight=0.50000,freshness_weight=0.30000,
      stale_after_hours=300.00,distance_max_km=80.00,missing_distance_score=37.50
      where singleton`)
    await assert.rejects(() => db.exec(`update public.medicine_matching_settings
      set quantity_weight=0.20000,distance_weight=0.20000,freshness_weight=0.20000 where singleton`),
      undefined, 'configuration weights must sum to one')
    const configured = (await asUser(id.manager, () => match())).rows[0].result
    assert.deepEqual(configured.scoring, {
      quantity_weight: 0.2, distance_weight: 0.5, freshness_weight: 0.3,
      stale_after_hours: 300, distance_max_km: 80, missing_distance_score: 37.5,
    }, 'response exposes all effective configured values')
    const configuredMissing = configured.matches.find(item => item.facility_id === id.missing)
    const configuredStale = configured.matches.find(item => item.facility_id === id.stale)
    const configuredNear = configured.matches.find(item => item.facility_id === id.near)
    assert.equal(configuredMissing.distance_score, 37.5, 'configured missing-distance fallback is applied')
    assert.equal(configuredStale.stale, false, 'stale threshold is configurable')
    assert.equal(configuredStale.freshness_score, 33.33)
    assert.equal(configuredNear.distance_score, 86.1, 'configured distance scale is applied')
    assert.equal(configuredNear.match_score, 91.05, 'effective configured weights are used in the score')
    checks += 6

    await db.exec("update public.profiles set account_status='INACTIVE' where id='" + id.admin + "'")
    await deny(id.admin, () => match(), 'inactive facility profile cannot use matching')
    console.log(`PASS: medicine matching migration and ${checks} shape, scoring, stock, freshness, configuration and authorization checks`)
  } finally {
    await db.close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
