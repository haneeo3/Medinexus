// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Requests from './Requests.jsx'
import { loadSupplyRequests } from './requests.js'
import { uploadRequestPhoto, getRequestProof, downloadRequestPhoto } from './proof.js'

vi.mock('./proof.js', async (importOriginal) => ({ ...await importOriginal(), uploadRequestPhoto: vi.fn(), getRequestProof: vi.fn(), downloadRequestPhoto: vi.fn() }))

vi.mock('./RequestForm.jsx', () => ({ default: ({ onSaved, onCancel }) => <div><button onClick={onSaved}>Test save request</button><button onClick={onCancel}>Test cancel draft</button></div> }))

const facility = { id: 'f1', name: 'Local Facility' }
const medicine = { id: 'm1', name: 'Amoxicillin', strength: '500 mg', dosage_form: 'capsule', unit_of_measure: 'capsule' }
const initialRequests = [
  { id: 'req-in', requesting_facility_id: 'f2', supplying_facility_id: 'f1', medicine_id: 'm1', requested_quantity: 12, approved_quantity: null, fulfilled_quantity: 0, status: 'PENDING', request_notes: 'Urgent stock request', created_by: 'actor-requester', reviewed_by: null, created_at: '2026-11-04T10:00:00Z', updated_at: '2026-11-04T10:00:00Z', requesting_facility: { id: 'f2', name: 'North Clinic' }, supplying_facility: { id: 'f1', name: 'Local Facility' }, medicine },
  { id: 'req-out', requesting_facility_id: 'f1', supplying_facility_id: 'f3', medicine_id: 'm1', requested_quantity: 5, approved_quantity: null, fulfilled_quantity: 0, status: 'PENDING', request_notes: null, created_by: 'actor-local', reviewed_by: null, created_at: '2026-11-03T10:00:00Z', updated_at: '2026-11-03T10:00:00Z', requesting_facility: { id: 'f1', name: 'Local Facility' }, supplying_facility: { id: 'f3', name: 'West Pharmacy' }, medicine },
]
const events = [{ id: 'ev1', supply_request_id: 'req-in', event_type: 'CREATED', actor_id: 'actor-requester', previous_status: null, new_status: 'PENDING', notes: 'Urgent stock request', created_at: '2026-11-04T10:00:00Z' }, { id: 'ev2', supply_request_id: 'req-in', event_type: 'APPROVED', actor_id: 'actor-supplier', previous_status: 'PENDING', new_status: 'APPROVED', notes: null, created_at: '2026-11-04T12:00:00Z' }]
let client
let rows
let historyRows
let listError
let historyError
let queryCalls
let rpcResult

function makeClient() {
  return {
    from: vi.fn((table) => {
      const query = { filters: [], select: vi.fn(() => query), eq: vi.fn((...args) => { query.filters.push(['eq', ...args]); return query }), or: vi.fn((value) => { queryCalls.push({ table, or: value }); return query }), order: vi.fn((...args) => { queryCalls.push({ table, order: args }); return query }), range: vi.fn(async (start, end) => {
        queryCalls.push({ table, select: query.selected, filters: query.filters, range: [start, end] })
        if (table === 'supply_requests') return { data: listError ? null : rows.slice(start, end + 1), error: listError }
        const requestId = query.filters.find((filter) => filter[1] === 'supply_request_id')?.[2]
        return { data: historyError ? null : historyRows.filter((event) => event.supply_request_id === requestId).slice(start, end + 1), error: historyError }
      }) }
      query.select = vi.fn((selection) => { query.selected = selection; return query })
      return query
    }),
    rpc: vi.fn(async () => rpcResult || { data: 'request-id', error: null }),
  }
}
function renderRequests(role = 'FACILITY_ADMIN', props = {}) {
  render(<Requests client={client} facility={facility} role={role} {...props} />)
  return screen.findByText('Amoxicillin · 500 mg · capsule')
}

beforeEach(() => {
  rows = structuredClone(initialRequests)
  historyRows = structuredClone(events)
  listError = null
  historyError = null
  queryCalls = []
  rpcResult = null
  client = makeClient()
  uploadRequestPhoto.mockReset().mockResolvedValue('req-in/photo.jpg')
  getRequestProof.mockReset().mockResolvedValue({ object_path: 'req-in/photo.jpg' })
  downloadRequestPhoto.mockReset().mockResolvedValue(new Blob(['photo'], { type: 'image/jpeg' }))
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(window, 'prompt').mockReturnValue('Reviewed note')
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('supply requests', () => {
  it('loads real request rows using scoped filtering, explicit relations and stable pagination', async () => {
    await renderRequests()
    expect(screen.getByText('North Clinic')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View details · req-in' }))
    expect(screen.getByText('Urgent stock request')).toBeInTheDocument()
    expect(queryCalls.find((call) => call.table === 'supply_requests' && call.or)?.or).toBe('requesting_facility_id.eq.f1,supplying_facility_id.eq.f1')
    const listing = queryCalls.find((call) => call.table === 'supply_requests' && call.select)
    expect(listing.select).toContain('requesting_facility:facilities!supply_requests_requesting_facility_id_fkey(id,name)')
    expect(listing.select).toContain('supplying_facility:facilities!supply_requests_supplying_facility_id_fkey(id,name)')
    expect(listing.select).toContain('medicine:medicines!supply_requests_medicine_id_fkey')
    expect(queryCalls.filter((call) => call.table === 'supply_requests' && call.order).map((call) => call.order)).toEqual([['created_at', { ascending: false }], ['id', { ascending: false }]])
  })

  it('filters incoming and outgoing tabs by the current facility', async () => {
    await renderRequests()
    expect(screen.getByText('North Clinic')).toBeInTheDocument()
    expect(screen.queryByText('West Pharmacy')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Outgoing' }))
    expect(screen.getByText('West Pharmacy')).toBeInTheDocument()
    expect(screen.queryByText('North Clinic')).not.toBeInTheDocument()
  })

  it('shows supplier actions only to supplier staff and request-side cancellation to requesting staff', async () => {
    await renderRequests('SUPPLIER_STAFF')
    expect(screen.getByRole('button', { name: 'Approve request req-in' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject request req-in' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Outgoing' }))
    expect(screen.queryByRole('button', { name: 'Approve request req-out' })).not.toBeInTheDocument()
    cleanup()
    await renderRequests('REQUESTING_STAFF')
    expect(screen.queryByRole('button', { name: 'Approve request req-in' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Outgoing' }))
    expect(screen.getByRole('button', { name: 'Cancel request req-out' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject request req-out' })).not.toBeInTheDocument()
    cleanup()
    await renderRequests('INVENTORY_MANAGER')
    expect(screen.queryByRole('button', { name: /Approve request/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Cancel request/ })).not.toBeInTheDocument()
  })

  it('calls approve and fulfil RPCs with request ID arguments', async () => {
    const onBusyChange = vi.fn()
    await renderRequests('SUPPLIER_STAFF', { onBusyChange })
    fireEvent.click(screen.getByRole('button', { name: 'Approve request req-in' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('approve_supply_request', { p_request_id: 'req-in' }))
    await waitFor(() => expect(onBusyChange.mock.calls).toEqual([[true], [false]]))
    expect(await screen.findByText('Request approved and stock reserved.')).toBeInTheDocument()
    cleanup()
    rows[0].status = 'APPROVED'
    rows[0].approved_quantity = 12
    await renderRequests('SUPPLIER_STAFF')
    fireEvent.change(screen.getByLabelText('Photo of prepared medicine (required)'), { target: { files: [new File(['photo'], 'medicine.jpg', { type: 'image/jpeg' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Record fulfilment for request req-in' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('fulfil_supply_request_with_proof', { p_request_id: 'req-in', p_object_path: 'req-in/photo.jpg' }))
    expect(await screen.findByText(/Supplier fulfilment recorded/)).toBeInTheDocument()
  })

  it('requires a valid photo and does not fulfil if upload fails', async () => {
    rows[0].status = 'APPROVED'
    await renderRequests('SUPPLIER_STAFF')
    fireEvent.click(screen.getByRole('button', { name: 'Record fulfilment for request req-in' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a photo')
    expect(client.rpc).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Photo of prepared medicine (required)'), { target: { files: [new File(['x'], 'bad.txt', { type: 'text/plain' })] } })
    fireEvent.click(screen.getByRole('button', { name: 'Record fulfilment for request req-in' }))
    expect(screen.getByRole('alert')).toHaveTextContent('JPEG, PNG or WebP')
    fireEvent.change(screen.getByLabelText('Photo of prepared medicine (required)'), { target: { files: [new File(['x'], 'medicine.jpg', { type: 'image/jpeg' })] } })
    uploadRequestPhoto.mockRejectedValueOnce(new Error('Photo upload failed'))
    fireEvent.click(screen.getByRole('button', { name: 'Record fulfilment for request req-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Photo upload failed')
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('only lets requesting staff confirm a fulfilled request', async () => {
    rows[1].status = 'FULFILLED'
    await renderRequests('REQUESTING_STAFF')
    fireEvent.click(screen.getByRole('tab', { name: 'Outgoing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt for request req-out' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('confirm_supply_request_receipt', { p_request_id: 'req-out' }))
    expect(await screen.findByText('Receipt confirmed.')).toBeInTheDocument()
    cleanup()
    await renderRequests('SUPPLIER_STAFF')
    fireEvent.click(screen.getByRole('tab', { name: 'Outgoing' }))
    expect(screen.queryByRole('button', { name: 'Confirm receipt for request req-out' })).not.toBeInTheDocument()
    cleanup()
    rows[1].status = 'RECEIVED'
    await renderRequests('REQUESTING_STAFF')
    fireEvent.click(screen.getByRole('tab', { name: 'Outgoing' }))
    expect(screen.getByText('RECEIVED')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm receipt for request req-out' })).not.toBeInTheDocument()
  })

  it('loads a private fulfilment photo on demand and releases its URL', async () => {
    rows[0].status = 'FULFILLED'
    const create = vi.fn(() => 'blob:proof')
    const revoke = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
    await renderRequests()
    fireEvent.click(screen.getByRole('button', { name: 'View details · req-in' }))
    fireEvent.click(screen.getByRole('button', { name: 'View photo' }))
    expect(await screen.findByAltText('Prepared medicine supplied for this request')).toHaveAttribute('src', 'blob:proof')
    expect(getRequestProof).toHaveBeenCalledWith(client, 'req-in')
    expect(downloadRequestPhoto).toHaveBeenCalledWith(client, 'req-in/photo.jpg')
    fireEvent.click(screen.getByRole('button', { name: 'Hide photo' }))
    expect(revoke).toHaveBeenCalledWith('blob:proof')
  })

  it('allows older fulfilled requests without a photo to remain visible', async () => {
    rows[0].status = 'FULFILLED'
    getRequestProof.mockResolvedValueOnce(null)
    await renderRequests()
    fireEvent.click(screen.getByRole('button', { name: 'View details · req-in' }))
    fireEvent.click(screen.getByRole('button', { name: 'View photo' }))
    expect(await screen.findByText('No photo is available for this request.')).toBeInTheDocument()
  })

  it('calls reject and cancel RPCs with optional notes', async () => {
    await renderRequests('SUPPLIER_STAFF')
    fireEvent.click(screen.getByRole('button', { name: 'Reject request req-in' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('reject_supply_request', { p_request_id: 'req-in', p_notes: 'Reviewed note' }))
    expect(window.prompt).toHaveBeenCalledWith('Rejection note (optional):', '')
    cleanup()
    await renderRequests('REQUESTING_STAFF')
    fireEvent.click(screen.getByRole('tab', { name: 'Outgoing' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel request req-out' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('cancel_supply_request', { p_request_id: 'req-out', p_notes: 'Reviewed note' }))
    expect(window.prompt).toHaveBeenCalledWith('Cancellation note (optional):', '')
  })

  it('does not mutate when confirmation or the optional-note prompt is cancelled', async () => {
    await renderRequests('SUPPLIER_STAFF')
    window.confirm.mockReturnValue(false)
    fireEvent.click(screen.getByRole('button', { name: 'Approve request req-in' }))
    expect(client.rpc).not.toHaveBeenCalled()
    window.confirm.mockReturnValue(true)
    window.prompt.mockReturnValue(null)
    fireEvent.click(screen.getByRole('button', { name: 'Reject request req-in' }))
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('explains insufficient stock and invalid status errors without presenting them as success', async () => {
    rpcResult = { error: { code: '22023', message: 'Insufficient eligible available stock' } }
    await renderRequests('SUPPLIER_STAFF')
    fireEvent.click(screen.getByRole('button', { name: 'Approve request req-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not enough eligible stock')
    expect(screen.getByRole('button', { name: 'Approve request req-in' })).toBeEnabled()
    cleanup()
    rpcResult = { error: { code: '22023', message: 'Only pending requests can be approved' } }
    await renderRequests('SUPPLIER_STAFF')
    fireEvent.click(screen.getByRole('button', { name: 'Approve request req-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('no longer pending')
    cleanup()
    rpcResult = { error: { code: '42501', message: 'Not authorised for this request' } }
    await renderRequests('SUPPLIER_STAFF')
    fireEvent.click(screen.getByRole('button', { name: 'Approve request req-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('not authorised')
    expect(screen.getByRole('button', { name: 'Approve request req-in' })).toBeEnabled()
  })

  it('blocks actions after an uncertain outcome until a successful manual refresh', async () => {
    client.rpc.mockRejectedValue(new TypeError('Failed to fetch'))
    await renderRequests('SUPPLIER_STAFF')
    fireEvent.click(screen.getByRole('button', { name: 'Approve request req-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('operation may have completed')
    expect(screen.getByRole('button', { name: 'Approve request req-in' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve request req-in' })).toBeEnabled())
    expect(screen.queryByText('Actions remain blocked until a successful refresh confirms current request status.')).not.toBeInTheDocument()
  })

  it('loads event history with actor IDs and status changes', async () => {
    await renderRequests()
    fireEvent.click(screen.getByRole('button', { name: 'History · req-in' }))
    expect(await screen.findByText('CREATED')).toBeInTheDocument()
    expect(screen.getByText('Status: PENDING')).toBeInTheDocument()
    expect(screen.getByText('Status: PENDING → APPROVED')).toBeInTheDocument()
    expect(screen.getByText('actor-requester')).toBeInTheDocument()
    expect(screen.getByText('actor-supplier')).toBeInTheDocument()
    const historyRead = queryCalls.find((call) => call.table === 'request_events' && call.select)
    expect(historyRead.select).toContain('actor_id, previous_status, new_status, notes, created_at')
    expect(historyRead.filters).toContainEqual(['eq', 'supply_request_id', 'req-in'])
  })

  it('shows empty and retryable list and history states', async () => {
    rows = []
    render(<Requests client={client} facility={facility} role="FACILITY_ADMIN" />)
    expect(await screen.findByText('No incoming requests yet.')).toBeInTheDocument()
    cleanup()
    listError = { message: 'offline' }
    render(<Requests client={client} facility={facility} role="FACILITY_ADMIN" />)
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    cleanup()
    listError = null
    historyError = { message: 'events unavailable' }
    rows = structuredClone(initialRequests)
    await renderRequests()
    fireEvent.click(screen.getByRole('button', { name: 'History · req-in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
    expect(screen.getByRole('button', { name: 'Retry history' })).toBeInTheDocument()
  })

  it('reads every request page', async () => {
    rows = Array.from({ length: 501 }, (_, index) => ({ ...initialRequests[0], id: `page-${index}` }))
    const loaded = await loadSupplyRequests(client, facility.id)
    expect(loaded).toHaveLength(501)
    expect(queryCalls.filter((call) => call.table === 'supply_requests' && call.range).map((call) => call.range)).toEqual([[0, 499], [500, 999]])
  })

  it('closes a saved draft, refreshes the list, and displays success', async () => {
    const draft = { supplier: { facility_id: 'f3', facility_name: 'West Pharmacy', available_quantity: 10, stale: false, warnings: [] }, medicine, quantity: 2 }
    function DraftHarness() {
      const [currentDraft, setCurrentDraft] = useState(draft)
      return <Requests client={client} facility={facility} role="FACILITY_ADMIN" draft={currentDraft} onDraftCleared={() => setCurrentDraft(null)} />
    }
    render(<DraftHarness />)
    expect(screen.getByText('Test save request')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Test save request'))
    expect(await screen.findByRole('status')).toHaveTextContent('Supply request created.')
    expect(await screen.findByText('Amoxicillin · 500 mg · capsule')).toBeInTheDocument()
    expect(queryCalls.filter((call) => call.table === 'supply_requests' && call.range).length).toBeGreaterThanOrEqual(2)
  })
})
