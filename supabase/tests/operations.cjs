// Local integration tests for transactional MediNexus RPCs using PGlite.
// Run from the repository root with:
//   NODE_PATH="$HYPER_SCRATCH_DIR/node_modules" node supabase/tests/operations.cjs
const { PGlite } = require('@electric-sql/pglite')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')

const root = process.cwd()
const foundationPath = path.join(root, 'supabase/migrations/20261105060039_initial_schema.sql')
const operationsPath = path.join(root, 'supabase/migrations/20261105061109_transactional_operations.sql')
const ids = {
  requester: '00000000-0000-0000-0000-000000000001',
  supplier: '00000000-0000-0000-0000-000000000002',
  other: '00000000-0000-0000-0000-000000000003',
  medicine: '20000000-0000-0000-0000-000000000001',
  expiredMedicine: '20000000-0000-0000-0000-000000000002',
  reqAdmin: '10000000-0000-0000-0000-000000000001',
  reqStaff: '10000000-0000-0000-0000-000000000002',
  reqManager: '10000000-0000-0000-0000-000000000003',
  supplierAdmin: '10000000-0000-0000-0000-000000000004',
  supplierStaff: '10000000-0000-0000-0000-000000000005',
  otherAdmin: '10000000-0000-0000-0000-000000000006',
  otherStaff: '10000000-0000-0000-0000-000000000007',
}

async function main() {
  assert.ok(fs.existsSync(foundationPath), `Missing foundation migration: ${foundationPath}`)
  assert.ok(fs.existsSync(operationsPath), `Missing operations migration: ${operationsPath}`)
  const db = new PGlite()
  let checks = 0

  async function asUser(userId, operation) {
    await db.exec('reset role; set role authenticated;')
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId])
    try {
      return await operation()
    } finally {
      await db.exec('reset role;')
      await db.query("select set_config('request.jwt.claim.sub', '', false)")
    }
  }

  async function rpc(userId, sql, params) {
    return asUser(userId, async () => (await db.query(sql, params)).rows[0].id)
  }

  async function denied(userId, sql, params, description) {
    await assert.rejects(() => rpc(userId, sql, params), description)
    checks += 1
  }

  async function rows(sql, params = []) {
    return (await db.query(sql, params)).rows
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
    await db.exec(fs.readFileSync(foundationPath, 'utf8'))
    await db.exec(fs.readFileSync(operationsPath, 'utf8'))
    await db.exec(`
      insert into public.facilities(id,name,facility_type,address) values
        ('${ids.requester}','Requesting Clinic','CLINIC','Local test address'),
        ('${ids.supplier}','Supplying Pharmacy','PHARMACY','Local test address'),
        ('${ids.other}','Separate Facility','HOSPITAL','Local test address');
      insert into auth.users(id) values
        ('${ids.reqAdmin}'),('${ids.reqStaff}'),('${ids.reqManager}'),
        ('${ids.supplierAdmin}'),('${ids.supplierStaff}'),('${ids.otherAdmin}'),('${ids.otherStaff}');
      insert into public.profiles(id,facility_id,full_name,role) values
        ('${ids.reqAdmin}','${ids.requester}','Requesting Admin','FACILITY_ADMIN'),
        ('${ids.reqStaff}','${ids.requester}','Requesting Staff','REQUESTING_STAFF'),
        ('${ids.reqManager}','${ids.requester}','Requesting Inventory Manager','INVENTORY_MANAGER'),
        ('${ids.supplierAdmin}','${ids.supplier}','Supplier Admin','FACILITY_ADMIN'),
        ('${ids.supplierStaff}','${ids.supplier}','Supplier Staff','SUPPLIER_STAFF'),
        ('${ids.otherAdmin}','${ids.other}','Other Facility Admin','FACILITY_ADMIN'),
        ('${ids.otherStaff}','${ids.other}','Other Supplier Staff','SUPPLIER_STAFF');
      insert into public.medicines(id,name,strength,dosage_form,unit_of_measure) values
        ('${ids.medicine}','Test medicine','10 mg','tablet','tablet'),
        ('${ids.expiredMedicine}','Expired-only medicine','5 mg','capsule','capsule');
    `)

    // Inventory creation is allowed to facility admins and inventory managers only.
    const requestStock = await rpc(ids.reqManager,
      'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) as id',
      [ids.requester, ids.medicine, 'REQUESTER-STOCK', 10, '2099-12-31', 2])
    const supplierEarly = await rpc(ids.supplierAdmin,
      'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) as id',
      [ids.supplier, ids.medicine, 'SUPPLIER-EARLY', 5, '2099-01-01', 1])
    const supplierLater = await rpc(ids.supplierAdmin,
      'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) as id',
      [ids.supplier, ids.medicine, 'SUPPLIER-LATER', 8, '2099-02-01', 1])
    const supplierExpired = await rpc(ids.supplierAdmin,
      'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) as id',
      [ids.supplier, ids.medicine, 'SUPPLIER-EXPIRED', 100, '2000-01-01', 0])
    const expiredOnly = await rpc(ids.supplierAdmin,
      'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) as id',
      [ids.supplier, ids.expiredMedicine, 'EXPIRED-ONLY', 50, '2000-01-01', 0])
    assert.ok([requestStock, supplierEarly, supplierLater, supplierExpired, expiredOnly].every(Boolean))
    checks += 1

    await denied(ids.reqStaff,
      'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) as id',
      [ids.requester, ids.medicine, 'STAFF-CANNOT-STOCK', 1, '2099-12-31', 0],
      'requesting staff cannot create inventory')
    await denied(ids.otherAdmin,
      'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) as id',
      [ids.supplier, ids.medicine, 'CROSS-FACILITY', 1, '2099-12-31', 0],
      'facility admin cannot create stock for another facility')
    await denied(ids.supplierStaff,
      'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) as id',
      [ids.supplier, ids.medicine, 'SUPPLIER-STAFF-CANNOT-STOCK', 1, '2099-12-31', 0],
      'supplier staff cannot create inventory')

    // Duplicate batch identity and invalid inventory deltas are rejected.
    await denied(ids.supplierAdmin,
      'select public.create_inventory_batch($1,$2,$3,$4,$5,$6) as id',
      [ids.supplier, ids.medicine, 'SUPPLIER-EARLY', 1, '2099-01-01', 0],
      'duplicate batch number is rejected')
    await denied(ids.reqManager, 'select public.adjust_inventory($1,$2,$3) as id', [requestStock, 0, 'zero'], 'zero adjustment is rejected')

    // Authorized adjustments are recorded; non-stock roles and other facilities are denied.
    assert.equal(await rpc(ids.reqManager, 'select public.adjust_inventory($1,$2,$3) as id', [requestStock, 3, 'receipt']), requestStock)
    assert.equal(await rpc(ids.reqAdmin, 'select public.adjust_inventory($1,$2,$3) as id', [requestStock, -2, 'correction']), requestStock)
    await denied(ids.reqStaff, 'select public.adjust_inventory($1,$2,$3) as id', [requestStock, 1, 'not allowed'], 'requesting staff cannot adjust inventory')
    await denied(ids.otherAdmin, 'select public.adjust_inventory($1,$2,$3) as id', [requestStock, 1, 'cross facility'], 'other facility cannot adjust inventory')
    let stock = await rows('select quantity_on_hand, quantity_reserved from public.inventory_batches where id=$1', [requestStock])
    assert.deepEqual(stock, [{ quantity_on_hand: 11, quantity_reserved: 0 }])
    let adjustmentHistory = await rows("select movement_type, quantity, notes from public.stock_movements where inventory_batch_id=$1 order by created_at, id", [requestStock])
    assert.deepEqual(adjustmentHistory.map(r => [r.movement_type, r.quantity, r.notes]), [
      ['INITIAL_STOCK', 10, null], ['ADJUSTMENT_IN', 3, 'receipt'], ['ADJUSTMENT_OUT', 2, 'correction'],
    ])
    checks += 2

    // Requesting staff can request/cancel; inventory managers cannot request.
    const cancellationRequest = await rpc(ids.reqStaff,
      'select public.create_supply_request($1,$2,$3,$4,$5) as id',
      [ids.requester, ids.supplier, ids.medicine, 6, 'release reservation test'])
    await denied(ids.reqManager, 'select public.create_supply_request($1,$2,$3,$4,$5) as id',
      [ids.requester, ids.supplier, ids.medicine, 1, 'wrong role'], 'inventory manager cannot request')
    await denied(ids.otherAdmin, 'select public.create_supply_request($1,$2,$3,$4,$5) as id',
      [ids.requester, ids.supplier, ids.medicine, 1, 'cross facility'], 'facility isolation on request creation')
    await denied(ids.reqStaff, 'select public.approve_supply_request($1) as id', [cancellationRequest], 'requester cannot approve')
    await denied(ids.otherStaff, 'select public.approve_supply_request($1) as id', [cancellationRequest], 'unrelated facility cannot approve')

    // Approval reserves earliest-expiring eligible lots first and excludes expired stock.
    assert.equal(await rpc(ids.supplierStaff, 'select public.approve_supply_request($1) as id', [cancellationRequest]), cancellationRequest)
    let reservations = await rows('select inventory_batch_id, quantity from public.request_reservations where supply_request_id=$1', [cancellationRequest])
    const reserveMap = Object.fromEntries(reservations.map(r => [r.inventory_batch_id, r.quantity]))
    assert.equal(reserveMap[supplierEarly], 5)
    assert.equal(reserveMap[supplierLater], 1)
    stock = await rows('select id, quantity_on_hand, quantity_reserved from public.inventory_batches where id=any($1::uuid[])', [[supplierEarly, supplierLater, supplierExpired]])
    const byId = Object.fromEntries(stock.map(r => [r.id, [r.quantity_on_hand, r.quantity_reserved]]))
    assert.deepEqual(byId[supplierEarly], [5, 5])
    assert.deepEqual(byId[supplierLater], [8, 1])
    assert.deepEqual(byId[supplierExpired], [100, 0])
    await denied(ids.supplierAdmin, 'select public.adjust_inventory($1,$2,$3) as id', [supplierEarly, -1, 'reserved'], 'reserved stock cannot be adjusted away')
    stock = await rows('select quantity_on_hand, quantity_reserved from public.inventory_batches where id=$1', [supplierEarly])
    assert.deepEqual(stock, [{ quantity_on_hand: 5, quantity_reserved: 5 }])
    await rpc(ids.supplierAdmin, 'select public.adjust_inventory($1,$2,$3) as id', [supplierEarly, 2, 'safe increase'])
    await rpc(ids.supplierAdmin, 'select public.adjust_inventory($1,$2,$3) as id', [supplierEarly, -2, 'safe decrease'])

    // Cancelling an approved request releases all reservations and records its event.
    assert.equal(await rpc(ids.reqStaff, 'select public.cancel_supply_request($1,$2) as id', [cancellationRequest, 'no longer needed']), cancellationRequest)
    reservations = await rows('select id from public.request_reservations where supply_request_id=$1', [cancellationRequest])
    assert.equal(reservations.length, 0)
    stock = await rows('select quantity_reserved from public.inventory_batches where id=any($1::uuid[]) order by id', [[supplierEarly, supplierLater]])
    assert.deepEqual(stock.map(r => r.quantity_reserved), [0, 0])
    let request = await rows('select status, approved_quantity, reviewed_by from public.supply_requests where id=$1', [cancellationRequest])
    assert.deepEqual(request, [{ status: 'CANCELLED', approved_quantity: 6, reviewed_by: ids.supplierStaff }])
    let events = await rows('select event_type, previous_status, new_status, notes from public.request_events where supply_request_id=$1 order by created_at,id', [cancellationRequest])
    assert.deepEqual(events.map(r => [r.event_type,r.previous_status,r.new_status,r.notes]), [
      ['CREATED',null,'PENDING','release reservation test'], ['APPROVED','PENDING','APPROVED',null], ['CANCELLED','APPROVED','CANCELLED','no longer needed'],
    ])
    await denied(ids.reqStaff, 'select public.cancel_supply_request($1,$2) as id', [cancellationRequest, 'again'], 'cannot cancel terminal request')

    // Rejection is supplier-only, leaves stock untouched, and cannot be repeated.
    const rejectedRequest = await rpc(ids.reqAdmin, 'select public.create_supply_request($1,$2,$3,$4,$5) as id',
      [ids.requester, ids.supplier, ids.medicine, 4, 'rejection case'])
    await denied(ids.reqStaff, 'select public.reject_supply_request($1,$2) as id', [rejectedRequest, 'wrong role'], 'requester cannot reject')
    assert.equal(await rpc(ids.supplierStaff, 'select public.reject_supply_request($1,$2) as id', [rejectedRequest, 'not available']), rejectedRequest)
    await denied(ids.supplierStaff, 'select public.reject_supply_request($1,$2) as id', [rejectedRequest, 'again'], 'duplicate rejection rejected')
    request = await rows('select status, approved_quantity from public.supply_requests where id=$1', [rejectedRequest])
    assert.deepEqual(request, [{ status: 'REJECTED', approved_quantity: null }])
    reservations = await rows('select id from public.request_reservations where supply_request_id=$1', [rejectedRequest])
    assert.equal(reservations.length, 0)
    stock = await rows('select id, quantity_on_hand, quantity_reserved from public.inventory_batches where id=any($1::uuid[])', [[supplierEarly, supplierLater, supplierExpired]])
    const afterReject = Object.fromEntries(stock.map(r => [r.id, [r.quantity_on_hand, r.quantity_reserved]]))
    assert.deepEqual(afterReject[supplierEarly], [5, 0])
    assert.deepEqual(afterReject[supplierLater], [8, 0])
    assert.deepEqual(afterReject[supplierExpired], [100, 0])

    // Insufficient stock rolls back partial allocations and leaves the request pending.
    const insufficientRequest = await rpc(ids.reqStaff, 'select public.create_supply_request($1,$2,$3,$4,$5) as id',
      [ids.requester, ids.supplier, ids.medicine, 20, 'rollback partial reservation'])
    await denied(ids.supplierAdmin, 'select public.approve_supply_request($1) as id', [insufficientRequest], 'insufficient stock cannot be approved')
    request = await rows('select status, approved_quantity from public.supply_requests where id=$1', [insufficientRequest])
    assert.deepEqual(request, [{ status: 'PENDING', approved_quantity: null }])
    reservations = await rows('select id from public.request_reservations where supply_request_id=$1', [insufficientRequest])
    assert.equal(reservations.length, 0)
    stock = await rows('select quantity_reserved from public.inventory_batches where id=any($1::uuid[]) order by id', [[supplierEarly, supplierLater, supplierExpired]])
    assert.deepEqual(stock.map(r => r.quantity_reserved), [0, 0, 0])

    // Expired-only stock cannot satisfy a request.
    const expiredRequest = await rpc(ids.reqStaff, 'select public.create_supply_request($1,$2,$3,$4,$5) as id',
      [ids.requester, ids.supplier, ids.expiredMedicine, 1, 'expired stock is ineligible'])
    await denied(ids.supplierStaff, 'select public.approve_supply_request($1) as id', [expiredRequest], 'expired stock is ineligible')
    request = await rows('select status from public.supply_requests where id=$1', [expiredRequest])
    assert.deepEqual(request, [{ status: 'PENDING' }])
    reservations = await rows('select id from public.request_reservations where supply_request_id=$1', [expiredRequest])
    assert.equal(reservations.length, 0)

    // Fulfilment consumes every lot exactly once and writes movements and history.
    const fulfilRequest = await rpc(ids.reqStaff, 'select public.create_supply_request($1,$2,$3,$4,$5) as id',
      [ids.requester, ids.supplier, ids.medicine, 10, 'fulfilment case'])
    assert.equal(await rpc(ids.supplierStaff, 'select public.approve_supply_request($1) as id', [fulfilRequest]), fulfilRequest)
    await denied(ids.reqStaff, 'select public.fulfil_supply_request($1) as id', [fulfilRequest], 'requester cannot fulfil')
    assert.equal(await rpc(ids.supplierStaff, 'select public.fulfil_supply_request($1) as id', [fulfilRequest]), fulfilRequest)
    await denied(ids.supplierStaff, 'select public.fulfil_supply_request($1) as id', [fulfilRequest], 'fulfilment cannot repeat')
    request = await rows('select status, approved_quantity, fulfilled_quantity from public.supply_requests where id=$1', [fulfilRequest])
    assert.deepEqual(request, [{ status: 'FULFILLED', approved_quantity: 10, fulfilled_quantity: 10 }])
    reservations = await rows('select id from public.request_reservations where supply_request_id=$1', [fulfilRequest])
    assert.equal(reservations.length, 0)
    stock = await rows('select id, quantity_on_hand, quantity_reserved from public.inventory_batches where id=any($1::uuid[])', [[supplierEarly, supplierLater, supplierExpired]])
    const afterFulfil = Object.fromEntries(stock.map(r => [r.id, [r.quantity_on_hand, r.quantity_reserved]]))
    assert.deepEqual(afterFulfil[supplierEarly], [0, 0])
    assert.deepEqual(afterFulfil[supplierLater], [3, 0])
    assert.deepEqual(afterFulfil[supplierExpired], [100, 0])
    const fulfilMovements = await rows("select inventory_batch_id,movement_type,quantity,supply_request_id,performed_by from public.stock_movements where supply_request_id=$1 order by inventory_batch_id", [fulfilRequest])
    const expectedFulfilMovements = [
      [supplierEarly,'FULFILMENT_OUT',5,fulfilRequest,ids.supplierStaff],
      [supplierLater,'FULFILMENT_OUT',5,fulfilRequest,ids.supplierStaff],
    ].sort((a,b) => a[0].localeCompare(b[0]))
    assert.deepEqual(fulfilMovements.map(r => [r.inventory_batch_id,r.movement_type,r.quantity,r.supply_request_id,r.performed_by]), expectedFulfilMovements)
    events = await rows('select event_type, previous_status, new_status, actor_id from public.request_events where supply_request_id=$1 order by created_at,id', [fulfilRequest])
    assert.deepEqual(events.map(r => [r.event_type,r.previous_status,r.new_status,r.actor_id]), [
      ['CREATED',null,'PENDING',ids.reqStaff], ['APPROVED','PENDING','APPROVED',ids.supplierStaff], ['FULFILLED','APPROVED','FULFILLED',ids.supplierStaff],
    ])

    // Supplier-side cancellation of a pending request is allowed, but another facility cannot do it.
    const supplierCancelRequest = await rpc(ids.reqStaff, 'select public.create_supply_request($1,$2,$3,$4,$5) as id',
      [ids.requester, ids.supplier, ids.medicine, 1, 'supplier cancellation case'])
    assert.equal(await rpc(ids.supplierStaff, 'select public.cancel_supply_request($1,$2) as id', [supplierCancelRequest, 'supplier declined']), supplierCancelRequest)
    request = await rows('select status from public.supply_requests where id=$1', [supplierCancelRequest])
    assert.deepEqual(request, [{ status: 'CANCELLED' }])
    await denied(ids.otherStaff, 'select public.cancel_supply_request($1,$2) as id', [supplierCancelRequest, 'cross facility'], 'unrelated facility cannot cancel')

    // Inactive users lose RPC access, even if their role would otherwise qualify.
    await db.exec(`update public.profiles set account_status='INACTIVE' where id='${ids.reqStaff}'`)
    await denied(ids.reqStaff, 'select public.create_supply_request($1,$2,$3,$4,$5) as id',
      [ids.requester, ids.supplier, ids.medicine, 1, 'inactive actor'], 'inactive account cannot request')
    await db.exec(`update public.profiles set account_status='ACTIVE' where id='${ids.reqStaff}'`)

    // Check that audit and inventory history cover the complete test lifecycle.
    const eventCounts = await rows('select event_type,count(*)::int as count from public.request_events group by event_type')
    const countByEvent = Object.fromEntries(eventCounts.map(r => [r.event_type, r.count]))
    assert.ok(countByEvent.CREATED >= 6)
    assert.equal(countByEvent.APPROVED, 2)
    assert.equal(countByEvent.REJECTED, 1)
    assert.equal(countByEvent.CANCELLED, 2)
    assert.equal(countByEvent.FULFILLED, 1)
    const movementCounts = await rows('select movement_type,count(*)::int as count from public.stock_movements group by movement_type')
    const countByMovement = Object.fromEntries(movementCounts.map(r => [r.movement_type, r.count]))
    assert.ok(countByMovement.INITIAL_STOCK >= 5)
    assert.ok(countByMovement.ADJUSTMENT_IN >= 2)
    assert.ok(countByMovement.ADJUSTMENT_OUT >= 2)
    assert.equal(countByMovement.FULFILMENT_OUT, 2)

    console.log(`PASS: ${checks} authorization/error checks plus operation, rollback, stock, and audit assertions (PGlite; local only)`)
  } finally {
    await db.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
