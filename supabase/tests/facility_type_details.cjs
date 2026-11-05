// Optional facility descriptions: compatibility, atomicity, audit and privacy.
// Run from the repository root with PGlite available.
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
  'supabase/migrations/20261105203147_facility_profile_photos.sql',
  'supabase/migrations/20261105210000_inventory_medicine_catalogue_entry.sql',
  'supabase/migrations/20261105195544_facility_type_details.sql',
]
const id = {
  owner: '10000000-0000-0000-0000-000000000001', otherOwner: '10000000-0000-0000-0000-000000000002',
  platform: '10000000-0000-0000-0000-000000000003', staff: '10000000-0000-0000-0000-000000000004',
  inactiveOwner: '10000000-0000-0000-0000-000000000009',
  newOwner: '10000000-0000-0000-0000-000000000005', oldRegister: '10000000-0000-0000-0000-000000000006',
  badRegister: '10000000-0000-0000-0000-000000000007', nullRegister: '10000000-0000-0000-0000-000000000008',
  facility: '00000000-0000-0000-0000-000000000001', otherFacility: '00000000-0000-0000-0000-000000000002',
}
async function main() {
  const db = new PGlite(); let checks = 0
  const rows = async (sql, params = []) => (await db.query(sql, params)).rows
  async function getError(fn) { try { await fn() } catch (error) { return error }; assert.fail('Expected rejection') }
  async function as(role, user, fn) {
    await db.exec(`reset role; set role ${role};`)
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user || ''])
    try { return await fn() } finally {
      await db.exec('reset role;')
      await db.query("select set_config('request.jwt.claim.sub','',false)")
    }
  }
  const registerDetails = (user, details) => as('authenticated', user, () => db.query(
    'select public.register_facility_with_details($1,$2,$3,$4,$5,$6,$7,$8,$9) id',
    ['New Admin','Community Pharmacy','PHARMACY','4 Main Road',null,'PRIVATE-REG','Private Authority','2099-12-31',details]))
  const submitDetails = (user, details, name = 'Revised Clinic') => as('authenticated', user, () => db.query(
    'select * from public.submit_facility_profile_with_details($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
    [name,'CLINIC','1 Existing Road',10,20,null,'OWNER-REG','Private Authority','2099-12-31',details]))
  const saveDetails = (user, facility, details, name = 'Admin Hospital') => as('authenticated', user, () => db.query(
    'select public.platform_admin_save_facility_with_details($1,$2,$3,$4,$5,$6,$7,$8,$9) id',
    [facility,name,'HOSPITAL','9 Admin Road',11,21,null,'ACTIVE',details]))
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
    await db.exec(`insert into auth.users(id) values
      ('${id.owner}'),('${id.otherOwner}'),('${id.platform}'),('${id.staff}'),('${id.newOwner}'),('${id.oldRegister}'),('${id.badRegister}'),('${id.nullRegister}'),('${id.inactiveOwner}');
      insert into public.facilities(id,name,facility_type,address) values
        ('${id.facility}','Clinic One','CLINIC','1 Existing Road'),
        ('${id.otherFacility}','Clinic Two','CLINIC','2 Existing Road');
      insert into public.profiles(id,facility_id,full_name,role) values
        ('${id.owner}','${id.facility}','Owner One','FACILITY_ADMIN'),
        ('${id.otherOwner}','${id.otherFacility}','Owner Two','FACILITY_ADMIN'),
        ('${id.platform}',null,'Platform Admin','PLATFORM_ADMIN'),
        ('${id.staff}','${id.facility}','Facility Staff','INVENTORY_MANAGER');
      insert into public.profiles(id,facility_id,full_name,role,account_status)
        values ('${id.inactiveOwner}','${id.otherFacility}','Inactive Owner','FACILITY_ADMIN','INACTIVE');
      insert into public.facility_licenses(facility_id,license_number,license_authority,license_expiry_date,submitted_by)
        values ('${id.facility}','PRIVATE-LICENCE-1','Private Authority','2099-12-31','${id.owner}');
      update public.facilities set facility_type_details='Existing clinic services' where id='${id.facility}';`)

    const functions = await rows(`select p.proname,p.prosecdef,p.proconfig,
      has_function_privilege('anon',p.oid,'EXECUTE') anon_exec,
      has_function_privilege('authenticated',p.oid,'EXECUTE') auth_exec
      from pg_proc p where p.proname in ('register_facility_with_details',
        'submit_facility_profile_with_details','platform_admin_save_facility_with_details')`)
    assert.equal(functions.length, 3)
    for (const fn of functions) {
      assert.equal(fn.prosecdef, true)
      assert.ok(fn.proconfig.includes('search_path=""'))
      assert.equal(fn.anon_exec, false)
      assert.equal(fn.auth_exec, true)
      checks += 4
    }
    await assert.rejects(() => as('anon',id.owner,() => db.query(
      'select public.register_facility_with_details($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      ['A','B','PHARMACY','C',null,'L','A','2099-12-31',null])), /permission denied/)
    const beforeDenied = await rows(`select (select count(*)::int from public.facilities) facilities,
      (select count(*)::int from public.facility_history) history,
      (select name from public.facilities where id=$1) name`,[id.facility])
    const knownFacilityError = await getError(() => saveDetails(id.owner,id.facility,'No privilege'))
    const unknownFacilityError = await getError(() => saveDetails(id.owner,'00000000-0000-0000-0000-000000000099','No privilege'))
    assert.match(knownFacilityError.message,/Platform administrator access required/)
    assert.equal(knownFacilityError.message,unknownFacilityError.message,
      'unauthorized platform callers cannot distinguish existing from unknown facility IDs')
    await assert.rejects(() => submitDetails(id.staff,'Wrong role'), /Facility administrator access required/)
    await assert.rejects(() => submitDetails(id.inactiveOwner,'Inactive role'), /Facility administrator access required/)
    assert.deepEqual(await rows(`select (select count(*)::int from public.facilities) facilities,
      (select count(*)::int from public.facility_history) history,
      (select name from public.facilities where id=$1) name`,[id.facility]),beforeDenied,
      'unauthorized wrapper calls do not change facility or history data')
    const functionDefs = await rows(`select p.proname,pg_get_functiondef(p.oid) definition from pg_proc p
      where p.proname in ('submit_facility_profile_with_details','platform_admin_save_facility_with_details')`)
    const ownerDef=functionDefs.find(f=>f.proname==='submit_facility_profile_with_details').definition.toLowerCase()
    const platformDef=functionDefs.find(f=>f.proname==='platform_admin_save_facility_with_details').definition.toLowerCase()
    assert.ok(ownerDef.indexOf("p.account_status='active'") < ownerDef.indexOf('for update'),
      'active facility-admin authorization precedes owner row lock')
    assert.ok(platformDef.indexOf('if not public.is_platform_admin()') < platformDef.indexOf('for update'),
      'platform authorization precedes any caller-supplied facility row lock')
    checks += 9

    const created = (await registerDetails(id.newOwner,'Dispensing and wholesale')).rows[0].id
    assert.ok(created)
    assert.equal((await rows('select facility_type_details from public.facilities where id=$1',[created]))[0].facility_type_details,
      'Dispensing and wholesale')
    const registeredAudit = (await rows(`select before_profile,after_profile->>'facility_type_details' after_details
      from public.facility_history where facility_id=$1`,[created]))[0]
    assert.equal(registeredAudit.before_profile,null)
    assert.equal(registeredAudit.after_details,'Dispensing and wholesale')
    checks += 3

    const nullRegistration = (await registerDetails(id.nullRegister,null)).rows[0].id
    const nullRegistrationAudit = (await rows(`select after_profile ? 'facility_type_details' has_details,
      after_profile->>'facility_type_details' details from public.facility_history where facility_id=$1`,[nullRegistration]))[0]
    assert.deepEqual(nullRegistrationAudit,{has_details:true,details:null})
    checks += 2

    const submission = (await submitDetails(id.owner,'Primary care and dental')).rows[0]
    assert.equal(submission.facility_id,id.facility)
    assert.equal(submission.verification_status,'UNVERIFIED')
    assert.equal(submission.updated_at.getTime(),(await rows('select updated_at from public.facilities where id=$1',[id.facility]))[0].updated_at.getTime())
    assert.equal((await rows('select facility_type_details from public.facilities where id=$1',[id.facility]))[0].facility_type_details,
      'Primary care and dental')
    const ownerAudit = (await rows(`select before_profile->>'facility_type_details' before_details,
      after_profile->>'facility_type_details' after_details from public.facility_history
      where facility_id=$1 and action='OWNER_SUBMISSION' order by created_at desc limit 1`,[id.facility]))[0]
    assert.deepEqual(ownerAudit,{before_details:'Existing clinic services',after_details:'Primary care and dental'})
    checks += 5

    const updated = (await saveDetails(id.platform,id.facility,'Emergency and maternity')).rows[0].id
    assert.equal(updated,id.facility)
    const adminAudit = (await rows(`select before_profile->>'facility_type_details' before_details,
      after_profile->>'facility_type_details' after_details from public.facility_history
      where facility_id=$1 and actor_id=$2 order by created_at desc limit 1`,[id.facility,id.platform]))[0]
    assert.deepEqual(adminAudit,{before_details:'Primary care and dental',after_details:'Emergency and maternity'})
    checks += 2

    await submitDetails(id.owner,null,'Cleared Clinic')
    assert.equal((await rows('select facility_type_details from public.facilities where id=$1',[id.facility]))[0].facility_type_details,null)
    const ownerNullAudit=(await rows(`select after_profile ? 'facility_type_details' has_details,
      after_profile->>'facility_type_details' details from public.facility_history
      where facility_id=$1 and actor_id=$2 and after_profile->>'name'='Cleared Clinic'`,[id.facility,id.owner]))[0]
    assert.deepEqual(ownerNullAudit,{has_details:true,details:null})
    checks += 2

    // Null and blank clear the optional value; existing RPCs remain callable.
    await saveDetails(id.platform,id.facility,null)
    assert.equal((await rows('select facility_type_details from public.facilities where id=$1',[id.facility]))[0].facility_type_details,null)
    const platformNullAudit = (await rows(`select after_profile ? 'facility_type_details' has_details,
      after_profile->>'facility_type_details' details from public.facility_history
      where facility_id=$1 and actor_id=$2 order by created_at desc limit 1`,[id.facility,id.platform]))[0]
    assert.deepEqual(platformNullAudit,{has_details:true,details:null})
    await submitDetails(id.owner,'Retain this detail')
    await as('authenticated',id.owner,() => db.query(
      'select * from public.submit_facility_profile($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      ['Compatibility Submit','CLINIC','1 Existing Road',10,20,null,'OLD-SUBMIT','Authority','2099-12-31']))
    assert.equal((await rows('select facility_type_details from public.facilities where id=$1',[id.facility]))[0].facility_type_details,
      'Retain this detail')
    await as('authenticated',id.platform,() => db.query(
      'select public.platform_admin_save_facility($1,$2,$3,$4,$5,$6,$7,$8)',
      [id.facility,'Compatibility Hospital','HOSPITAL','9 Admin Road',11,21,null,'ACTIVE']))
    assert.equal((await rows('select facility_type_details from public.facilities where id=$1',[id.facility]))[0].facility_type_details,
      'Retain this detail')
    await as('authenticated',id.oldRegister,() => db.query(
      'select public.register_facility($1,$2,$3,$4,$5,$6,$7,$8)',
      ['Legacy Admin','Legacy Clinic','CLINIC','5 Old Road',null,'LEGACY-LIC','Authority','2099-12-31']))
    assert.equal((await rows("select facility_type_details from public.facilities where name='Legacy Clinic'"))[0].facility_type_details,null)
    checks += 4

    const beforeCounts = (await rows(`select (select count(*)::int from public.facilities) facilities,
      (select count(*)::int from public.facility_history) history,
      (select name from public.facilities where id=$1) name,
      (select facility_type_details from public.facilities where id=$1) details`,[id.facility]))[0]
    await assert.rejects(() => submitDetails(id.owner,'x'.repeat(1001)),/Invalid facility type details/)
    await assert.rejects(() => saveDetails(id.platform,null,'x'.repeat(1001)),/Invalid facility type details/)
    await assert.rejects(() => registerDetails(id.badRegister,'x'.repeat(1001)),/Invalid facility type details/)
    await assert.rejects(() => submitDetails(id.owner,'Valid text',''))
    const afterCounts = (await rows(`select (select count(*)::int from public.facilities) facilities,
      (select count(*)::int from public.facility_history) history,
      (select name from public.facilities where id=$1) name,
      (select facility_type_details from public.facilities where id=$1) details`,[id.facility]))[0]
    assert.deepEqual(afterCounts,beforeCounts,'errors roll back profile, details, and audit writes')
    checks += 5

    await saveDetails(id.platform,id.facility,'  ')
    assert.equal((await rows('select facility_type_details from public.facilities where id=$1',[id.facility]))[0].facility_type_details,null)
    const blankAudit = (await rows(`select after_profile ? 'facility_type_details' has_details,
      after_profile->>'facility_type_details' details from public.facility_history
      where facility_id=$1 and actor_id=$2 order by created_at desc limit 1`,[id.facility,id.platform]))[0]
    assert.deepEqual(blankAudit,{has_details:true,details:null})
    await saveDetails(id.platform,id.facility,'x'.repeat(1000))
    assert.equal((await rows('select length(facility_type_details)::int n from public.facilities where id=$1',[id.facility]))[0].n,1000)
    await assert.rejects(() => saveDetails(id.platform,id.facility,'x'.repeat(1001)),/Invalid facility type details/)
    await saveDetails(id.platform,id.facility,'Maternity services')
    checks += 4

    const directory = await as('authenticated',id.otherOwner,() => rows(
      'select * from public.facility_directory where id=$1',[id.facility]))
    assert.equal(directory.length,1)
    assert.equal(directory[0].facility_type_details,'Maternity services')
    assert.deepEqual(Object.keys(directory[0]),['id','name','facility_type','address','latitude','longitude','image_url',
      'verification_status','verification_valid_until','operational_status','created_at','updated_at','facility_type_details'])
    assert.equal(JSON.stringify(directory[0]).includes('PRIVATE-LICENCE'),false)
    assert.deepEqual(await as('authenticated',id.otherOwner,() => rows(
      'select license_number from public.facility_licenses where facility_id=$1',[id.facility])),[])
    await assert.rejects(() => as('anon',id.otherOwner,() => rows('select * from public.facility_directory')),
      /permission denied/)
    checks += 5

    await db.close()
    console.log(`PASS: facility type details RPCs, compatibility, audit, rollback, authorization, privacy (${checks} checks)`)
  } catch (error) {
    await db.close()
    throw error
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
