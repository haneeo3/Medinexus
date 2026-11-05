// Local smoke test with PGlite. Real Supabase integration tests are still required.
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs')
const assert = require('node:assert/strict')

async function main() {
  const db = new PGlite()
  await db.exec(`
    create role anon;
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to authenticated;
  `)
  await db.exec(fs.readFileSync('supabase/migrations/20261105060039_initial_schema.sql', 'utf8'))
  const f1 = '00000000-0000-0000-0000-000000000001'
  const f2 = '00000000-0000-0000-0000-000000000002'
  const u1 = '10000000-0000-0000-0000-000000000001'
  const u2 = '10000000-0000-0000-0000-000000000002'
  const admin = '10000000-0000-0000-0000-000000000003'
  const med = '20000000-0000-0000-0000-000000000001'
  await db.exec(`
    insert into public.facilities(id,name,facility_type,address) values
      ('${f1}','Demo Clinic','CLINIC','Demo address'), ('${f2}','Demo Pharmacy','PHARMACY','Demo address');
    insert into auth.users(id) values ('${u1}'), ('${u2}'), ('${admin}');
    insert into public.profiles(id,facility_id,full_name,role) values
      ('${u1}','${f1}','Clinic Admin','FACILITY_ADMIN'),
      ('${u2}','${f2}','Pharmacy Staff','SUPPLIER_STAFF'),
      ('${admin}',null,'Platform Admin','PLATFORM_ADMIN');
    insert into public.medicines(id,name,strength,dosage_form,unit_of_measure)
      values ('${med}','Example medicine','10 mg','tablet','tablet');
    insert into public.inventory_batches(facility_id,medicine_id,batch_number,quantity_on_hand,quantity_reserved,expiry_date) values
      ('${f1}','${med}','A',20,5,'2099-12-31'), ('${f2}','${med}','B',50,0,'2099-12-31');
  `)
  await assert.rejects(db.exec(`insert into public.inventory_batches(facility_id,medicine_id,batch_number,quantity_on_hand,expiry_date) values ('${f1}','${med}','NEG',-1,'2099-12-31')`))
  await assert.rejects(db.exec(`insert into public.inventory_batches(facility_id,medicine_id,batch_number,quantity_on_hand,quantity_reserved,expiry_date) values ('${f1}','${med}','OVER',1,2,'2099-12-31')`))
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${u1}',false);`)
  let rows = (await db.query('select facility_id from public.inventory_batches')).rows
  assert.deepEqual(rows.map(r => r.facility_id), [f1], 'clinic sees only its own batches')
  rows = (await db.query('select id from public.profiles')).rows
  assert.deepEqual(rows.map(r => r.id), [u1], 'facility admin cannot see other facility staff')
  await assert.rejects(db.exec(`insert into public.medicines(name,strength,dosage_form,unit_of_measure) values ('x','1','tablet','tablet')`))
  await db.exec(`select set_config('request.jwt.claim.sub','${u2}',false);`)
  rows = (await db.query('select facility_id from public.inventory_batches')).rows
  assert.deepEqual(rows.map(r => r.facility_id), [f2], 'supplier sees only its own batches')
  await db.exec(`select set_config('request.jwt.claim.sub','${admin}',false);`)
  rows = (await db.query('select facility_id from public.inventory_batches')).rows
  assert.equal(rows.length, 2, 'platform admin can see both facilities')
  await db.exec(`reset role; update public.profiles set account_status='INACTIVE' where id='${u1}'; set role authenticated; select set_config('request.jwt.claim.sub','${u1}',false);`)
  rows = (await db.query('select * from public.inventory_batches')).rows
  assert.equal(rows.length, 0, 'inactive user has no inventory access')
  await db.exec('reset role; set role anon;')
  await assert.rejects(db.query('select * from public.medicines'))
  await db.close()
  console.log('PASS: migration, quantity constraints, facility isolation, inactive user, admin and anonymous access')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
