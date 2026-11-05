// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Dashboard from './Dashboard.jsx'
import { inventorySignals, loadDashboard, recentActivity } from './dashboard.js'

const facility = { id: 'f1', name: 'Harbour Clinic' }
const medicine = { id: 'm1', name: 'Amoxicillin', strength: '500 mg', dosage_form: 'capsule', unit_of_measure: 'capsule' }
const batches = [
  { id: 'b1', facility_id: 'f1', medicine_id: 'm1', batch_number: 'LOT-LOW', quantity_on_hand: 10, quantity_reserved: 8, low_stock_threshold: 3, expiry_date: '2026-12-01', last_updated_at: '2026-11-05T10:00:00Z', medicines: medicine },
  { id: 'b2', facility_id: 'f1', medicine_id: 'm1', batch_number: 'LOT-SOON', quantity_on_hand: 30, quantity_reserved: 0, low_stock_threshold: 2, expiry_date: '2026-11-25', last_updated_at: '2026-11-05T10:00:00Z', medicines: medicine },
]
const requests = [
  { id: 'req-in', requesting_facility_id: 'f2', supplying_facility_id: 'f1', medicine_id: 'm1', requested_quantity: 12, status: 'PENDING', created_at: '2026-11-04T10:00:00Z', requesting_facility: { id: 'f2', name: 'North Clinic' }, supplying_facility: facility, medicine },
  { id: 'req-out', requesting_facility_id: 'f1', supplying_facility_id: 'f3', medicine_id: 'm1', requested_quantity: 5, status: 'PENDING', created_at: '2026-11-03T10:00:00Z', requesting_facility: facility, supplying_facility: { id: 'f3', name: 'West Pharmacy' }, medicine },
]
const movements = [{ id: 'move-1', inventory_batch_id: 'b1', movement_type: 'ADJUSTMENT_IN', quantity: 4, created_at: '2026-11-05T09:00:00Z' }]
const events = [{ id: 'event-1', supply_request_id: 'req-in', event_type: 'CREATED', created_at: '2026-11-05T10:00:00Z' }]

function makeClient(overrides = {}) {
  const source = { inventory_batches: batches, supply_requests: requests, stock_movements: movements, request_events: events, ...overrides }
  const calls = []
  const client = { from: vi.fn((table) => {
    const query = { table, filters: [], select: vi.fn(() => query), eq: vi.fn((...args) => { query.filters.push(['eq', ...args]); return query }), or: vi.fn((...args) => { query.filters.push(['or', ...args]); return query }), in: vi.fn((...args) => { query.filters.push(['in', ...args]); return query }), order: vi.fn(() => query), range: async (start, end) => {
      calls.push({ table, filters: query.filters, range: [start, end] })
      const rejection = source[`${table}_reject`]
      if (rejection) throw rejection
      const error = source[`${table}_error`]
      if (error) return { data: null, error }
      let rows = source[table] || []
      if (table === 'request_events') rows = rows.filter((row) => query.filters.some((filter) => filter[0] === 'in' && filter[1] === 'supply_request_id' && filter[2].includes(row.supply_request_id)))
      return { data: rows.slice(start, end + 1), error: null }
    } }
    return query
  }) }
  return { client, calls }
}

const fixedNow = new Date('2026-11-05T12:00:00Z')
afterEach(() => cleanup())

describe('dashboard data', () => {
  it('uses inclusive expiry and available stock after reservations', () => {
    expect(inventorySignals(batches[0], fixedNow)).toMatchObject({ low: true, expiring: true, eligible: 2 })
    expect(inventorySignals(batches[1], fixedNow)).toMatchObject({ low: false, expiring: true })
    expect(inventorySignals({ ...batches[1], expiry_date: '2026-11-04' }, fixedNow)).toMatchObject({ expired: true, expiring: false, eligible: 0 })
  })

  it('loads only current-facility inventory, requests, movements, and their request events', async () => {
    const { client, calls } = makeClient()
    const result = await loadDashboard(client, facility.id)
    expect(calls.find((call) => call.table === 'inventory_batches').filters).toContainEqual(['eq', 'facility_id', 'f1'])
    expect(calls.find((call) => call.table === 'supply_requests').filters).toContainEqual(['or', 'requesting_facility_id.eq.f1,supplying_facility_id.eq.f1'])
    expect(calls.find((call) => call.table === 'stock_movements').filters).toContainEqual(['eq', 'facility_id', 'f1'])
    expect(calls.find((call) => call.table === 'request_events').filters).toContainEqual(['in', 'supply_request_id', ['req-in', 'req-out']])
    expect(result).toMatchObject({ batches, requests, movements, events })
  })

  it('combines and sorts request events and stock movements into recent activity', () => {
    expect(recentActivity({ batches, requests, movements, events }, facility.id)).toEqual([
      { id: 'event-event-1', createdAt: '2026-11-05T10:00:00Z', title: 'Request created', detail: 'Amoxicillin · 500 mg · capsule · 12 capsule · From North Clinic' },
      { id: 'movement-move-1', createdAt: '2026-11-05T09:00:00Z', title: 'Stock increased', detail: 'Amoxicillin · 500 mg · capsule · 4 capsule · Batch LOT-LOW' },
    ])
  })
})

describe('facility dashboard screen', () => {
  it.each([
    ['PHARMACY', ['Manage inventory', 'Review incoming requests'], 'Find medicine'],
    ['CLINIC', ['Find medicine', 'Review outgoing requests'], 'Manage inventory'],
    ['HOSPITAL', ['Find medicine', 'Manage inventory'], 'Supply requests'],
  ])('highlights %s priorities while keeping all tools available', async (facility_type, priorityLabels, sharedLabel) => {
    const onNavigate = vi.fn()
    render(<Dashboard client={makeClient().client} facility={{ ...facility, facility_type }} onNavigate={onNavigate} />)
    expect(screen.getByRole('heading', { name: /priorities/i })).toBeInTheDocument()
    for (const label of [...priorityLabels, sharedLabel]) expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: priorityLabels[0] }))
    const pageByLabel = { 'Manage inventory': 'inventory', 'Review incoming requests': 'requests', 'Review outgoing requests': 'requests', 'Find medicine': 'discovery', 'Supply requests': 'requests' }
    expect(onNavigate).toHaveBeenCalledWith(pageByLabel[priorityLabels[0]])
  })

  it('keeps the existing dashboard fallback when facility type is missing', async () => {
    const { client } = makeClient()
    render(<Dashboard client={client} facility={facility} />)
    expect(screen.queryByRole('region', { name: /priorities/i })).not.toBeInTheDocument()
    expect(screen.getByText('FACILITY OVERVIEW')).toBeInTheDocument()
    expect(await screen.findByText('Batch LOT-LOW · 2 / 3 capsule available / threshold')).toBeInTheDocument()
  })

  it('allows priority actions when the optional navigation callback is unavailable', () => {
    render(<Dashboard client={makeClient().client} facility={{ ...facility, facility_type: 'CLINIC' }} />)
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Find medicine' }))).not.toThrow()
  })
  it('shows real stock and incoming/outgoing request summaries', async () => {
    const { client } = makeClient()
    render(<Dashboard client={client} facility={facility} />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading facility dashboard')
    expect(await screen.findByText('Batch LOT-LOW · 2 / 3 capsule available / threshold')).toBeInTheDocument()
    expect(screen.getAllByText(/North Clinic/)).toHaveLength(2)
    expect(screen.getByText(/To West Pharmacy/)).toBeInTheDocument()
    expect(screen.getByText('Request created')).toBeInTheDocument()
    const metrics = screen.getByRole('region', { name: 'Facility stock and request summary' })
    expect(within(metrics).getByText('2')).toBeInTheDocument()
    expect(within(metrics).getAllByText('1')).toHaveLength(3)
  })

  it('shows explicit empty states when the facility has no records', async () => {
    const { client } = makeClient({ inventory_batches: [], supply_requests: [], stock_movements: [], request_events: [] })
    render(<Dashboard client={client} facility={facility} />)
    expect(await screen.findByText('No low-stock batches at this facility.')).toBeInTheDocument()
    expect(screen.getByText('No batches are approaching expiry.')).toBeInTheDocument()
    expect(screen.getByText('No pending incoming requests.')).toBeInTheDocument()
    expect(screen.getByText('No recent inventory or request activity.')).toBeInTheDocument()
  })

  it('shows an error state when a database read promise rejects', async () => {
    const { client } = makeClient({ inventory_batches_reject: new Error('offline') })
    render(<Dashboard client={client} facility={facility} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load the facility dashboard')
  })

  it('offers retry when a dashboard read fails', async () => {
    const { client } = makeClient({ inventory_batches_error: { message: 'offline' } })
    render(<Dashboard client={client} facility={facility} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load the facility dashboard')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(client.from).toHaveBeenCalledTimes(6))
  })
})
