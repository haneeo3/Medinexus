import { batchStatus, expiryWarningDays } from '../inventory/inventory.js'

const PAGE_SIZE = 500
const ACTIVITY_LIMIT = 8
const MAX_ACTIVITY_SOURCE = 24
export { expiryWarningDays }

function readAllPages(queryForPage) {
  return (async () => {
    const rows = []
    for (let start = 0; ; start += PAGE_SIZE) {
      const { data, error } = await queryForPage(start, start + PAGE_SIZE - 1)
      if (error) throw error
      const page = data || []
      rows.push(...page)
      if (page.length < PAGE_SIZE) return rows
    }
  })()
}

export function inventorySignals(batch, now) {
  const status = batchStatus(batch, now)
  return { ...status, expiring: status.approaching }
}

const REQUEST_SELECT = [
  'id', 'requesting_facility_id', 'supplying_facility_id', 'medicine_id',
  'requested_quantity', 'approved_quantity', 'fulfilled_quantity', 'status',
  'created_at', 'updated_at',
  'requesting_facility:facilities!supply_requests_requesting_facility_id_fkey(id,name)',
  'supplying_facility:facilities!supply_requests_supplying_facility_id_fkey(id,name)',
  'medicine:medicines!supply_requests_medicine_id_fkey(id,name,strength,dosage_form,unit_of_measure)',
].join(', ')

export async function loadDashboard(client, facilityId) {
  const [batches, requests, movements] = await Promise.all([
    readAllPages((start, end) => client.from('inventory_batches')
      .select('id, facility_id, medicine_id, batch_number, quantity_on_hand, quantity_reserved, low_stock_threshold, expiry_date, last_updated_at, medicines(id,name,strength,dosage_form,unit_of_measure)')
      .eq('facility_id', facilityId).order('expiry_date').order('id').range(start, end)),
    readAllPages((start, end) => client.from('supply_requests')
      .select(REQUEST_SELECT)
      .or(`requesting_facility_id.eq.${facilityId},supplying_facility_id.eq.${facilityId}`)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).range(start, end)),
    client.from('stock_movements')
      .select('id, inventory_batch_id, movement_type, quantity, supply_request_id, created_at')
      .eq('facility_id', facilityId)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(0, MAX_ACTIVITY_SOURCE - 1),
  ])
  if (movements.error) throw movements.error

  const requestIds = requests.map((request) => request.id)
  let events = []
  if (requestIds.length) {
    const result = await client.from('request_events')
      .select('id, supply_request_id, event_type, created_at')
      .in('supply_request_id', requestIds)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(0, MAX_ACTIVITY_SOURCE - 1)
    if (result.error) throw result.error
    events = result.data || []
  }

  return { batches, requests, movements: movements.data || [], events, snapshotAt: new Date() }
}

function medicineName(medicine) {
  if (!medicine) return 'Unknown medicine'
  return [medicine.name, medicine.strength, medicine.dosage_form].filter(Boolean).join(' · ')
}

const movementLabels = {
  INITIAL_STOCK: 'Stock recorded',
  ADJUSTMENT_IN: 'Stock increased',
  ADJUSTMENT_OUT: 'Stock reduced',
  FULFILMENT_OUT: 'Stock issued',
}
const eventLabels = {
  CREATED: 'Request created',
  APPROVED: 'Request approved',
  REJECTED: 'Request rejected',
  FULFILLED: 'Request fulfilled',
  RECEIVED: 'Receipt confirmed',
  CANCELLED: 'Request cancelled',
}

export function recentActivity(data, facilityId) {
  const batches = new Map(data.batches.map((batch) => [batch.id, batch]))
  const requests = new Map(data.requests.map((request) => [request.id, request]))
  const movementItems = data.movements.map((movement) => {
    const batch = batches.get(movement.inventory_batch_id)
    const unit = batch?.medicines?.unit_of_measure || 'units'
    return {
      id: `movement-${movement.id}`,
      createdAt: movement.created_at,
      title: movementLabels[movement.movement_type] || 'Inventory updated',
      detail: `${medicineName(batch?.medicines)} · ${movement.quantity} ${unit}${batch ? ` · Batch ${batch.batch_number}` : ''}`,
    }
  })
  const eventItems = data.events.flatMap((event) => {
    const request = requests.get(event.supply_request_id)
    if (!request) return []
    const isIncoming = request.supplying_facility_id === facilityId
    const otherFacility = isIncoming ? request.requesting_facility : request.supplying_facility
    return [{
      id: `event-${event.id}`,
      createdAt: event.created_at,
      title: eventLabels[event.event_type] || 'Request updated',
      detail: `${medicineName(request.medicine)} · ${request.requested_quantity} ${request.medicine?.unit_of_measure || 'units'} · ${isIncoming ? 'From' : 'To'} ${otherFacility?.name || 'another facility'}`,
    }]
  })
  return [...movementItems, ...eventItems]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, ACTIVITY_LIMIT)
}
