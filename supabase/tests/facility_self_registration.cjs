// Self-registration authorization, eligibility, atomicity and isolation tests.
// Run from the repository root with PGlite installed.
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
  'supabase/migrations/20261105191808_facility_self_registration.sql',
]
const ids = {
  facility: '00000000-0000-0000-0000-000000000001',
  active: '10000000-0000-0000-0000-000000000001',
  inactive: '10000000-0000-0000-0000-000000000002',
  newUser: '10000000-0000-0000-0000-000000000003',
}
const args = ['Alex Admin', 'New Clinic', 'CLINIC', '123 Health Road',
  'https://clinic.example/logo.png', 'LIC-NEW-001', 'Health Authority', '2099-12-31']
async function main() {
  const db = new PGlite()
  let checks = 0
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows
  async function as(role, user, fn) {
    await db.exec(`reset role; set role ${role};`)
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user || ''])
    try { return await fn() } finally {
      await db.exec('reset role;')
      await db.query("select set_config('request.jwt.claim.sub','',false)")
    }
  }
  const register = (input = args) => db.query(
    'select public.register_facility($1,$2,$3,$4,$5,$6,$7,$8) as id', input,
  )
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
    for (const file of migrations) await db.exec(fs.readFileSync(path.join(root, file), 'utf8'))
    await db.exec(`insert into auth.users(id) values ('${ids.active}'),('${ids.inactive}'),('${ids.newUser}');
      insert into public.facilities(id,name,facility_type,address) values ('${ids.facility}','Existing','CLINIC','1 Existing Road');
      insert into public.profiles(id,facility_id,full_name,role,account_status) values
        ('${ids.active}','${ids.facility}','Active User','FACILITY_ADMIN','ACTIVE'),
        ('${ids.inactive}','${ids.facility}','Inactive User','FACILITY_ADMIN','INACTIVE');`)

    const privileges = await rows(`select p.proname,p.prosecdef,p.proconfig,p.prorettype::regtype::text result_type,
      pg_get_function_arguments(p.oid) arguments,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_exec,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth_exec
      from pg_proc p where p.oid = any(array[
        'public.can_register_facility()'::regprocedure,
        'public.register_facility(text,text,text,text,text,text,text,date)'::regprocedure
      ]) order by p.proname`)
    assert.equal(privileges.length, 2)
    for (const fn of privileges) {
      assert.equal(fn.prosecdef, true)
      assert.ok(fn.proconfig.includes('search_path=""'))
      assert.equal(fn.anon_exec, false)
      assert.equal(fn.auth_exec, true)
      checks += 4
    }
    assert.equal(privileges.find(f => f.proname === 'can_register_facility').result_type, 'boolean')
    assert.equal(privileges.find(f => f.proname === 'register_facility').result_type, 'uuid')
    assert.equal(privileges.find(f => f.proname === 'register_facility').arguments,
      'p_full_name text, p_name text, p_facility_type text, p_address text, p_image_url text, p_license_number text, p_license_authority text, p_license_expiry_date date')
    checks += 3

    assert.equal((await as('authenticated', '', () => rows('select public.can_register_facility() allowed')))[0].allowed, false)
    assert.equal((await as('authenticated', ids.newUser, () => rows('select public.can_register_facility() allowed')))[0].allowed, true)
    assert.equal((await as('authenticated', ids.active, () => rows('select public.can_register_facility() allowed')))[0].allowed, false)
    assert.equal((await as('authenticated', ids.inactive, () => rows('select id from public.profiles where id=$1', [ids.inactive]))).length, 0,
      'inactive profile is hidden by RLS')
    assert.equal((await as('authenticated', ids.inactive, () => rows('select public.can_register_facility() allowed')))[0].allowed, false,
      'eligibility sees inactive profile despite RLS')
    checks += 5
    await assert.rejects(() => as('authenticated', '', register), /Authentication required/)
    await assert.rejects(() => as('anon', ids.newUser, () => db.query('select public.can_register_facility()')), /permission denied/)
    await assert.rejects(() => as('anon', ids.newUser, register), /permission denied/)
    checks += 3

    for (const invalid of [
      args.map((v, i) => i === 2 ? 'PLATFORM_ADMIN' : v),
      args.map((v, i) => i === 4 ? 'http://clinic.example/logo.png' : v),
      args.map((v, i) => i === 5 ? '  ' : v),
    ]) await assert.rejects(() => as('authenticated', ids.newUser, () => register(invalid)), /Invalid facility registration details/)
    assert.equal((await rows('select count(*)::int n from public.facilities'))[0].n, 1)
    checks += 4

    // A late audit insert failure must roll every preceding write back.
    await db.exec(`create function public.fail_registration_history() returns trigger
      language plpgsql as $$ begin raise exception 'forced history failure'; end $$;
      create trigger fail_registration_history before insert on public.facility_history
      for each row execute function public.fail_registration_history();`)
    await assert.rejects(() => as('authenticated', ids.newUser, register), /forced history failure/)
    await db.exec('drop trigger fail_registration_history on public.facility_history; drop function public.fail_registration_history();')
    const rolledBack = (await rows(`select
      (select count(*)::int from public.facilities) facilities,
      (select count(*)::int from public.profiles where id='${ids.newUser}') profiles,
      (select count(*)::int from public.facility_licenses) licenses,
      (select count(*)::int from public.facility_history) facility_events,
      (select count(*)::int from public.facility_license_history) license_events`))[0]
    assert.deepEqual(rolledBack, { facilities: 1, profiles: 0, licenses: 0, facility_events: 0, license_events: 0 })
    assert.equal((await as('authenticated', ids.newUser, () => rows('select public.can_register_facility() allowed')))[0].allowed, true)
    checks += 2

    const facilityId = (await as('authenticated', ids.newUser, register)).rows[0].id
    assert.ok(facilityId)
    assert.deepEqual((await rows(`select name,facility_type,address,latitude,longitude,image_url,verification_status,operational_status
      from public.facilities where id=$1`, [facilityId]))[0], {
      name: 'New Clinic', facility_type: 'CLINIC', address: '123 Health Road', latitude: null, longitude: null,
      image_url: 'https://clinic.example/logo.png', verification_status: 'UNVERIFIED', operational_status: 'ACTIVE',
    })
    assert.deepEqual((await rows('select facility_id,full_name,role,account_status from public.profiles where id=$1', [ids.newUser]))[0], {
      facility_id: facilityId, full_name: 'Alex Admin', role: 'FACILITY_ADMIN', account_status: 'ACTIVE',
    })
    assert.deepEqual((await rows('select facility_id,license_number,license_authority,license_expiry_date::text,submitted_by from public.facility_licenses'))[0], {
      facility_id: facilityId, license_number: 'LIC-NEW-001', license_authority: 'Health Authority',
      license_expiry_date: '2099-12-31', submitted_by: ids.newUser,
    })
    assert.deepEqual(await rows("select action,before_profile,after_profile->>'verification_status' status from public.facility_history"),
      [{ action: 'OWNER_SUBMISSION', before_profile: null, status: 'UNVERIFIED' }])
    assert.deepEqual(await rows("select before_license,after_license->>'license_number' license from public.facility_license_history"),
      [{ before_license: null, license: 'LIC-NEW-001' }])
    const ownLicence = await as('authenticated', ids.newUser,
      () => rows('select license_number from public.facility_licenses where facility_id=$1', [facilityId]))
    const otherLicence = await as('authenticated', ids.active,
      () => rows('select license_number from public.facility_licenses where facility_id=$1', [facilityId]))
    assert.deepEqual(ownLicence, [{ license_number: 'LIC-NEW-001' }])
    assert.deepEqual(otherLicence, [], 'another facility admin cannot read this licence')
    const ownHistory = await as('authenticated', ids.newUser,
      () => rows('select action from public.facility_history where facility_id=$1', [facilityId]))
    const otherHistory = await as('authenticated', ids.active,
      () => rows('select action from public.facility_history where facility_id=$1', [facilityId]))
    assert.deepEqual(ownHistory, [{ action: 'OWNER_SUBMISSION' }])
    assert.deepEqual(otherHistory, [], 'another facility admin cannot read this audit history')
    checks += 9

    await assert.rejects(() => as('authenticated', ids.newUser, register), /Facility registration unavailable/)
    await assert.rejects(() => as('authenticated', ids.inactive, register), /Facility registration unavailable/)
    assert.equal((await rows('select count(*)::int n from public.facilities'))[0].n, 2)
    assert.equal((await as('authenticated', ids.newUser, () => rows('select public.can_register_facility() allowed')))[0].allowed, false)
    checks += 4
    await db.close()
    console.log(`PASS: facility self-registration and eligibility (${checks} checks)`)
  } catch (error) {
    await db.close()
    throw error
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
