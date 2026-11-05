// Facility ownership, private licensing, review, history and expiry tests.
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
]
const id = {
  f1: '00000000-0000-0000-0000-000000000001', f2: '00000000-0000-0000-0000-000000000002',
  owner1: '10000000-0000-0000-0000-000000000001', owner2: '10000000-0000-0000-0000-000000000002',
  platform: '10000000-0000-0000-0000-000000000003', staff: '10000000-0000-0000-0000-000000000004',
  medicine: '20000000-0000-0000-0000-000000000001', batch: '30000000-0000-0000-0000-000000000001',
}
async function main() {
  const db = new PGlite(); let checks = 0
  const rows = async (sql, params=[]) => (await db.query(sql, params)).rows
  async function asUser(user, fn) {
    await db.exec('reset role; set role authenticated;')
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user])
    try { return await fn() } finally { await db.exec('reset role;'); await db.query("select set_config('request.jwt.claim.sub','',false)") }
  }
  async function denied(user, fn, label) { await assert.rejects(()=>asUser(user,fn),undefined,label); checks++ }
  const submit=(name='Clinic One', image='https://clinic.example/logo.png', expiry='2099-12-31', type='CLINIC')=>
    db.query('select * from public.submit_facility_profile($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [name,type,'1 Main St',10,20,image,'LIC-001','Health Authority',expiry])
  const save=(facility,name='Clinic One',type='CLINIC',address='1 Main St',image='https://clinic.example/logo.png',status='ACTIVE',lat=10,lon=20)=>
    db.query('select public.platform_admin_save_facility($1,$2,$3,$4,$5,$6,$7,$8) as id',
      [facility,name,type,address,lat,lon,image,status])
  const matches=()=>db.query('select public.find_medicine_matches($1,$2,$3) as result',[id.f2,id.medicine,1])
  const review=(facility,decision='VERIFIED',notes='Matched licence against regulator register, reference REG-42')=>
    db.query('select public.review_facility_verification($1,$2,$3) as id',[facility,decision,notes])
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
    for (const m of migrations) await db.exec(fs.readFileSync(path.join(root,m),'utf8'))
    checks += 3
    await db.exec(`insert into public.facilities(id,name,facility_type,address) values
      ('${id.f1}','Clinic One','CLINIC','1 Main St'),('${id.f2}','Hospital Two','HOSPITAL','2 Main St');
      insert into auth.users(id) values ('${id.owner1}'),('${id.owner2}'),('${id.platform}'),('${id.staff}');
      insert into public.profiles(id,facility_id,full_name,role) values
      ('${id.owner1}','${id.f1}','Owner One','FACILITY_ADMIN'),
      ('${id.owner2}','${id.f2}','Owner Two','FACILITY_ADMIN'),
      ('${id.platform}',null,'Platform Admin','PLATFORM_ADMIN'),
      ('${id.staff}','${id.f2}','Staff','REQUESTING_STAFF');
      insert into public.medicines(id,name,strength,dosage_form,unit_of_measure) values
        ('${id.medicine}','Test medicine','10 mg','tablet','tablet');
      insert into public.inventory_batches(id,facility_id,medicine_id,batch_number,quantity_on_hand,quantity_reserved,expiry_date) values
        ('${id.batch}','${id.f1}','${id.medicine}','TEST-BATCH',10,0,'2099-12-31');`)
    const signature='public.review_facility_verification(uuid,text,text)'
    const sec=await rows(`select prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') anon_exec,
      has_function_privilege('authenticated',oid,'EXECUTE') auth_exec from pg_proc where oid=$1::regprocedure`,[signature])
    assert.equal(sec[0].prosecdef,true); assert.ok(sec[0].proconfig.includes('search_path=""'))
    assert.equal(sec[0].anon_exec,false); assert.equal(sec[0].auth_exec,true); checks+=4
    const matchSecurity=await rows(`select prosecdef,proconfig,prorettype::regtype::text result_type,
      has_function_privilege('anon',oid,'EXECUTE') anon_exec,
      has_function_privilege('authenticated',oid,'EXECUTE') auth_exec
      from pg_proc where oid=$1::regprocedure`,['public.find_medicine_matches(uuid,uuid,integer)'])
    assert.equal(matchSecurity[0].prosecdef,true); assert.ok(matchSecurity[0].proconfig.includes('search_path=""'))
    assert.equal(matchSecurity[0].result_type,'jsonb'); assert.equal(matchSecurity[0].anon_exec,false)
    assert.equal(matchSecurity[0].auth_exec,true); checks+=5

    await denied(id.staff,()=>submit(),'non-admin staff cannot submit a facility profile')
    const ownerTwoSubmission=await asUser(id.owner2,()=>submit('Hospital Two','https://clinic.example/logo.png','2099-12-31','HOSPITAL'))
    assert.equal(ownerTwoSubmission.rows[0].facility_id,id.f2); checks++
    await denied(id.owner1,()=>save(id.f1),'facility admin cannot call platform facility manager')
    await denied(id.owner1,()=>db.query('update public.facilities set name=$1 where id=$2',['Hacked',id.f1]),
      'direct profile writes are denied')
    await denied(id.owner1,()=>db.query('insert into public.facility_licenses(facility_id,license_number,license_authority,license_expiry_date,submitted_by) values($1,$2,$3,$4,$5)',
      [id.f1,'L','Authority','2099-12-31',id.owner1]),'direct licence writes are denied')
    await denied(id.owner1,()=>review(id.f1),'facility admin cannot approve or review')
    await denied(id.platform,()=>review(id.f1),'verification cannot proceed without a licence submission')
    await denied(id.owner1,()=>db.query('select * from public.submit_facility_profile($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      ['Clinic One','CLINIC','1 Main St',10,20,'https://user:secret@clinic.example/a','LIC-001','Health Authority','2099-12-31']),
      'embedded URL credentials are rejected')

    let result=await asUser(id.owner1,()=>submit())
    assert.equal(result.rows[0].facility_id,id.f1); assert.equal(result.rows[0].verification_status,'UNVERIFIED'); checks+=2
    const privateOwn=await asUser(id.owner1,()=>rows('select license_number,license_expiry_date::text,submitted_by from public.facility_licenses'))
    assert.equal(privateOwn.length,1); assert.equal(privateOwn[0].license_number,'LIC-001'); checks+=2
    const privateOther=await asUser(id.owner2,()=>rows('select facility_id from public.facility_licenses where facility_id=$1',[id.f1]))
    assert.equal(privateOther.length,0); checks++
    const historyOwn=await asUser(id.owner1,()=>rows('select action,after_profile::text from public.facility_history'))
    assert.equal(historyOwn.length,1); assert.equal(historyOwn[0].action,'OWNER_SUBMISSION')
    assert.ok(!historyOwn[0].after_profile.includes('LIC-001'),'public history snapshot excludes licence number'); checks+=3
    const directory=await asUser(id.owner1,()=>rows('select * from public.facility_directory where id=$1',[id.f1]))
    assert.equal(directory[0].verification_status,'UNVERIFIED')
    assert.equal(Object.hasOwn(directory[0],'license_number'),false); checks+=2

    await denied(id.platform,()=>review(id.f1,'VERIFIED','   '),'empty manual review note is rejected')
    const approved=await asUser(id.platform,()=>review(id.f1))
    assert.equal(approved.rows[0].id,id.f1); checks++
    let state=await rows('select verification_status,verification_valid_until::text from public.facilities where id=$1',[id.f1])
    assert.deepEqual(state[0],{verification_status:'VERIFIED',verification_valid_until:'2099-12-31'}); checks++
    const reviewed=await asUser(id.platform,()=>rows('select decision,notes from public.facility_verification_reviews where facility_id=$1',[id.f1]))
    assert.equal(reviewed[0].decision,'VERIFIED'); assert.match(reviewed[0].notes,/REG-42/); checks+=2
    const directoryVerified=await asUser(id.owner2,()=>rows('select verification_status,verification_valid_until::text from public.facility_directory where id=$1',[id.f1]))
    assert.equal(directoryVerified[0].verification_status,'VERIFIED'); checks++
    const matchVerified=await asUser(id.owner2,()=>matches())
    assert.equal(matchVerified.rows[0].result.matches[0].verification_status,'VERIFIED'); checks++

    await db.exec(`update public.facilities set verification_valid_until=current_date-1 where id='${id.f1}'`)
    const expired=await asUser(id.owner2,()=>rows('select verification_status,verification_valid_until<current_date expired from public.facility_directory where id=$1',[id.f1]))
    assert.equal(expired[0].expired,true); assert.equal(expired[0].verification_status,'UNVERIFIED'); checks+=2
    const matchExpired=await asUser(id.owner2,()=>matches())
    assert.equal(matchExpired.rows[0].result.matches[0].verification_status,'UNVERIFIED'); checks++
    await asUser(id.platform,()=>save(id.f1,'Clinic One','CLINIC','1 Main St','https://clinic.example/new.png','ACTIVE'))
    state=await rows('select verification_status,verification_valid_until::text from public.facilities where id=$1',[id.f1])
    assert.equal(state[0].verification_status,'VERIFIED'); assert.ok(state[0].verification_valid_until < new Date().toISOString().slice(0,10))
    checks+=2 // image-only edits preserve stored verification; it remains effectively expired
    await asUser(id.owner1,()=>submit('Clinic One','https://clinic.example/new.png','2000-01-01'))
    state=await rows('select verification_status,verification_valid_until from public.facilities where id=$1',[id.f1])
    assert.equal(state[0].verification_status,'UNVERIFIED'); assert.equal(state[0].verification_valid_until,null); checks+=2
    await denied(id.platform,()=>review(id.f1),'expired licence cannot be approved')
    let privateVersions=await asUser(id.owner1,()=>rows('select before_license,after_license from public.facility_license_history where facility_id=$1',[id.f1]))
    assert.equal(privateVersions.length,2); assert.equal(privateVersions[1].before_license.license_number,'LIC-001'); checks+=2
    const historyOnly=await asUser(id.owner1,()=>rows('select after_profile::text from public.facility_history where facility_id=$1',[id.f1]))
    assert.ok(historyOnly.every(row=>!row.after_profile.includes('LIC-001'))); checks++

    await asUser(id.owner1,()=>submit('Clinic One','https://clinic.example/new.png','2099-12-31'))
    await asUser(id.platform,()=>review(id.f1))
    await asUser(id.platform,()=>save(id.f1,'Clinic Renamed','CLINIC','1 Main St','https://clinic.example/new.png','ACTIVE'))
    state=await rows('select name,verification_status,verification_valid_until from public.facilities where id=$1',[id.f1])
    assert.equal(state[0].name,'Clinic Renamed'); assert.equal(state[0].verification_status,'UNVERIFIED')
    assert.equal(state[0].verification_valid_until,null); checks+=3
    await asUser(id.platform,()=>review(id.f1,'VERIFIED','Rechecked updated clinic identity against current register REF-44'))
    state=await rows('select verification_status from public.facilities where id=$1',[id.f1])
    assert.equal(state[0].verification_status,'VERIFIED'); checks++
    await asUser(id.platform,()=>save(id.f1,'Clinic Renamed','CLINIC','2 Main St','https://clinic.example/new.png'))
    state=await rows('select verification_status from public.facilities where id=$1',[id.f1])
    assert.equal(state[0].verification_status,'UNVERIFIED'); checks++
    await asUser(id.platform,()=>review(id.f1,'VERIFIED','Matched updated address to current authority record REF-45'))
    await asUser(id.platform,()=>save(id.f1,'Clinic Renamed','CLINIC','2 Main St','https://clinic.example/new.png','ACTIVE',11,20))
    state=await rows('select verification_status from public.facilities where id=$1',[id.f1])
    assert.equal(state[0].verification_status,'UNVERIFIED'); checks++
    await asUser(id.platform,()=>review(id.f1,'VERIFIED','Matched updated coordinates to current authority record REF-46'))
    await asUser(id.platform,()=>save(id.f1,'Clinic Renamed','PHARMACY','2 Main St','https://clinic.example/new.png','ACTIVE',11,20))
    state=await rows('select verification_status from public.facilities where id=$1',[id.f1])
    assert.equal(state[0].verification_status,'UNVERIFIED'); checks++
    await asUser(id.platform,()=>review(id.f1,'VERIFIED','Matched updated facility type to current authority record REF-47'))

    await asUser(id.owner1,()=>submit('Clinic Renamed','https://clinic.example/new.png','2099-12-31'))
    await db.query('update public.facility_licenses set submitted_by=$1 where facility_id=$2',[id.platform,id.f1])
    await denied(id.platform,()=>review(id.f1),'submitter cannot review their own licence')
    await db.query('update public.facility_licenses set submitted_by=$1 where facility_id=$2',[id.owner1,id.f1])
    await asUser(id.platform,()=>review(id.f1,'REJECTED','Licence details did not match source record REF-43'))
    state=await rows('select verification_status,verification_valid_until from public.facilities where id=$1',[id.f1])
    assert.equal(state[0].verification_status,'REJECTED'); assert.equal(state[0].verification_valid_until,null); checks+=2
    const rejected=await asUser(id.owner1,()=>rows('select decision,notes from public.facility_verification_reviews where facility_id=$1 order by created_at',[id.f1]))
    assert.equal(rejected.at(-1).decision,'REJECTED'); assert.match(rejected.at(-1).notes,/REF-43/); checks+=2
    await denied(id.owner1,()=>db.query('insert into public.facility_verification_reviews(facility_id,reviewer_id,decision,notes) values($1,$2,$3,$4)',
      [id.f1,id.owner1,'VERIFIED','forged']),'review records cannot be directly inserted')

    const created=await asUser(id.platform,()=>save(null,'New Pharmacy','PHARMACY','3 Main St','https://pharmacy.example/logo.png','ACTIVE'))
    const newId=created.rows[0].id
    const createdRow=await rows('select facility_type,verification_status from public.facilities where id=$1',[newId])
    assert.deepEqual(createdRow[0],{facility_type:'PHARMACY',verification_status:'UNVERIFIED'}); checks+=2
    const createHistory=await asUser(id.platform,()=>rows('select action from public.facility_history where facility_id=$1',[newId]))
    assert.equal(createHistory[0].action,'PLATFORM_ADMIN_CREATE'); checks++
    await db.query(
      `insert into public.supply_requests(id,requesting_facility_id,supplying_facility_id,medicine_id,requested_quantity,approved_quantity,status,created_by) values
        ('40000000-0000-0000-0000-000000000001',$1,$2,$3,1,null,'PENDING',$4),
        ('40000000-0000-0000-0000-000000000002',$1,$2,$3,1,1,'APPROVED',$4)`,
      [newId,id.f2,id.medicine,id.owner1])
    await denied(id.platform,()=>save(newId,'New Pharmacy','PHARMACY','3 Main St','https://pharmacy.example/logo.png','INACTIVE'),
      'facility with pending or approved requests cannot be deactivated')
    const stillActive=await rows('select operational_status from public.facilities where id=$1',[newId])
    assert.equal(stillActive[0].operational_status,'ACTIVE'); checks++
    await db.query("update public.supply_requests set status='CANCELLED' where requesting_facility_id=$1",[newId])
    await asUser(id.platform,()=>save(newId,'New Pharmacy','PHARMACY','3 Main St','https://pharmacy.example/logo.png','INACTIVE'))
    const inactive=await asUser(id.platform,()=>rows('select operational_status from public.facility_directory where id=$1',[newId]))
    assert.equal(inactive[0].operational_status,'INACTIVE'); checks++
    const hidden=await asUser(id.owner1,()=>rows('select id from public.facility_directory where id=$1',[newId]))
    assert.equal(hidden.length,0); checks++
    await asUser(id.platform,()=>save(newId,'New Pharmacy','PHARMACY','3 Main St','https://pharmacy.example/logo.png','ACTIVE'))
    const facilityActions=await asUser(id.platform,()=>rows('select action from public.facility_history where facility_id=$1 order by created_at',[newId]))
    assert.deepEqual(facilityActions.map(r=>r.action),['PLATFORM_ADMIN_CREATE','DEACTIVATED','REACTIVATED']); checks++
    const adminLicences=await asUser(id.platform,()=>rows('select facility_id from public.facility_licenses'))
    assert.equal(adminLicences.length,2); checks++
    const isolatedReview=await asUser(id.owner2,()=>rows('select facility_id from public.facility_verification_reviews where facility_id=$1',[id.f1]))
    assert.equal(isolatedReview.length,0); checks++
    await denied(id.owner1,()=>db.query('update public.facility_history set notes=$1 where facility_id=$2',['tampered',id.f1]),
      'audit history is immutable to clients')
    await db.exec('reset role; set role anon;')
    await assert.rejects(()=>db.query('select * from public.facility_directory')); checks++
    await db.exec('reset role;')
    await db.close()
    console.log(`PASS: facility ownership, private licensing, audit, admin lifecycle, review controls, and expiry masking (${checks} checks)`)
  } catch (error) {
    await db.close(); throw error
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
