const PAGE_SIZE = 500

async function readAllPages(queryForPage) {
  const rows = []
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await queryForPage(start, start + PAGE_SIZE - 1)
    if (error) throw error
    const page = data || []
    rows.push(...page)
    if (page.length < PAGE_SIZE) return rows
  }
}

const REQUEST_SELECT = [
  'id', 'requesting_facility_id', 'supplying_facility_id', 'medicine_id',
  'requested_quantity', 'approved_quantity', 'fulfilled_quantity', 'status',
  'request_notes', 'created_by', 'reviewed_by', 'created_at', 'updated_at',
  'requesting_facility:facilities!supply_requests_requesting_facility_id_fkey(id,name)',
  'supplying_facility:facilities!supply_requests_supplying_facility_id_fkey(id,name)',
  'medicine:medicines!supply_requests_medicine_id_fkey(id,name,strength,dosage_form,unit_of_measure)',
].join(', ')

export async function loadSupplyRequests(client, facilityId) {
  return readAllPages((start, end) => client.from('supply_requests')
    .select(REQUEST_SELECT)
    .or(`requesting_facility_id.eq.${facilityId},supplying_facility_id.eq.${facilityId}`)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(start, end))
}

export async function loadRequestHistory(client, requestId) {
  return readAllPages((start, end) => client.from('request_events')
    .select('id, supply_request_id, event_type, actor_id, previous_status, new_status, notes, created_at')
    .eq('supply_request_id', requestId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .range(start, end))
}

export function requestErrorMessage(error) {
  const message = String(error?.message || '').toLowerCase()
  if (/insufficient eligible available stock|insufficient.*stock/.test(message)) {
    return 'There is not enough eligible stock to approve this request. No stock was reserved.'
  }
  if (/only pending requests? can be approved/.test(message)) return 'This request is no longer pending, so it cannot be approved.'
  if (/only pending requests? can be rejected/.test(message)) return 'This request is no longer pending, so it cannot be rejected.'
  if (/only approved requests? can be fulfilled/.test(message)) return 'This request is no longer approved, so it cannot be fulfilled.'
  if (/only fulfilled requests? can be (received|confirmed)/.test(message)) return 'This request is no longer awaiting receipt confirmation.'
  if (/only pending or approved requests? can be cancelled/.test(message)) return 'This request is no longer pending or approved, so it cannot be cancelled.'
  if (/not authorised|not authorized|permission denied|unauthori[sz]ed/.test(message)) return 'You are not authorised to perform this action.'
  if (/request not found/.test(message)) return 'This request could not be found. Refresh the list to see its current status.'
  if (/reserved stock is expired or inconsistent/.test(message)) return 'Reserved stock is expired or inconsistent. Fulfilment was not recorded; cancel the request and arrange a new one.'
  if (/reservation totals are inconsistent/.test(message)) return 'Reservation records are inconsistent. No changes were made; contact your administrator.'
  if (error?.code === '22023') return 'The request could not be changed because its current status or data is invalid. Refresh and try again.'
  if (error?.code === '23505') return 'This operation conflicts with an existing request event. Refresh the list to check the current status.'
  if (['40001', '40P01'].includes(error?.code)) return 'Another transaction changed this request. Refresh the list to check its current status.'
  if (['23514', '23503'].includes(error?.code)) return 'The request could not be changed because its data did not meet a database constraint.'
  return 'The request could not be loaded. Try refreshing the list.'
}

export function isKnownMutationError(error) {
  const code = String(error?.code || '')
  const message = String(error?.message || '').toLowerCase()
  if (['22023', '42501', 'P0002', '23514', '23503', '23505', '40001', '40P01'].includes(code)) return true
  return /insufficient.*stock|only pending requests?.*(approved|rejected)|only approved requests? can be fulfilled|only pending or approved requests? can be cancelled|not authorised|not authorized|permission denied|request not found|invalid supply request|reservation totals are inconsistent|reserved stock is expired or inconsistent/i.test(message)
}
