// Local-only PGlite regression test for fictional hospitals and simulated inventory.
// Run from the repository root: node supabase/tests/local_demo_hospitals.cjs
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = process.cwd()
const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).sort()
  .filter(name => !/20261105063923_demo_facility_accounts|20261105064746_demo_inventory|20261105161317_demo_platform_admin|20261105072426_demo_coordinates/.test(name))
  .map(name => `supabase/migrations/${name}`)
const seedPath = 'supabase/local-seeds/20261105230000_20_demo_hospitals.sql'
const id = {
  admin:'10000000-0000-0000-0000-000000000001', clinicUser:'10000000-0000-0000-0000-000000000002',
  pharmacyUser:'10000000-0000-0000-0000-000000000003', unrelatedUser:'10000000-0000-0000-0000-000000000004',
  clinic:'7da05698-b748-4e79-b99e-3abcbdcb1001', pharmacy:'7da05698-b748-4e79-b99e-3abcbdcb1002',
  unrelatedFacility:'7da05698-b748-4e79-b99e-3abcbdcb1003', para:'9ee2a001-c270-4eca-8c10-f7df1c110001',
  amox:'9ee2a001-c270-4eca-8c10-f7df1c110002', unrelatedMedicine:'9ee2a001-c270-4eca-8c10-f7df1c110003',
  noStockMedicine:'9ee2a001-c270-4eca-8c10-f7df1c110004',
  facilityPrefix:'b9f45f20-a061-4fe1-9b34-', batchPrefix:'a9f45f20-a061-4fe1-9b34-',
  movementPrefix:'c9f45f20-a061-4fe1-9b34-', priorBatch:'70000000-0000-0000-0000-000000000001',
  priorMovement:'80000000-0000-0000-0000-000000000001',
}
const makeId = (prefix,n) => `${prefix}${String(n).padStart(12,'0')}`
const addedMedicines = Array.from({length:7},(_,i)=>`9ee2a002-c270-4eca-8c10-f7df1c11${String(i+1).padStart(4,'0')}`)

async function main() {
  const db = new PGlite()
  let checks = 0
  const rows = async (sql,params=[]) => (await db.query(sql,params)).rows
  async function asUser(user,fn) {
    await db.exec('reset role; set role authenticated;')
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user])
    try { return await fn() } finally {
      await db.exec('reset role;')
      await db.query("select set_config('request.jwt.claim.sub','',false)")
    }
  }
  const match = (medicine,quantity) => db.query('select public.find_medicine_matches($1,$2,$3) as result',[id.clinic,medicine,quantity])
  const snapshotFacilities = () => rows(`select * from public.facilities where id=any($1::uuid[]) order by id`,
    [[id.clinic,id.pharmacy,id.unrelatedFacility]])
  const snapshotMeds = () => rows(`select * from public.medicines where id=any($1::uuid[]) order by id`,[[id.para,id.amox,id.unrelatedMedicine,id.noStockMedicine]])
  const snapshotBatch = () => rows(`select * from public.inventory_batches where id=$1`,[id.priorBatch])
  const snapshotMovement = () => rows(`select * from public.stock_movements where id=$1`,[id.priorMovement])
  const snapshotProfiles = () => rows(`select * from public.profiles order by id`)
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz);
      create function auth.uid() returns uuid language sql stable as
        $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,
        file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key,bucket_id text not null references storage.buckets(id),
        name text not null,created_at timestamptz default now(),unique(bucket_id,name));
      alter table storage.objects enable row level security;`)
    for (const file of migrations) {
      const filename=path.join(root,file)
      assert.ok(fs.existsSync(filename),`Missing schema migration: ${filename}`)
      await db.exec(fs.readFileSync(filename,'utf8')); checks++
    }
    await db.exec(`insert into public.facilities(id,name,facility_type,address,latitude,longitude,verification_status) values
      ('${id.clinic}','MediNexus Demo Clinic','CLINIC','Fictional Demo Road (pre-existing)',null,null,'UNVERIFIED'),
      ('${id.pharmacy}','MediNexus Demo Pharmacy','PHARMACY','Fictional Sample Street (pre-existing)',null,null,'UNVERIFIED'),
      ('${id.unrelatedFacility}','Unrelated Existing Pharmacy','PHARMACY','Unrelated Fictional Address',null,null,'UNVERIFIED');
      insert into auth.users(id,email,email_confirmed_at) values
      ('${id.admin}','admin@medinexus.example',now()),('${id.clinicUser}','clinic@medinexus.example',now()),
      ('${id.pharmacyUser}','supplier@medinexus.example',now()),('${id.unrelatedUser}','unrelated@medinexus.example',now());
      insert into public.profiles(id,facility_id,full_name,role) values
      ('${id.admin}',null,'Existing Platform Admin','PLATFORM_ADMIN'),
      ('${id.clinicUser}','${id.clinic}','Existing Demo Clinic Admin','FACILITY_ADMIN'),
      ('${id.pharmacyUser}','${id.pharmacy}','Existing Demo Pharmacy Admin','FACILITY_ADMIN'),
      ('${id.unrelatedUser}','${id.unrelatedFacility}','Existing Unrelated Pharmacy Admin','FACILITY_ADMIN');
      insert into public.medicines(id,name,generic_name,active_ingredient,strength,dosage_form,unit_of_measure) values
      ('${id.para}','Paracetamol','Paracetamol','Paracetamol','500 mg','tablet','tablet'),
      ('${id.amox}','Amoxicillin','Amoxicillin','Amoxicillin','250 mg','capsule','capsule'),
      ('${id.unrelatedMedicine}','Pre-existing unrelated medicine','Unrelated','Unrelated','1 mg','solution','ml'),
      ('${id.noStockMedicine}','Existing unstocked medicine','Unstocked','Unstocked','1 mg','solution','ml');
      insert into public.inventory_batches(id,facility_id,medicine_id,batch_number,quantity_on_hand,quantity_reserved,
        low_stock_threshold,expiry_date,last_updated_at) values
      ('${id.priorBatch}','${id.unrelatedFacility}','${id.unrelatedMedicine}','PREEXISTING-DO-NOT-TOUCH',19,0,5,current_date+100,now());
      insert into public.stock_movements(id,facility_id,inventory_batch_id,medicine_id,movement_type,quantity,performed_by,notes) values
      ('${id.priorMovement}','${id.unrelatedFacility}','${id.priorBatch}','${id.unrelatedMedicine}','INITIAL_STOCK',19,'${id.unrelatedUser}','pre-existing audit');`)
    const beforeFacilities=await snapshotFacilities(), beforeMeds=await snapshotMeds()
    const beforeBatch=await snapshotBatch(), beforeMovement=await snapshotMovement(), beforeProfiles=await snapshotProfiles()
    const seedSql=fs.readFileSync(path.join(root,seedPath),'utf8')
    await assert.rejects(()=>db.exec(seedSql),/Demo seed blocked/); checks++
    await db.exec('rollback')
    assert.deepEqual(await rows('select count(*)::int n from public.facilities'),[{n:3}]); checks++
    await db.exec("set medinexus.demo_seed = 'enabled'")
    await db.exec("set session_replication_role = 'replica'")
    await db.query("update public.facilities set name='Wrong Project Facility' where id=$1",[id.clinic])
    await assert.rejects(()=>db.exec(seedSql),/Wrong database: known MediNexus demo clinic/); checks++
    await db.exec('rollback')
    await db.query("update public.facilities set name='MediNexus Demo Clinic' where id=$1",[id.clinic])
    await db.query("update public.medicines set name='Wrong Project Catalogue' where id=$1",[id.para])
    await assert.rejects(()=>db.exec(seedSql),/Wrong database: known MediNexus demo catalogue IDs/)
    await db.exec('rollback')
    await db.query("update public.medicines set name='Paracetamol' where id=$1",[id.para])
    await db.exec("set session_replication_role = 'origin'")
    await db.exec(seedSql)
    const seededFacilities=await rows(`select id::text,name,facility_type,address,latitude,longitude,verification_status,operational_status
      from public.facilities where id::text like $1 order by id`,[`${id.facilityPrefix}%`])
    assert.equal(seededFacilities.length,20)
    for(let i=1;i<=20;i++) {
      const f=seededFacilities[i-1], suffix=String(i).padStart(2,'0')
      assert.equal(f.id,makeId(id.facilityPrefix,i))
      assert.equal(f.name,`MediNexus Demo/Fictional Hospital ${suffix}`)
      assert.equal(f.facility_type,'HOSPITAL')
      assert.equal(f.address,`Fictional placeholder address ${suffix} (no real location)`)
      assert.equal(f.latitude,null); assert.equal(f.longitude,null)
      assert.equal(f.verification_status,'UNVERIFIED'); assert.equal(f.operational_status,'ACTIVE'); checks+=8
    }
    assert.deepEqual(await rows('select count(*)::int n from public.medicines where id::text like $1',[`9ee2a002-c270-4eca-8c10-f7df1c11%`]),[{n:7}]); checks++
    const newCatalog=await rows(`select name,strength,dosage_form,unit_of_measure from public.medicines where id::text like $1 order by id`,[`9ee2a002-c270-4eca-8c10-f7df1c11%`])
    assert.deepEqual(newCatalog,[
      {name:'Paracetamol',strength:'1 g',dosage_form:'tablet',unit_of_measure:'tablet'},
      {name:'Amoxicillin',strength:'500 mg',dosage_form:'capsule',unit_of_measure:'capsule'},
      {name:'Ibuprofen',strength:'200 mg',dosage_form:'tablet',unit_of_measure:'tablet'},
      {name:'Oral Rehydration Salts',strength:'20.5 g',dosage_form:'powder sachet',unit_of_measure:'sachet'},
      {name:'Cetirizine',strength:'10 mg',dosage_form:'tablet',unit_of_measure:'tablet'},
      {name:'Metformin',strength:'500 mg',dosage_form:'tablet',unit_of_measure:'tablet'},
      {name:'Omeprazole',strength:'20 mg',dosage_form:'capsule',unit_of_measure:'capsule'},
    ]); checks++
    assert.deepEqual(await rows('select count(*)::int n from public.inventory_batches where id::text like $1',[`${id.batchPrefix}%`]),[{n:82}]); checks++
    assert.deepEqual(await rows('select count(*)::int n from public.stock_movements where id::text like $1',[`${id.movementPrefix}%`]),[{n:82}]); checks++
    assert.deepEqual(await rows(`select count(*)::int n from public.inventory_batches where id::text like $1 and quantity_reserved<>0`,[`${id.batchPrefix}%`]),[{n:0}]); checks++
    assert.deepEqual(await rows(`select count(*)::int n from public.profiles where facility_id::text like $1`,[`${id.facilityPrefix}%`]),[{n:0}]); checks++
    assert.deepEqual(await rows(`select count(*)::int n from public.supply_requests r join public.facilities f
      on f.id=r.requesting_facility_id or f.id=r.supplying_facility_id where f.id::text like $1`,[`${id.facilityPrefix}%`]),[{n:0}]); checks++
    assert.deepEqual(await rows(`select count(*)::int n from public.request_reservations r join public.inventory_batches b
      on b.id=r.inventory_batch_id where b.id::text like $1`,[`${id.batchPrefix}%`]),[{n:0}]); checks++

    const movements=await rows(`select b.quantity_on_hand,m.movement_type,m.quantity,m.notes,m.performed_by::text,p.role
      from public.inventory_batches b join public.stock_movements m on m.inventory_batch_id=b.id
      join public.profiles p on p.id=m.performed_by where b.id::text like $1 order by b.id`,[`${id.batchPrefix}%`])
    assert.equal(movements.length,82)
    for(const m of movements) {
      assert.equal(m.movement_type,'INITIAL_STOCK'); assert.equal(m.quantity,m.quantity_on_hand)
      assert.equal(m.role,'PLATFORM_ADMIN'); assert.equal(m.performed_by,id.admin)
      assert.match(m.notes,/DEMO PROJECT ONLY; SIMULATED stock; fictional, unverified/); checks+=5
    }
    assert.deepEqual(await snapshotFacilities(),beforeFacilities)
    assert.deepEqual(await snapshotMeds(),beforeMeds)
    assert.deepEqual(await snapshotBatch(),beforeBatch)
    assert.deepEqual(await snapshotMovement(),beforeMovement)
    assert.deepEqual(await snapshotProfiles(),beforeProfiles); checks+=5

    const seededSnapshot=async()=>({
      facilities:await rows('select * from public.facilities where id::text like $1 order by id',[`${id.facilityPrefix}%`]),
      medicines:await rows('select * from public.medicines where id::text like $1 order by id',['9ee2a002-c270-4eca-8c10-f7df1c11%']),
      batches:await rows('select * from public.inventory_batches where id::text like $1 order by id',[`${id.batchPrefix}%`]),
      movements:await rows('select * from public.stock_movements where id::text like $1 order by id',[`${id.movementPrefix}%`]),
    })
    const firstRun=await seededSnapshot()
    await db.exec(seedSql)
    assert.deepEqual(await seededSnapshot(),firstRun); checks++

    const p=(await asUser(id.clinicUser,()=>match(id.para,10))).rows[0].result
    const item=(result,n)=>result.find(x=>x.facility_id===makeId(id.facilityPrefix,n))
    assert.equal(item(p.matches,1).available_quantity,120)
    assert.equal(item(p.matches,8).available_quantity,14) // two batches aggregate; reservations are zero
    assert.equal(item(p.matches,7).stale,true)
    assert.equal(item(p.insufficient,3).available_quantity,8)
    assert.equal(item(p.insufficient,4).available_quantity,4)
    assert.ok(![6,16].some(n=>item([...p.matches,...p.insufficient],n))) // expired stock is excluded
    assert.ok(![...p.matches,...p.insufficient].some(x=>x.verification_status!=='UNVERIFIED'))
    checks+=7
    const para1g='9ee2a002-c270-4eca-8c10-f7df1c110001'
    const p1=(await asUser(id.clinicUser,()=>match(para1g,20))).rows[0].result
    assert.equal(item(p1.matches,1).available_quantity,24)
    assert.equal(item(p.matches,1).available_quantity,120)
    assert.equal(p1.matches[0].unit_of_measure,'tablet'); checks+=3
    const amox500='9ee2a002-c270-4eca-8c10-f7df1c110002'
    const a=(await asUser(id.clinicUser,()=>match(amox500,10))).rows[0].result
    assert.equal(item(a.matches,10).available_quantity,32)
    assert.equal(a.medicine_id,amox500); checks+=2
    const noFull=(await asUser(id.clinicUser,()=>match(id.para,1000))).rows[0].result
    assert.equal(noFull.matches.length,0); assert.ok(noFull.insufficient.length>0); checks+=2
    const empty=(await asUser(id.clinicUser,()=>match(id.noStockMedicine,1))).rows[0].result
    assert.deepEqual(empty.matches,[]); assert.deepEqual(empty.insufficient,[]); checks+=2
    assert.ok((await rows(`select count(*)::int n from public.inventory_batches where id::text like $1 and expiry_date<current_date`,[`${id.batchPrefix}%`]))[0].n>=8)
    assert.ok((await rows(`select count(*)::int n from public.inventory_batches where id::text like $1 and expiry_date between current_date and current_date+30`,[`${id.batchPrefix}%`]))[0].n>=8)
    assert.ok((await rows(`select count(*)::int n from public.inventory_batches where id::text like $1 and last_updated_at<=now()-interval '168 hours'`,[`${id.batchPrefix}%`]))[0].n>=8)
    assert.ok((await rows(`select count(*)::int n from public.inventory_batches where id::text like $1 and quantity_on_hand<=low_stock_threshold`,[`${id.batchPrefix}%`]))[0].n>=8)
    checks+=4
    console.log(`PASS local demo seed: ${checks} assertions; 20 fictional hospitals, 7 additional formulations, 82 batches and movements; seed applied twice.`)
  } finally { await db.close() }
}
main().catch(error=>{console.error(error);process.exitCode=1})
