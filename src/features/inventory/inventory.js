const PAGE_SIZE = 500
const MAX_INT = 2147483647

// Inventory rows are still protected by database RLS; the facility filter is not authorization.
async function readAllPages(queryForPage) {
  const all = []
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await queryForPage(start, start + PAGE_SIZE - 1)
    if (error) throw error
    all.push(...data)
    if (data.length < PAGE_SIZE) return all
  }
}

export async function loadInventory(client, facilityId) {
  const [batches, medicines] = await Promise.all([
    readAllPages((start, end) => client.from('inventory_batches')
      .select('id, facility_id, medicine_id, batch_number, quantity_on_hand, quantity_reserved, low_stock_threshold, expiry_date, last_updated_at, medicines(id, name, generic_name, brand_name, active_ingredient, strength, dosage_form, unit_of_measure)')
      .eq('facility_id', facilityId).order('expiry_date').order('id').range(start, end)),
    readAllPages((start, end) => client.from('medicines')
      .select('id, name, generic_name, brand_name, active_ingredient, strength, dosage_form, unit_of_measure')
      .order('name').order('id').range(start, end)),
  ])
  return { batches, medicines }
}

export function positiveInteger(value, allowZero = false) {
  const text = String(value)
  if (!/^\d+$/.test(text)) return false
  const n = Number(text)
  return Number.isInteger(n) && n <= MAX_INT && (allowZero ? n >= 0 : n > 0)
}

export function medicineLabel(medicine) {
  if (!medicine) return 'Unknown medicine'
  return [medicine.name, medicine.strength, medicine.dosage_form].filter(Boolean).join(' · ')
}

export function expiryWarningDays() {
  const configured = import.meta.env.VITE_EXPIRY_WARNING_DAYS
  return configured != null && positiveInteger(configured, true) && Number(configured) <= 3650 ? Number(configured) : 90
}

// Dates are evaluated against UTC to match the Supabase project's database timezone.
export function batchStatus(batch, now = new Date()) {
  const utcToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const expiry = Date.parse(`${batch.expiry_date}T00:00:00Z`)
  const days = Math.floor((expiry - utcToday) / 86400000)
  const expired = days < 0
  const unreserved = Math.max(0, batch.quantity_on_hand - batch.quantity_reserved)
  const eligible = expired ? 0 : unreserved
  return { expired, approaching: !expired && days <= expiryWarningDays(), low: eligible <= batch.low_stock_threshold, unreserved, eligible }
}

export function inventoryError(error) {
  if (error?.code === '42501') return 'You do not have permission to make this change.'
  if (error?.code === '23505') return 'A batch with this number already exists for this medicine.'
  if (error?.code === 'P0002') return 'This batch no longer exists. Refresh and try again.'
  if (error?.code === '22023') {
    if (error.message?.includes('reserved stock')) return 'The change would affect reserved stock. Check the available quantity and try again.'
    if (error.message?.includes('reserved')) return 'Expiry cannot be changed while this batch has reserved stock.'
    return 'The values are invalid or the stock change is not allowed.'
  }
  return 'Could not save the change. Check your connection and try again.'
}

export async function loadBatchHistory(client, batchId) {
  const [movements, changes] = await Promise.all([
    readAllPages((start, end) => client.from('stock_movements')
      .select('id, movement_type, quantity, performed_by, notes, created_at, supply_request_id')
      .eq('inventory_batch_id', batchId).order('created_at', { ascending: false }).order('id').range(start, end)),
    readAllPages((start, end) => client.from('inventory_batch_changes')
      .select('id, actor_id, before_metadata, after_metadata, notes, created_at')
      .eq('inventory_batch_id', batchId).order('created_at', { ascending: false }).order('id').range(start, end)),
  ])
  return [
    ...movements.map((item) => ({ ...item, kind: 'movement' })),
    ...changes.map((item) => ({ ...item, kind: 'metadata' })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
}
