// Local PGlite checks for receiving-side inventory intake.
// Run: node supabase/tests/receiving_inventory.cjs
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = process.cwd()
const files = ['20261105060039_initial_schema.sql','20261105061109_transactional_operations.sql','20261105121023_photo_proof_receipt.sql','20261105220000_receiving_inventory_intake.sql']
const id = {
  clinic:'00000000-0000-0000-0000-000000000001', supplier:'00000000-0000-0000-0000-000000000002', other:'00000000-0000-0000-0000-000000000003', med:'20000000-0000-0000-0000-000000000001',
  clinicAdmin:'10000000-0000-0000-0000-000000000001', clinicStaff:'10000000-0000-0000-0000-000000000002', supplierAdmin:'10000000-0000-0000-0000-000000000003', supplierStaff:'10000000-0000-0000-0000-000000000004', otherStaff:'10000000-0000-0000-0000-000000000005'
}
async function main() {
  const db = new PGlite(); let checks=0
  const rows=async(sql,p=[]) => (await db.query(sql,p)).rows
  async function as(user,fn) {
    await db.exec('reset role; set role authenticated')
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user])
    try { return await fn() } finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claim.sub','',false)") }
  }
  const rpc=(user,sql,p=[])=>as(user,async()=>(await db.query(sql,p)).rows[0]?.id)
  async function denied(user,sql,p=[],label='Expected rejection') { await assert.rejects(()=>rpc(user,sql,p),undefined,label); checks++ }
  try {
    await db.exec(`create role anon; create role authenticated; create schema auth;
      create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated; create schema storage;
      create table storage.buckets(id text primary key,name text not null,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid primary key,bucket_id text not null references storage.buckets(id),name text not null,unique(bucket_id,name));
      alter table storage.objects enable row level security; grant usage on schema storage to authenticated;`)
    for (const f of files) await db.exec(fs.readFileSync(path.join(root,'supabase/migrations',f),'utf8'))
    await db.exec(`insert into public.facilities(id,name,facility_type,address) values
      ('${id.clinic}','Clinic','CLINIC','local'),('${id.supplier}','Supplier','PHARMACY','local'),('${id.other}','Other','HOSPITAL','local');
      insert into auth.users values ('${id.clinicAdmin}'),('${id.clinicStaff}'),('${id.supplierAdmin}'),('${id.supplierStaff}'),('${id.otherStaff}');
      insert into public.profiles(id,facility_id,full_name,role) values
      ('${id.clinicAdmin}','${id.clinic}','Clinic admin','FACILITY_ADMIN'),('${id.clinicStaff}','${id.clinic}','Clinic staff','REQUESTING_STAFF'),
      ('${id.supplierAdmin}','${id.supplier}','Supplier admin','FACILITY_ADMIN'),('${id.supplierStaff}','${id.supplier}','Supplier staff','SUPPLIER_STAFF'),('${id.otherStaff}','${id.other}','Other','REQUESTING_STAFF');
      insert into public.medicines(id,name,strength,dosage_form,unit_of_measure) values('${id.med}','Medicine','10mg','tablet','tablet');`)
    assert.deepEqual(await rows(`select has_table_privilege('authenticated','public.supply_request_receipt_lines','select') sel,
      has_table_privilege('authenticated','public.supply_request_receipt_lines','insert') ins,
      has_table_privilege('authenticated','public.supply_requests','update') upd`),[{sel:true,ins:false,upd:false}]); checks++

    await rpc(id.supplierAdmin,'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) id',[id.supplier,id.med,'SOURCE-A',4,'2040-01-01',0])
    await rpc(id.supplierAdmin,'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) id',[id.supplier,id.med,'SOURCE-B',20,'2041-01-01',0])
    const req=await rpc(id.clinicStaff,'select public.create_supply_request($1,$2,$3,$4,$5) id',[id.clinic,id.supplier,id.med,5,'receipt test'])
    await rpc(id.supplierStaff,'select public.approve_supply_request($1) id',[req])
    const photoPath=`${req}/${crypto.randomUUID()}.jpg`
    await as(id.supplierStaff,()=>db.query('insert into storage.objects(id,bucket_id,name) values($1,$2,$3)',[crypto.randomUUID(),'request-proof-photos',photoPath]))
    await rpc(id.supplierStaff,'select public.fulfil_supply_request_with_proof($1,$2) id',[req,photoPath])
    assert.deepEqual(await rows('select status,fulfilled_quantity from public.supply_requests where id=$1',[req]),[{status:'FULFILLED',fulfilled_quantity:5}]); checks++

    const partial=[{batch_number:'RECEIVED-A',quantity:2,expiry_date:'2042-02-01'},{batch_number:'RECEIVED-B',quantity:2,expiry_date:'2043-03-01'}]
    await denied(id.clinicStaff,'select public.confirm_supply_request_receipt_with_inventory($1,$2) id',[req,JSON.stringify(partial)],'Partial receipt must fail')
    await denied(id.clinicStaff,'select public.confirm_supply_request_receipt($1) id',[req],'Legacy receipt RPC must fail closed')
    await denied(id.supplierStaff,'select public.confirm_supply_request_receipt_with_inventory($1,$2) id',[req,JSON.stringify([{batch_number:'X',quantity:5,expiry_date:'2042-01-01'}])],'Supplier cannot record receiving inventory')
    await denied(id.otherStaff,'select public.confirm_supply_request_receipt_with_inventory($1,$2) id',[req,JSON.stringify([{batch_number:'X',quantity:5,expiry_date:'2042-01-01'}])],'Other facility cannot record receipt')
    assert.deepEqual(await rows('select count(*)::int n from public.supply_request_receipt_lines where supply_request_id=$1',[req]),[{n:0}]); checks++
    assert.deepEqual(await rows('select count(*)::int n from public.stock_movements where supply_request_id=$1 and movement_type=$2',[req,'RECEIPT_IN']),[{n:0}]); checks++

    await rpc(id.clinicAdmin,'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) id',[id.clinic,id.med,'RECEIVED-A',3,'2042-02-01',0])
    const wrongExpiry=[{batch_number:'RECEIVED-A',quantity:2,expiry_date:'2042-02-02'},{batch_number:'RECEIVED-B',quantity:3,expiry_date:'2043-03-01'}]
    await denied(id.clinicStaff,'select public.confirm_supply_request_receipt_with_inventory($1,$2) id',[req,JSON.stringify(wrongExpiry)],'Batch number with different expiry must fail')
    assert.deepEqual(await rows("select quantity_on_hand from public.inventory_batches where facility_id=$1 and batch_number='RECEIVED-A'",[id.clinic]),[{quantity_on_hand:3}]); checks++

    const batches=[{batch_number:'RECEIVED-A',quantity:2,expiry_date:'2042-02-01'},{batch_number:'RECEIVED-B',quantity:3,expiry_date:'2043-03-01'}]
    assert.equal(await rpc(id.clinicStaff,'select public.confirm_supply_request_receipt_with_inventory($1,$2) id',[req,JSON.stringify(batches)]),req)
    await denied(id.clinicAdmin,'select public.confirm_supply_request_receipt_with_inventory($1,$2) id',[req,JSON.stringify(batches)],'Duplicate receipt must fail')
    assert.deepEqual(await rows('select status,fulfilled_quantity,received_by from public.supply_requests where id=$1',[req]),[{status:'RECEIVED',fulfilled_quantity:5,received_by:id.clinicStaff}]); checks++
    assert.deepEqual(await rows('select batch_number,quantity_on_hand,expiry_date::text expiry_date from public.inventory_batches where facility_id=$1 and batch_number like \'RECEIVED-%\' order by batch_number',[id.clinic]),[
      {batch_number:'RECEIVED-A',quantity_on_hand:5,expiry_date:'2042-02-01'}, {batch_number:'RECEIVED-B',quantity_on_hand:3,expiry_date:'2043-03-01'}]); checks++
    assert.deepEqual(await rows("select movement_type,quantity,performed_by from public.stock_movements where supply_request_id=$1 and movement_type='RECEIPT_IN' order by quantity",[req]),[
      {movement_type:'RECEIPT_IN',quantity:2,performed_by:id.clinicStaff},{movement_type:'RECEIPT_IN',quantity:3,performed_by:id.clinicStaff}]); checks++
    assert.deepEqual(await rows('select batch_number,quantity,expiry_date::text expiry_date from public.supply_request_receipt_lines where supply_request_id=$1 order by batch_number',[req]),[
      {batch_number:'RECEIVED-A',quantity:2,expiry_date:'2042-02-01'},{batch_number:'RECEIVED-B',quantity:3,expiry_date:'2043-03-01'}]); checks++
    assert.equal(await as(id.otherStaff,async()=>(await db.query('select count(*)::int n from public.supply_request_receipt_lines where supply_request_id=$1',[req])).rows[0].n),0); checks++
    assert.equal(await as(id.clinicStaff,async()=>(await db.query('select count(*)::int n from public.supply_request_receipt_lines where supply_request_id=$1',[req])).rows[0].n),2); checks++
    assert.deepEqual(await rows("select metadata->>'received_quantity' quantity from public.request_events where supply_request_id=$1 and event_type='RECEIVED'",[req]),[{quantity:'5'}]); checks++
    await assert.rejects(()=>db.query("insert into public.supply_request_receipt_lines(supply_request_id,receiving_facility_id,medicine_id,inventory_batch_id,batch_number,quantity,expiry_date) select supply_request_id,receiving_facility_id,medicine_id,inventory_batch_id,batch_number,quantity,expiry_date from public.supply_request_receipt_lines where supply_request_id=$1 limit 1",[req])); checks++
    console.log('PASS: '+checks+' receiving inventory assertions (PGlite; local only)')
  } finally { await db.close() }
}
main().catch(error=>{console.error(error);process.exitCode=1})
