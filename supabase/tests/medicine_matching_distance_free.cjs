// PGlite regression coverage for distance-free medicine discovery.
// Run from the repository root with PGlite available on NODE_PATH:
// NODE_PATH="$HYPER_SCRATCH_DIR/node_modules" node supabase/tests/medicine_matching_distance_free.cjs
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = process.cwd()
const migrations = [
  'supabase/migrations/20261105060039_initial_schema.sql',
  'supabase/migrations/20261105061109_transactional_operations.sql',
  'supabase/migrations/20261105072638_medicine_matching.sql',
  'supabase/migrations/20261105121023_photo_proof_receipt.sql',
  'supabase/migrations/20261105160615_facility_verification.sql',
  'supabase/migrations/20261105192612_distance_free_medicine_matching.sql',
]
const id = {
  requester: '00000000-0000-0000-0000-000000000001',
  supplierA: '00000000-0000-0000-0000-000000000002',
  supplierB: '00000000-0000-0000-0000-000000000003',
  partial: '00000000-0000-0000-0000-000000000004',
  inactive: '00000000-0000-0000-0000-000000000005',
  expiredStock: '00000000-0000-0000-0000-000000000006',
  medicine: '20000000-0000-0000-0000-000000000001',
  admin: '10000000-0000-0000-0000-000000000001',
  manager: '10000000-0000-0000-0000-000000000002',
  requesterStaff: '10000000-0000-0000-0000-000000000003',
  supplierStaff: '10000000-0000-0000-0000-000000000004',
  otherUser: '10000000-0000-0000-0000-000000000005',
}
async function main() {
  const db = new PGlite(); let checks = 0
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
    await assert.rejects(() => asUser(userId, operation), undefined, label); checks++
  }
  const match = (facilityId = id.requester, medicineId = id.medicine, quantity = 10) =>
    db.query('select public.find_medicine_matches($1,$2,$3) as result', [facilityId, medicineId, quantity])
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth to authenticated;
      create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key,bucket_id text not null references storage.buckets(id),name text not null,created_at timestamptz default now(),unique(bucket_id,name));
      alter table storage.objects enable row level security;`)
    for (const migration of migrations) {
      const filename = path.join(root, migration)
      assert.ok(fs.existsSync(filename), `Missing migration: ${filename}`)
      await db.exec(fs.readFileSync(filename, 'utf8'))
    }
    checks += migrations.length
    await db.exec(`
      insert into public.facilities(id,name,facility_type,address,latitude,longitude) values
        ('${id.requester}','Requester','CLINIC','Request address',0,0),
        ('${id.supplierA}','Supplier A','PHARMACY','A address',0,0.1),
        ('${id.supplierB}','Supplier B','HOSPITAL','B address',0,0.5),
        ('${id.partial}','Partial supplier','PHARMACY','Partial address',0,0.2),
        ('${id.inactive}','Inactive supplier','PHARMACY','Inactive address',0,0.6),
        ('${id.expiredStock}','Expired-stock supplier','PHARMACY','Expired address',0,0.7);
      update public.facilities set operational_status='INACTIVE' where id='${id.inactive}';
      update public.facilities set verification_status='VERIFIED',verification_valid_until=current_date+10 where id='${id.supplierA}';
      update public.facilities set verification_status='VERIFIED',verification_valid_until=current_date-1 where id='${id.supplierB}';
      insert into auth.users(id) values
        ('${id.admin}'),('${id.manager}'),('${id.requesterStaff}'),('${id.supplierStaff}'),('${id.otherUser}');
      insert into public.profiles(id,facility_id,full_name,role) values
        ('${id.admin}','${id.requester}','Admin','FACILITY_ADMIN'),
        ('${id.manager}','${id.requester}','Manager','INVENTORY_MANAGER'),
        ('${id.requesterStaff}','${id.requester}','Requester staff','REQUESTING_STAFF'),
        ('${id.supplierStaff}','${id.requester}','Supplier staff','SUPPLIER_STAFF'),
        ('${id.otherUser}','${id.supplierA}','Other facility user','FACILITY_ADMIN');
      insert into public.medicines(id,name,strength,dosage_form,unit_of_measure)
        values ('${id.medicine}','Test medicine','10 mg','tablet','tablet');
      insert into public.inventory_batches(facility_id,medicine_id,batch_number,quantity_on_hand,quantity_reserved,expiry_date,last_updated_at) values
        ('${id.requester}','${id.medicine}','SELF',100,0,current_date+100,now()-interval '1 hour'),
        ('${id.supplierA}','${id.medicine}','A',20,0,current_date+100,now()-interval '1 hour'),
        ('${id.supplierB}','${id.medicine}','B',20,0,current_date+100,now()-interval '20 hours'),
        ('${id.partial}','${id.medicine}','PARTIAL',8,2,current_date+100,now()-interval '2 hours'),
        ('${id.inactive}','${id.medicine}','INACTIVE',100,0,current_date+100,now()-interval '1 hour'),
        ('${id.expiredStock}','${id.medicine}','EXPIRED',100,0,current_date-1,now()-interval '1 hour');`)
    const signature = 'public.find_medicine_matches(uuid,uuid,integer)'
    const security = await rows(`select prosecdef,proconfig,
      has_function_privilege('anon',oid,'EXECUTE') as anon_exec,
      has_function_privilege('authenticated',oid,'EXECUTE') as auth_exec
      from pg_proc where oid=$1::regprocedure`, [signature])
    assert.equal(security[0].prosecdef, true, 'RPC remains SECURITY DEFINER')
    assert.ok(security[0].proconfig.includes('search_path=""'), 'RPC keeps an empty search_path')
    assert.equal(security[0].anon_exec, false, 'anonymous callers cannot execute RPC')
    assert.equal(security[0].auth_exec, true, 'authenticated callers can execute RPC')
    checks += 4

    const result = (await asUser(id.admin, () => match())).rows[0].result
    assert.deepEqual(Object.keys(result).sort(), ['insufficient','matches','medicine_id','requested_quantity','scoring'].sort())
    assert.ok(Math.abs(result.scoring.quantity_weight - 0.714286) < 0.000001,
      'quantity weight is normalized from the legacy quantity:freshness ratio')
    assert.ok(Math.abs(result.scoring.freshness_weight - 0.285714) < 0.000001,
      'freshness weight is normalized from the legacy quantity:freshness ratio')
    assert.equal(result.scoring.stale_after_hours, 168)
    assert.deepEqual(Object.keys(result.scoring).sort(), ['freshness_weight','quantity_weight','stale_after_hours'])
    const itemKeys = [
      'facility_id','facility_name','facility_type','address','verification_status',
      'available_quantity','requested_quantity','unit_of_measure','last_updated_at',
      'quantity_score','freshness_score','match_score','reasons','warnings','stale','availability_status',
    ].sort()
    for (const item of [...result.matches, ...result.insufficient]) {
      assert.deepEqual(Object.keys(item).sort(), itemKeys, 'distance fields are absent while other API fields remain')
      assert.equal(item.availability_status, 'REQUIRES_CONFIRMATION')
      assert.equal(item.requested_quantity, 10)
      assert.equal(item.address.endsWith('address'), true, 'location is represented by address')
      assert.doesNotMatch(JSON.stringify(item), /distance|coordinate/i, 'response text contains no distance or coordinate language')
      checks++
    }
    assert.doesNotMatch(JSON.stringify(result.scoring), /distance|coordinate/i)
    assert.deepEqual(result.matches.map(item => item.facility_id), [id.supplierA, id.supplierB],
      'with equal quantities, fresher stock ranks first; expired stock is excluded')
    assert.equal(result.matches[0].verification_status, 'VERIFIED', 'current verification remains visible')
    assert.equal(result.matches[1].verification_status, 'UNVERIFIED', 'expired verification is masked')
    assert.equal(result.matches[0].quantity_score, 100)
    assert.equal(result.matches[0].freshness_score, 99.4)
    assert.equal(result.matches[1].freshness_score, 88.1)
    assert.equal(result.matches[0].match_score, 99.83, 'score uses normalized relative quantity:freshness weights')
    assert.equal(result.matches[1].match_score, 96.6)
    assert.deepEqual(result.insufficient.map(item => item.facility_id), [id.partial])
    assert.equal(result.insufficient[0].available_quantity, 6)
    assert.equal(result.insufficient[0].quantity_score, 60)
    assert.equal(result.insufficient[0].match_score, null)
    assert.ok(result.matches.every(item => item.reasons.every(reason => !/distance|coordinate/i.test(reason))))
    assert.ok(result.matches.every(item => item.warnings.every(warning => !/distance|coordinate/i.test(warning))))
    checks += 12

    await db.exec(`update public.facilities set latitude=80,longitude=170 where id in ('${id.requester}','${id.supplierA}');
      update public.facilities set latitude=-80,longitude=-170 where id='${id.supplierB}';`)
    const after = (await asUser(id.admin, () => match())).rows[0].result
    assert.deepEqual(after, result, 'changing coordinates cannot affect ordering or any response field')
    const functionDef = (await rows('select pg_get_functiondef($1::regprocedure) as definition', [signature]))[0].definition
    assert.doesNotMatch(functionDef, /latitude|longitude|distance_km|distance_score/i,
      'matching function does not read coordinates or calculate distances')
    checks += 2

    for (const authorized of [id.manager, id.requesterStaff, id.supplierStaff]) {
      const allowed = await asUser(authorized, () => match())
      assert.deepEqual(allowed.rows[0].result, result, 'existing allowed facility roles retain matching access')
      checks++
    }
    await deny(id.admin, () => match(id.supplierA), 'caller cannot match as another facility')
    await deny(id.admin, () => match(id.requester, '20000000-0000-0000-0000-000000000099'), 'unknown medicine is rejected')
    await deny(id.admin, () => match(id.requester, id.medicine, 0), 'nonpositive quantity is rejected')
    await deny(id.otherUser, () => match(), 'user at another facility cannot call for requester')
    await db.exec(`update public.profiles set account_status='INACTIVE' where id='${id.admin}'`)
    await deny(id.admin, () => match(), 'inactive profile cannot use matching')
    await db.exec(`update public.profiles set account_status='ACTIVE' where id='${id.admin}'`)
    await db.exec(`update public.facilities set operational_status='INACTIVE' where id='${id.requester}'`)
    await deny(id.admin, () => match(), 'inactive requesting facility cannot use matching')
    await db.exec(`update public.facilities set operational_status='ACTIVE' where id='${id.requester}'`)
    await db.exec('reset role; set role anon;')
    await assert.rejects(() => match(), undefined, 'anonymous role cannot execute matching')
    await db.exec('reset role;')
    await db.query("select set_config('request.jwt.claim.sub', '', false)")
    checks++

    await db.exec(`update public.medicine_matching_settings set
      quantity_weight=0.20000,distance_weight=0.50000,freshness_weight=0.30000,
      stale_after_hours=300.00,distance_max_km=80.00,missing_distance_score=37.50 where singleton`)
    const configured = (await asUser(id.manager, () => match())).rows[0].result
    assert.deepEqual(configured.scoring, {
      quantity_weight: 0.4, freshness_weight: 0.6, stale_after_hours: 300,
    }, 'configured quantity:freshness ratio is normalized')
    checks++
    await db.exec(`update public.medicine_matching_settings set
      quantity_weight=0,distance_weight=1,freshness_weight=0 where singleton`)
    const zeroSum = (await asUser(id.manager, () => match())).rows[0].result
    assert.deepEqual(zeroSum.scoring, {
      quantity_weight: 0.5, freshness_weight: 0.5, stale_after_hours: 300,
    }, 'zero quantity:freshness sum falls back to an even split')
    assert.ok(zeroSum.matches.every(item => Number.isFinite(item.match_score)))
    checks++

    console.log(`PASS: distance-free matching migration and ${checks} coordinate, scoring, response, eligibility and authorization checks`)
  } finally {
    await db.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
