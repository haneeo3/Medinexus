// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import Discovery from './Discovery.jsx'
import { filterMedicines, findMatches } from './discovery.js'

const medicines = [
  { id:'m1', name:'Paracetamol', generic_name:'Paracetamol', active_ingredient:'Paracetamol', strength:'500 mg', dosage_form:'tablet', unit_of_measure:'tablet' },
  { id:'m2', name:'Amoxicillin', generic_name:'Amoxicillin', strength:'250 mg', dosage_form:'capsule', unit_of_measure:'capsule' },
]
const match = {
  facility_id:'s1', facility_name:'Demo Supplier', facility_type:'PHARMACY', address:'Fictional Road', verification_status:'UNVERIFIED',
  available_quantity:120, requested_quantity:100, unit_of_measure:'tablet', distance_km:5.4, last_updated_at:'2026-11-05T07:00:00Z',
  quantity_score:100, distance_score:94.6, freshness_score:91, match_score:96.6,
  reasons:['Sufficient eligible recorded quantity','Approximately 5.4 km away'], warnings:['Availability requires confirmation'], stale:false, availability_status:'REQUIRES_CONFIRMATION',
}
const partial = { ...match, facility_id:'s2', facility_name:'Small Supplier', available_quantity:25, match_score:null, reasons:['Only 25 units reported'], warnings:['Insufficient quantity'] }
const response = { medicine_id:'m1', requested_quantity:100, matches:[match], insufficient:[partial], scoring:{ quantity_weight:.5, distance_weight:.3, freshness_weight:.2, stale_after_hours:168, distance_max_km:100, missing_distance_score:50 } }
const facility = { id:'clinic-1', name:'MediNexus Demo Clinic' }
let client
beforeEach(() => {
  client = { rpc:vi.fn(async () => ({ data:response,error:null })), from:vi.fn(() => {
    const query={ select:()=>query, order:()=>query, range:async(start,end)=>({data:medicines.slice(start,end+1),error:null}) }
    return query
  }) }
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
async function renderSearch() {
  render(<Discovery client={client} facility={facility} />)
  await screen.findByLabelText('Medicine and formulation')
}
async function searchMedicine(quantity = '100') {
  fireEvent.change(screen.getByLabelText('Medicine and formulation'), { target:{value:'m1'} })
  fireEvent.change(screen.getByLabelText('Required quantity'), { target:{value:quantity} })
  fireEvent.click(screen.getByRole('button',{name:'Find suppliers'}))
}

describe('medicine discovery', () => {
  it('searches catalogue names, formulation and ingredients', () => {
    expect(filterMedicines(medicines,'para 500')).toEqual([medicines[0]])
    expect(filterMedicines(medicines,'amoxicillin capsule')).toEqual([medicines[1]])
    expect(filterMedicines(medicines,'unknown')).toEqual([])
  })
  it('calls matching for the authenticated facility and explains ranked results', async () => {
    await renderSearch()
    await searchMedicine()
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('find_medicine_matches', { p_requesting_facility_id:'clinic-1',p_medicine_id:'m1',p_requested_quantity:100 }))
    const card = (await screen.findByRole('heading',{name:'Demo Supplier'})).closest('article')
    expect(within(card).getByText('120 tablet')).toBeInTheDocument()
    expect(within(card).getByText('5.4 km')).toBeInTheDocument()
    expect(within(card).getByText('Sufficient eligible recorded quantity')).toBeInTheDocument()
    expect(within(card).getByText('Availability requires confirmation')).toBeInTheDocument()
    expect(screen.getByText(/quantity \(50%\), distance \(30%\) and freshness \(20%\)/i)).toBeInTheDocument()
    fireEvent.click(within(card).getByText('View score breakdown'))
    expect(within(card).getByText('94.6 / 100')).toBeInTheDocument()
  })
  it('separates insufficient suppliers from full matches', async () => {
    await renderSearch()
    await searchMedicine()
    const heading = await screen.findByRole('heading',{name:'Other reported stock'})
    const section = heading.closest('section')
    expect(within(section).getByRole('heading',{name:'Small Supplier'})).toBeInTheDocument()
    expect(within(section).getAllByText('Insufficient quantity').length).toBeGreaterThan(0)
    expect(within(section).queryByText('match score / 100')).not.toBeInTheDocument()
  })
  it('shows missing distance and stale-stock warnings without inventing distance', async () => {
    client.rpc.mockResolvedValue({ data:{...response,matches:[{...match,distance_km:null,stale:true,warnings:['Inventory is stale','Supplier confirmation required']}],insufficient:[]},error:null })
    await renderSearch()
    await searchMedicine()
    expect(await screen.findByText('Configured fallback used')).toBeInTheDocument()
    expect(screen.getByText('Inventory is stale')).toBeInTheDocument()
    expect(screen.getByText('Stale information')).toBeInTheDocument()
  })
  it('explains when no supplier can meet the quantity', async () => {
    client.rpc.mockResolvedValue({ data:{...response,matches:[],insufficient:[]},error:null })
    await renderSearch()
    await searchMedicine()
    expect(await screen.findByText('No supplier reports enough eligible stock.')).toBeInTheDocument()
  })
  it('shows access errors without exposing backend details', async () => {
    client.rpc.mockResolvedValue({ data:null,error:{code:'42501',message:'internal database error'} })
    await renderSearch()
    await searchMedicine()
    expect(await screen.findByRole('alert')).toHaveTextContent('Your account cannot search for this facility')
    expect(screen.queryByText('internal database error')).not.toBeInTheDocument()
  })
  it('clears stale results if the user changes the medicine while searching', async () => {
    let finish
    client.rpc.mockImplementation(() => new Promise(resolve => { finish=resolve }))
    await renderSearch()
    await searchMedicine()
    fireEvent.change(screen.getByLabelText('Search catalogue'),{target:{value:'Amoxicillin'}})
    finish({data:response,error:null})
    await waitFor(() => expect(screen.queryByRole('heading',{name:'Demo Supplier'})).not.toBeInTheDocument())
    expect(screen.getByLabelText('Medicine and formulation')).toHaveValue('')
  })
  it('offers requests only for full matches and passes the selection forward', async () => {
    const onRequest=vi.fn()
    render(<Discovery client={client} facility={facility} role="REQUESTING_STAFF" onRequest={onRequest} />)
    await screen.findByLabelText('Medicine and formulation')
    await searchMedicine()
    const full = (await screen.findByRole('heading',{name:'Demo Supplier'})).closest('article')
    fireEvent.click(within(full).getByRole('button',{name:'Request supply'}))
    expect(onRequest).toHaveBeenCalledWith({supplier:match,medicine:medicines[0],quantity:100})
    const partialCard = screen.getByRole('heading',{name:'Small Supplier'}).closest('article')
    expect(within(partialCard).queryByRole('button',{name:'Request supply'})).not.toBeInTheDocument()
  })
  it('does not offer request creation to inventory-only users', async () => {
    render(<Discovery client={client} facility={facility} role="INVENTORY_MANAGER" onRequest={vi.fn()} />)
    await screen.findByLabelText('Medicine and formulation')
    await searchMedicine()
    await screen.findByRole('heading',{name:'Demo Supplier'})
    expect(screen.queryByRole('button',{name:'Request supply'})).not.toBeInTheDocument()
  })
  it('rejects invalid quantities before calling the backend', async () => {
    await expect(findMatches(client,'clinic-1','m1','0')).rejects.toThrow(/positive whole-number/)
    expect(client.rpc).not.toHaveBeenCalled()
  })
})
