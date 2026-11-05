// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Inventory from './Inventory.jsx'
import { batchStatus, positiveInteger } from './inventory.js'

const medicine = { id: 'm1', name: 'Example medicine', generic_name: 'Example', strength: '500 mg', dosage_form: 'tablet', unit_of_measure: 'tablet' }
const batch = { id: 'b1', facility_id: 'f1', medicine_id: 'm1', batch_number: 'LOT-1', quantity_on_hand: 10, quantity_reserved: 3, low_stock_threshold: 7, expiry_date: '2099-12-31', last_updated_at: '2026-11-05T10:00:00Z', medicines: medicine }
const expiredBatch = { ...batch, id: 'b2', batch_number: 'OLD-2', quantity_on_hand: 8, quantity_reserved: 0, low_stock_threshold: 0, expiry_date: '2000-01-01' }
const facility = { id: 'f1', name: 'Demo clinic' }
let client
beforeEach(() => {
  const data = { inventory_batches: [batch, expiredBatch], medicines: [medicine], stock_movements: [{ id:'move-1', movement_type:'INITIAL_STOCK', quantity:10, performed_by:'actor-1', notes:'demo seed', created_at:'2026-11-05T10:00:00Z', supply_request_id:null }], inventory_batch_changes: [] }
  client = { rpc: vi.fn(async () => ({ data: 'id', error: null })), from: vi.fn((table) => {
    const q = { select: () => q, eq: vi.fn(() => q), order: () => q, range: async (start, end) => ({ data: data[table].slice(start, end + 1), error: null }) }
    return q
  }) }
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

async function renderInventory(role = 'FACILITY_ADMIN') {
  render(<Inventory client={client} facility={facility} role={role} />)
  await screen.findByText('LOT-1', { exact: false })
}

describe('inventory', () => {
  it('shows recorded, reserved and eligible stock, including expired batches', async () => {
    await renderInventory()
    const row = screen.getByText('Batch: LOT-1').closest('tr')
    expect(within(row).getByText('7 eligible tablet')).toBeInTheDocument()
    expect(within(row).getByText('10 on hand · 3 reserved')).toBeInTheDocument()
    expect(within(row).getByText('Low stock')).toBeInTheDocument()
    const old = screen.getByText('Batch: OLD-2').closest('tr')
    expect(within(old).getByText('0 eligible tablet')).toBeInTheDocument()
    expect(within(old).getByText('Expired')).toBeInTheDocument()
  })
  it('searches and filters batches', async () => {
    await renderInventory()
    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'LOT-1' } })
    expect(screen.getByText('Batch: LOT-1')).toBeInTheDocument()
    expect(screen.queryByText('Batch: OLD-2')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter'), { target: { value: 'expired' } })
    expect(screen.queryByText('Batch: LOT-1')).not.toBeInTheDocument()
    expect(screen.getByText('Batch: OLD-2')).toBeInTheDocument()
  })
  it('keeps inventory read-only for requesting staff', async () => {
    await renderInventory('REQUESTING_STAFF')
    expect(screen.getByText(/Only facility administrators and inventory managers/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add batch/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Adjust batch/ })).not.toBeInTheDocument()
  })
  it('creates a batch using the authenticated RPC after confirmation', async () => {
    await renderInventory()
    fireEvent.click(screen.getByRole('button', { name: /add batch/i }))
    fireEvent.change(screen.getByLabelText('Medicine and formulation'), { target: { value: 'm1' } })
    fireEvent.change(screen.getByLabelText('Batch number'), { target: { value: 'NEW-3' } })
    fireEvent.change(screen.getByLabelText('Expiry date'), { target: { value: '2099-02-01' } })
    fireEvent.change(screen.getByLabelText('Starting quantity'), { target: { value: '15' } })
    fireEvent.change(screen.getByLabelText('Low-stock threshold'), { target: { value: '4' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create batch' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('create_inventory_batch', { p_facility_id:'f1', p_medicine_id:'m1', p_batch_number:'NEW-3', p_quantity:15, p_expiry_date:'2099-02-01', p_low_stock_threshold:4 }))
    expect(await screen.findByText('Inventory batch created.')).toBeInTheDocument()
  })
  it('does not submit when the user cancels the confirmation', async () => {
    window.confirm.mockReturnValue(false)
    await renderInventory()
    const row = screen.getByText('Batch: LOT-1').closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: 'Adjust batch LOT-1' }))
    fireEvent.change(screen.getByLabelText('Quantity to adjust'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save adjustment' }))
    expect(client.rpc).not.toHaveBeenCalled()
  })
  it('shows a server rejection when an adjustment would consume reserved stock', async () => {
    client.rpc.mockResolvedValue({ error: { code: '22023', message: 'Adjustment would violate available or reserved stock' } })
    await renderInventory()
    const row = screen.getByText('Batch: LOT-1').closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: 'Adjust batch LOT-1' }))
    fireEvent.change(screen.getByLabelText('Adjustment'), { target: { value: 'remove' } })
    fireEvent.change(screen.getByLabelText('Quantity to adjust'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save adjustment' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('reserved stock')
    expect(client.rpc).toHaveBeenCalledWith('adjust_inventory', { p_batch_id:'b1', p_delta:-8, p_notes:null })
  })
  it('saves batch metadata through the audited RPC', async () => {
    await renderInventory()
    const row = screen.getByText('Batch: LOT-1').closest('tr')
    fireEvent.click(within(row).getByRole('button', { name: 'Edit batch LOT-1' }))
    fireEvent.change(screen.getByLabelText('Batch number'), { target: { value: 'LOT-UPDATED' } })
    fireEvent.change(screen.getByLabelText(/Reason or note/), { target: { value: 'Corrected label' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save batch' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('update_inventory_batch', { p_batch_id:'b1', p_batch_number:'LOT-UPDATED', p_expiry_date:'2099-12-31', p_low_stock_threshold:7, p_notes:'Corrected label' }))
    expect(await screen.findByText('Batch details saved.')).toBeInTheDocument()
  })
  it('shows batch history including the actor and stock movement', async () => {
    await renderInventory()
    fireEvent.click(screen.getByRole('button', { name: 'History for batch LOT-1' }))
    expect(await screen.findByText('Initial stock · 10')).toBeInTheDocument()
    expect(screen.getByText('Actor ID: actor-1')).toBeInTheDocument()
    expect(screen.getByText('demo seed')).toBeInTheDocument()
  })
  it('uses inclusive expiry dates and validates integer quantities', () => {
    expect(batchStatus({ ...batch, expiry_date:'2026-11-05' }, new Date('2026-11-05T12:00:00Z')).expired).toBe(false)
    expect(batchStatus({ ...batch, expiry_date:'2026-11-04' }, new Date('2026-11-05T12:00:00Z')).eligible).toBe(0)
    expect(positiveInteger('0', true)).toBe(true)
    expect(positiveInteger('-1')).toBe(false)
    expect(positiveInteger('1.5')).toBe(false)
    expect(positiveInteger('2147483648')).toBe(false)
  })
})
