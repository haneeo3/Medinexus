// Focused authorization and facility-isolation checks for facility setup completion.
// Run from the repository root with PGlite available on NODE_PATH.
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
  'supabase/migrations/20261105184526_facility_setup_complete.sql',
]
const id = {
  f1: '00000000-0000-0000-0000-000000000001',
  f2: '00000000-0000-0000-0000-000000000002',
  owner1: '10000000-0000-0000-0000-000000000001',
  owner2: '10000000-0000-0000-0000-000000000002',
}
async function main() {
  const db = new PGlite()
  let checks = 0
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows
  async function asUser(user, fn) {
    await db.exec('reset role; set role authenticated;')
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user])
    try { return await fn() } finally {
      await db.exec('reset role;')
      await db.query("select set_config('request.jwt.claim.sub','',false)")
    }
  }
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;
      create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key,bucket_id text not null references storage.buckets(id),name text not null,created_at timestamptz default now(),unique(bucket_id,name));
      alter table storage.objects enable row level security;`)
    for (const migration of migrations) {
      await db.exec(fs.readFileSync(path.join(root, migration), 'utf8'))
    }
    await db.exec(`insert into public.facilities(id,name,facility_type,address) values
      ('${id.f1}','Clinic One','CLINIC','1 Main St'),
      ('${id.f2}','Clinic Two','CLINIC','2 Main St');
      insert into auth.users(id) values ('${id.owner1}'),('${id.owner2}');
      insert into public.profiles(id,facility_id,full_name,role) values
      ('${id.owner1}','${id.f1}','Owner One','FACILITY_ADMIN'),
      ('${id.owner2}','${id.f2}','Owner Two','FACILITY_ADMIN');
      insert into public.facility_licenses(facility_id,license_number,license_authority,license_expiry_date,submitted_by)
      values ('${id.f2}','PRIVATE-LICENCE-2','Private Authority','2099-12-31','${id.owner2}');`)

    const signature = 'public.facility_setup_complete()'
    const security = await rows(`select prosecdef,proconfig,prorettype::regtype::text result_type,
      has_function_privilege('anon',oid,'EXECUTE') anon_exec,
      has_function_privilege('authenticated',oid,'EXECUTE') auth_exec
      from pg_proc where oid=$1::regprocedure`, [signature])
    assert.equal(security[0].prosecdef, true, 'RPC runs as SECURITY DEFINER')
    assert.ok(security[0].proconfig.includes('search_path=""'), 'RPC pins an empty search_path')
    assert.equal(security[0].result_type, 'boolean')
    assert.equal(security[0].anon_exec, false, 'anonymous role cannot execute RPC')
    assert.equal(security[0].auth_exec, true, 'authenticated role can execute RPC')
    checks += 5

    const withoutOwnLicence = await asUser(id.owner1, () => rows('select public.facility_setup_complete() as complete'))
    assert.equal(withoutOwnLicence[0].complete, false,
      'a different facility licence does not complete this user’s setup')
    checks++
    const withOwnLicence = await asUser(id.owner2, () => rows('select public.facility_setup_complete() as complete'))
    assert.equal(withOwnLicence[0].complete, true, 'submitted own-facility licence completes setup')
    checks++

    const submitted = await asUser(id.owner1, () => db.query(
      'select * from public.submit_facility_profile($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      ['Clinic One', 'CLINIC', '1 Main St', 10, 20, null, 'LIC-001', 'Health Authority', '2099-12-31']))
    assert.equal(submitted.rows[0].facility_id, id.f1)
    checks++
    const afterSubmission = await asUser(id.owner1, () => rows('select public.facility_setup_complete() as complete'))
    assert.equal(afterSubmission[0].complete, true,
      'existing profile submission makes only the submitting facility complete')
    checks++

    await db.exec('reset role; set role anon;')
    await assert.rejects(() => db.query('select public.facility_setup_complete()'))
    checks++
    await db.exec('reset role;')
    await db.close()
    console.log(`PASS: facility_setup_complete RPC isolation, submission state, and privileges (${checks} checks)`)
  } catch (error) {
    await db.close()
    throw error
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
