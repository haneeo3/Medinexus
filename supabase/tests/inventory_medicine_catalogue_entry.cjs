// Local PGlite test for exact formulation add-or-select and authorization.
// Run from the repository root: node supabase/tests/inventory_medicine_catalogue_entry.cjs
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = process.cwd()
const migrations = [
  'supabase/migrations/20261105060039_initial_schema.sql',
  'supabase/migrations/20261105061109_transactional_operations.sql',
  'supabase/migrations/20261105195649_inventory_medicine_catalogue_entry.sql',
]
const ids = {
  facility: '00000000-0000-0000-0000-000000000001', inactiveFacility: '00000000-0000-0000-0000-000000000002',
  admin: '10000000-0000-0000-0000-000000000001', manager: '10000000-0000-0000-0000-000000000002',
  staff: '10000000-0000-0000-0000-000000000003', otherAdmin: '10000000-0000-0000-0000-000000000004',
  medicine: '20000000-0000-0000-0000-000000000001',
}
const form = {
  facility: ids.facility, name: 'Pain relief', generic: 'Relievin', brand: 'Acme', ingredient: 'relievin hydrochloride',
  strength: '10 mg', dosage: 'tablet', unit: 'tablet', batch: 'LOT-1', quantity: 12, expiry: '2099-12-31', threshold: 2,
}
function call(db, value = {}) {
  const v = { ...form, ...value }
  return db.query(`select public.create_inventory_batch_with_medicine(
    $1::uuid,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text,$9::text,$10::integer,$11::date,$12::integer
  ) as id`, [v.facility,v.name,v.generic,v.brand,v.ingredient,v.strength,v.dosage,v.unit,v.batch,v.quantity,v.expiry,v.threshold])
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
  async function denied(userId, operation, label) {
    await assert.rejects(() => asUser(userId, operation), undefined, label)
    checks++
  }
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
    for (const migration of migrations) await db.exec(fs.readFileSync(path.join(root, migration), 'utf8'))
    await db.exec(`
      insert into public.facilities(id,name,facility_type,address,operational_status) values
        ('${ids.facility}','One','PHARMACY','Address','ACTIVE'),
        ('${ids.inactiveFacility}','Inactive','PHARMACY','Address','INACTIVE');
      insert into auth.users(id) values ('${ids.admin}'),('${ids.manager}'),('${ids.staff}'),('${ids.otherAdmin}');
      insert into public.profiles(id,facility_id,full_name,role) values
        ('${ids.admin}','${ids.facility}','Admin','FACILITY_ADMIN'),
        ('${ids.manager}','${ids.facility}','Manager','INVENTORY_MANAGER'),
        ('${ids.staff}','${ids.facility}','Staff','REQUESTING_STAFF'),
        ('${ids.otherAdmin}','${ids.inactiveFacility}','Other Admin','FACILITY_ADMIN');
      insert into public.medicines(id,name,generic_name,brand_name,active_ingredient,strength,dosage_form,unit_of_measure)
      values ('${ids.medicine}','Pain relief','Relievin','Acme','relievin hydrochloride','10 mg','tablet','tablet');
    `)
    const signature = 'public.create_inventory_batch_with_medicine(uuid,text,text,text,text,text,text,text,text,integer,date,integer)'
    const security = (await rows(`select prosecdef, proconfig,
      has_function_privilege('anon', oid, 'EXECUTE') as anon_exec,
      has_function_privilege('authenticated', oid, 'EXECUTE') as auth_exec
      from pg_proc where oid=$1::regprocedure`, [signature]))[0]
    assert.equal(security.prosecdef, true)
    assert.ok(security.proconfig.includes('search_path=""'))
    assert.equal(security.anon_exec, false)
    assert.equal(security.auth_exec, true)
    checks += 4

    await denied(ids.staff, () => call(db), 'requesting staff cannot add catalogue medicines or inventory')
    await denied(ids.otherAdmin, () => call(db, { facility: ids.inactiveFacility }), 'inactive facility cannot mutate inventory')
    await denied(ids.admin, () => call(db, { facility: ids.inactiveFacility }), 'user cannot target another facility')
    await denied(ids.manager, () => call(db, { generic: null }), 'generic name is required')
    await denied(ids.manager, () => call(db, { ingredient: '  ' }), 'active ingredient is required')
    for (const [field, value] of Object.entries({
      name: 'x'.repeat(201), generic: 'x'.repeat(201), brand: 'x'.repeat(201), ingredient: 'x'.repeat(201),
      strength: 'x'.repeat(201), dosage: 'x'.repeat(201), unit: 'x'.repeat(201), batch: 'x'.repeat(101),
    })) await denied(ids.manager, () => call(db, { [field]: value }), field + ' maximum length is enforced by the database')

    const batch1 = await asUser(ids.manager, () => call(db))
    const medicine1 = (await rows('select medicine_id from public.inventory_batches where id=$1', [batch1.rows[0].id]))[0].medicine_id
    assert.equal(medicine1, ids.medicine, 'exact complete formulation reuses shared catalogue ID')
    checks++
    assert.equal((await rows('select count(*)::int as n from public.medicines')).at(0).n, 1)
    checks++

    const batch2 = await asUser(ids.admin, () => call(db, { name: 'Fresh entry', generic: 'Generic X', brand: null, ingredient: 'Ingredient X', strength: '25 mg', dosage: 'capsule', unit: 'capsule', batch: 'LOT-2', quantity: 5 }))
    const created = (await rows('select medicine_id from public.inventory_batches where id=$1', [batch2.rows[0].id]))[0].medicine_id
    const details = (await rows('select name,generic_name,brand_name,active_ingredient,strength,dosage_form,unit_of_measure from public.medicines where id=$1', [created]))[0]
    assert.deepEqual(details, { name: 'Fresh entry', generic_name: 'Generic X', brand_name: null, active_ingredient: 'Ingredient X', strength: '25 mg', dosage_form: 'capsule', unit_of_measure: 'capsule' })
    checks++
    assert.deepEqual((await rows('select movement_type,quantity,performed_by from public.stock_movements where inventory_batch_id=$1', [batch2.rows[0].id]))[0], { movement_type: 'INITIAL_STOCK', quantity: 5, performed_by: ids.admin })
    checks++

    const otherStrength = await asUser(ids.manager, () => call(db, { strength: '20 mg', batch: 'LOT-3' }))
    const differentMedicine = (await rows('select medicine_id from public.inventory_batches where id=$1', [otherStrength.rows[0].id]))[0].medicine_id
    assert.notEqual(differentMedicine, ids.medicine, 'different strength creates a distinct exact catalogue formulation')
    checks++

    await denied(ids.manager, () => call(db, { batch: 'LOT-1' }), 'duplicate facility medicine batch number fails')
    assert.equal((await rows('select count(*)::int as n from public.medicines')).at(0).n, 3, 'failed batch creation leaves no orphan medicine')
    assert.equal((await rows('select count(*)::int as n from public.inventory_batches')).at(0).n, 3)
    checks += 2

    const duplicateId = (await rows("insert into public.medicines(name,generic_name,brand_name,active_ingredient,strength,dosage_form,unit_of_measure) values ('Pain relief','Relievin','Acme','relievin hydrochloride','10 mg','tablet','tablet') returning id"))[0].id
    await denied(ids.manager, () => call(db, { batch: 'LOT-DUP' }), 'ambiguous exact duplicate catalogue records fail closed')
    assert.notEqual(duplicateId, ids.medicine)
    assert.equal((await rows('select count(*)::int as n from public.inventory_batches')).at(0).n, 3, 'ambiguous entry creates no batch')
    checks += 2
    await db.exec("create function public.reject_test_stock_movement() returns trigger language plpgsql as $$ begin if new.quantity = 99 then raise exception using errcode='22023', message='test movement rejected'; end if; return new; end; $$; create trigger reject_test_stock_movement before insert on public.stock_movements for each row execute function public.reject_test_stock_movement();")
    const beforeRollback = await rows('select (select count(*)::int from public.medicines) as medicines, (select count(*)::int from public.inventory_batches) as batches, (select count(*)::int from public.stock_movements) as movements')
    await denied(ids.admin, () => call(db, { name: 'Atomic rollback test', generic: 'Atomic generic', brand: null, ingredient: 'Atomic ingredient', strength: '1 mg', dosage: 'liquid', unit: 'ml', batch: 'LOT-ATOMIC', quantity: 99 }), 'failed initial stock movement rejects the complete transaction')
    const afterRollback = await rows('select (select count(*)::int from public.medicines) as medicines, (select count(*)::int from public.inventory_batches) as batches, (select count(*)::int from public.stock_movements) as movements')
    assert.deepEqual(afterRollback[0], beforeRollback[0], 'medicine, batch and movement changes roll back together')
    checks++

    const directInsert = await rows("select has_table_privilege('authenticated','public.medicines','INSERT') as direct_medicine, has_table_privilege('authenticated','public.inventory_batches','INSERT') as direct_batches")
    assert.equal(directInsert[0].direct_medicine, false)
    assert.equal(directInsert[0].direct_batches, false)
    checks += 2
    console.log(`PASS inventory medicine catalogue entry: ${checks} checks`)
  } finally {
    await db.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
