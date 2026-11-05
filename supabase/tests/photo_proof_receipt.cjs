// PGlite integration/security tests for private proof photos and receipt.
// NODE_PATH="$HYPER_SCRATCH_DIR/node_modules" node supabase/tests/photo_proof_receipt.cjs
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = process.cwd()
const files = ['20261105060039_initial_schema.sql', '20261105061109_transactional_operations.sql', '20261105065507_inventory_metadata.sql', '20261105072638_medicine_matching.sql', '20261105121023_photo_proof_receipt.sql']
const u = {
  clinic:'00000000-0000-0000-0000-000000000001', pharmacy:'00000000-0000-0000-0000-000000000002', other:'00000000-0000-0000-0000-000000000003', med:'20000000-0000-0000-0000-000000000001',
  ca:'10000000-0000-0000-0000-000000000001', cs:'10000000-0000-0000-0000-000000000002', sa:'10000000-0000-0000-0000-000000000003', ss:'10000000-0000-0000-0000-000000000004', os:'10000000-0000-0000-0000-000000000005', inactive:'10000000-0000-0000-0000-000000000006',
  photo:'30000000-0000-0000-0000-000000000001', photo2:'30000000-0000-0000-0000-000000000002', photo3:'30000000-0000-0000-0000-000000000003',
}
async function main() {
  const db = new PGlite(); let checks=0
  const rows=async(sql,p=[]) => (await db.query(sql,p)).rows
  async function as(id,fn) {
    await db.exec('reset role; set role authenticated')
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id])
    try { return await fn() } finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)") }
  }
  const rpc=(id,sql,p=[])=>as(id,async()=>(await db.query(sql,p)).rows[0]?.id)
  async function reject(id,sql,p=[],msg='Expected rejection') { await assert.rejects(()=>rpc(id,sql,p),undefined,msg); checks++ }
  const count=(id,sql,p=[])=>as(id,async()=>(await db.query(sql,p)).rows[0].n)
  const make=async(id=u.cs,n=5)=>rpc(id,'select public.create_supply_request($1,$2,$3,$4,$5) id',[u.clinic,u.pharmacy,u.med,n,'local proof test'])
  const obj=(r,f)=>`${r}/${f}.jpg`
  const upload=(id,name,bucket='request-proof-photos')=>as(id,()=>db.query('insert into storage.objects(id,bucket_id,name) values($1,$2,$3)',[crypto.randomUUID(),bucket,name]))
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key,bucket_id text not null references storage.buckets(id),name text not null,created_at timestamptz default now(),unique(bucket_id,name));
      alter table storage.objects enable row level security; grant usage on schema storage to authenticated;`)
    for (const f of files) {
      const p=path.join(root,'supabase/migrations',f); assert.ok(fs.existsSync(p),`Missing ${p}`)
      await db.exec(fs.readFileSync(p,'utf8'))
    }
    await db.exec(`insert into public.facilities(id,name,facility_type,address) values
      ('${u.clinic}','Clinic','CLINIC','local'),('${u.pharmacy}','Pharmacy','PHARMACY','local'),('${u.other}','Other','HOSPITAL','local');
      insert into auth.users values ('${u.ca}'),('${u.cs}'),('${u.sa}'),('${u.ss}'),('${u.os}'),('${u.inactive}');
      insert into public.profiles(id,facility_id,full_name,role,account_status) values
      ('${u.ca}','${u.clinic}','Clinic admin','FACILITY_ADMIN','ACTIVE'),('${u.cs}','${u.clinic}','Clinic staff','REQUESTING_STAFF','ACTIVE'),
      ('${u.sa}','${u.pharmacy}','Supplier admin','FACILITY_ADMIN','ACTIVE'),('${u.ss}','${u.pharmacy}','Supplier staff','SUPPLIER_STAFF','ACTIVE'),
      ('${u.os}','${u.other}','Other staff','SUPPLIER_STAFF','ACTIVE'),('${u.inactive}','${u.pharmacy}','Inactive staff','SUPPLIER_STAFF','INACTIVE');
      insert into public.medicines(id,name,strength,dosage_form,unit_of_measure) values('${u.med}','Medicine','10mg','tablet','tablet');`)
    const bucket=await rows("select id,public,file_size_limit,allowed_mime_types from storage.buckets where id='request-proof-photos'")
    assert.deepEqual(bucket,[{id:'request-proof-photos',public:false,file_size_limit:5242880,allowed_mime_types:['image/jpeg','image/png','image/webp']}]); checks++
    assert.deepEqual(await rows(`select has_table_privilege('anon','public.request_proofs','select') anon,
      has_table_privilege('authenticated','public.request_proofs','select') sel,
      has_table_privilege('authenticated','public.request_proofs','insert') ins,
      has_table_privilege('authenticated','public.supply_requests','update') upd`),[{anon:false,sel:true,ins:false,upd:false}]); checks++
    const valid=await rows('select public.is_valid_request_proof_object_path($1) a,public.is_valid_request_proof_object_path($2) b,public.is_valid_request_proof_object_path($3) c,public.is_valid_request_proof_object_path($4) d',[
      obj(u.clinic,u.photo),obj(u.clinic,u.photo2).replace('.jpg','.png'),obj(u.clinic,u.photo3).replace('.jpg','.webp'),`${u.clinic}/../bad.gif`])
    assert.deepEqual(valid,[{a:true,b:true,c:true,d:false}]); checks++
    const batch=await rpc(u.sa,'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) id',[u.pharmacy,u.med,'PHOTO',20,'2099-12-31',0])
    const req=await make(u.cs,5), path1=obj(req,u.photo)
    await rpc(u.ss,'select public.approve_supply_request($1) id',[req])
    await reject(u.cs,'insert into storage.objects(id,bucket_id,name) values($1,$2,$3)',[u.photo,'request-proof-photos',path1],'Requester upload should fail')
    await reject(u.os,'insert into storage.objects(id,bucket_id,name) values($1,$2,$3)',[u.photo,'request-proof-photos',path1],'Outsider upload should fail')
    await reject(u.inactive,'insert into storage.objects(id,bucket_id,name) values($1,$2,$3)',[u.photo,'request-proof-photos',path1],'Inactive upload should fail')
    await reject(u.ss,'insert into storage.objects(id,bucket_id,name) values($1,$2,$3)',[u.photo2,'request-proof-photos',`${u.clinic}/${u.photo2}.gif`],'Malformed extension should fail')
    await upload(u.ss,path1); checks++
    const req2=await make(u.cs,2); await rpc(u.sa,'select public.approve_supply_request($1) id',[req2])
    await reject(u.ss,'select public.fulfil_supply_request_with_proof($1,$2) id',[req2,obj(req2,u.photo2)],'Missing upload must fail')
    await reject(u.ss,'select public.fulfil_supply_request($1) id',[req2],'Old signature must fail closed')
    await upload(u.ss,obj(req,u.photo3))
    await reject(u.ss,'select public.fulfil_supply_request_with_proof($1,$2) id',[req2,obj(req,u.photo3)],'Cross-request path must fail')
    assert.deepEqual(await rows('select status,fulfilled_quantity from public.supply_requests where id=$1',[req2]),[{status:'APPROVED',fulfilled_quantity:0}]); checks++
    assert.deepEqual(await rows('select quantity_on_hand,quantity_reserved from public.inventory_batches where id=$1',[batch]),[{quantity_on_hand:20,quantity_reserved:7}]); checks++

    // Both participants can read proof metadata and storage; unrelated or inactive users cannot.
    assert.equal(await count(u.cs,'select count(*)::int n from public.request_proofs where request_id=$1',[req]),0)
    assert.equal(await count(u.ss,'select count(*)::int n from storage.objects where bucket_id=$1 and name=$2',['request-proof-photos',path1]),1)
    assert.equal(await count(u.cs,'select count(*)::int n from storage.objects where bucket_id=$1 and name=$2',['request-proof-photos',path1]),1)
    assert.equal(await count(u.os,'select count(*)::int n from storage.objects where bucket_id=$1 and name=$2',['request-proof-photos',path1]),0)
    await db.exec(`update public.profiles set account_status='INACTIVE' where id='${u.ss}'`)
    assert.equal(await count(u.ss,'select count(*)::int n from storage.objects where bucket_id=$1 and name=$2',['request-proof-photos',path1]),0)
    assert.equal(await count(u.ss,'select count(*)::int n from public.request_proofs where request_id=$1',[req]),0)
    await db.exec(`update public.profiles set account_status='ACTIVE' where id='${u.ss}'`); checks+=6

    // Unregistered uploaded photo can be cleaned up; registered proof cannot.
    const cleanup=await make(u.cs,1); await rpc(u.sa,'select public.approve_supply_request($1) id',[cleanup])
    const cleanPath=obj(cleanup,u.photo3); await upload(u.ss,cleanPath)
    await as(u.ss,()=>db.query('delete from storage.objects where bucket_id=$1 and name=$2',['request-proof-photos',cleanPath]))
    assert.equal(await count(u.ss,'select count(*)::int n from storage.objects where bucket_id=$1 and name=$2',['request-proof-photos',cleanPath]),0); checks++

    assert.equal(await rpc(u.ss,'select public.fulfil_supply_request_with_proof($1,$2) id',[req,path1]),req)
    await reject(u.ss,'select public.fulfil_supply_request_with_proof($1,$2) id',[req,path1],'Duplicate fulfilment must fail')
    assert.deepEqual(await rows('select status,fulfilled_quantity,received_by,received_at from public.supply_requests where id=$1',[req]),[
      {status:'FULFILLED',fulfilled_quantity:5,received_by:null,received_at:null}])
    assert.deepEqual(await rows('select quantity_on_hand,quantity_reserved from public.inventory_batches where id=$1',[batch]),[{quantity_on_hand:15,quantity_reserved:3}])
    assert.deepEqual(await rows('select request_id,object_path,uploaded_by from public.request_proofs where request_id=$1',[req]),[{request_id:req,object_path:path1,uploaded_by:u.ss}])
    assert.equal(await count(u.cs,'select count(*)::int n from public.request_proofs where request_id=$1',[req]),1)
    assert.equal(await count(u.os,'select count(*)::int n from public.request_proofs where request_id=$1',[req]),0)
    const deleted=await as(u.ss,()=>db.query('delete from storage.objects where bucket_id=$1 and name=$2 returning id',['request-proof-photos',path1]));
    assert.equal(deleted.rows.length,0); assert.equal(await count(u.ss,'select count(*)::int n from storage.objects where bucket_id=$1 and name=$2',['request-proof-photos',path1]),1); checks+=7
    await reject(u.ss,'select public.confirm_supply_request_receipt($1) id',[req],'Supplier cannot confirm receipt')
    await reject(u.os,'select public.confirm_supply_request_receipt($1) id',[req],'Unrelated user cannot confirm receipt')
    await reject(u.cs,'select public.confirm_supply_request_receipt($1) id',[req2],'Not-yet-fulfilled request cannot be received')
    assert.equal(await rpc(u.cs,'select public.confirm_supply_request_receipt($1) id',[req]),req)
    await reject(u.ca,'select public.confirm_supply_request_receipt($1) id',[req],'Receipt cannot be confirmed twice')
    const receipt=await rows('select status,received_by,received_at from public.supply_requests where id=$1',[req])
    assert.equal(receipt[0].status,'RECEIVED'); assert.equal(receipt[0].received_by,u.cs); assert.ok(receipt[0].received_at)
    assert.deepEqual(await rows("select event_type,previous_status,new_status,actor_id from public.request_events where supply_request_id=$1 and event_type='RECEIVED'",[req]),[
      {event_type:'RECEIVED',previous_status:'FULFILLED',new_status:'RECEIVED',actor_id:u.cs}])
    await assert.rejects(()=>db.query("update public.supply_requests set status='RECEIVED',received_by=null,received_at=null where id=$1",[req]))
    await assert.rejects(()=>db.query("update public.request_events set event_type='UNKNOWN' where supply_request_id=$1",[req])); checks+=6

    await db.exec("insert into storage.buckets(id,name,public) values('public','public',true)")
    await reject(u.ss,'insert into storage.objects(id,bucket_id,name) values($1,$2,$3)',[u.photo2,'public',obj(req2,u.photo2)],'Unrelated bucket has no policy')
    await assert.rejects(()=>db.query('insert into public.request_proofs(request_id,object_path,uploaded_by) values($1,$2,$3)',[req,`${req}/${u.photo}.gif`,u.ss]))
    await assert.rejects(()=>db.query('insert into public.request_proofs(request_id,object_path,uploaded_by) values($1,$2,$3)',[req,obj(req,u.photo2),u.ss]))
    assert.deepEqual(await rows(`select count(*)::int n from pg_policies where (schemaname='public' and tablename='request_proofs' and policyname='request_proofs_participants_read') or (schemaname='storage' and tablename='objects' and policyname like 'request_proof_photos_%')`),[{n:4}]); checks+=4
    console.log(`PASS: ${checks} photo-proof and receipt security/lifecycle assertions (PGlite; local only)`)
  } finally { await db.close() }
}
main().catch(error=>{console.error(error);process.exitCode=1})
