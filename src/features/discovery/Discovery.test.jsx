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
  available_quantity:120, requested_quantity:100, unit_of_measure:'tablet', last_updated_at:'2026-11-05T07:00:00Z',
  quantity_score:100, freshness_score:91, match_score:97.4,
  reasons:['Sufficient eligible recorded quantity'], warnings:['Availability requires confirmation'], stale:false, availability_status:'REQUIRES_CONFIRMATION',
}
const partial = { ...match, facility_id:'s2', facility_name:'Small Supplier', available_quantity:25, match_score:null, reasons:['Only 25 units reported'], warnings:['Insufficient quantity'] }
const response = { medicine_id:'m1', requested_quantity:100, matches:[match], insufficient:[partial], scoring:{ quantity_weight:.71429, freshness_weight:.28571, stale_after_hours:168 } }
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
    expect(within(card).getByText(/Fictional Road/)).toBeInTheDocument()
    expect(within(card).queryByText(/distance|coordinates| km/i)).not.toBeInTheDocument()
    expect(within(card).getByText('Sufficient eligible recorded quantity')).toBeInTheDocument()
    expect(within(card).getByText('Availability requires confirmation')).toBeInTheDocument()
    expect(screen.getByText(/quantity \(71\.429%\) and freshness \(28\.571%\)/i)).toBeInTheDocument()
    fireEvent.click(within(card).getByText('View score breakdown'))
    expect(within(card).getByText('91.0 / 100')).toBeInTheDocument()
    expect(within(card).queryByText('Distance')).not.toBeInTheDocument()
  })
  it('shows current reviewed verification and facility image from the directory', async () => {
    client.from.mockImplementation(() => {
      const query = { select: () => query, order: () => query, range: async (start, end) => ({ data: medicines.slice(start, end + 1), error: null }), in: async () => ({ data: [{ id: 's1', image_url: 'https://example.test/facility.jpg', verification_status: 'VERIFIED', facility_type_details: 'Dispensing and retail' }, { id: 's2', image_url: null, verification_status: 'UNVERIFIED' }], error: null }) }
      return query
    })
    await renderSearch(); await searchMedicine()
    const card = (await screen.findByRole('heading', { name: 'Demo Supplier' })).closest('article')
    expect(await within(card).findByText(/Verified by MediNexus/)).toBeInTheDocument()
    expect(within(card).getByText('Services: Dispensing and retail')).toBeInTheDocument()
    const photo = within(card).getByRole('img', { name: 'Demo Supplier facility' })
    expect(photo).toHaveAttribute('src', 'https://example.test/facility.jpg')
    fireEvent.error(photo)
    expect(within(card).getByLabelText('Facility photo unavailable')).toBeInTheDocument()
    const partialCard = screen.getByRole('heading', { name: 'Small Supplier' }).closest('article')
    expect(within(partialCard).getByText(/Unverified/)).toBeInTheDocument()
    expect(within(partialCard).getByLabelText('Facility photo unavailable')).toBeInTheDocument()
  })
  it('does not trust a stale matching badge when directory lookup fails', async () => {
    client.rpc.mockResolvedValue({ data: { ...response, matches: [{ ...match, verification_status: 'VERIFIED' }] }, error: null })
    await renderSearch(); await searchMedicine()
    const card = (await screen.findByRole('heading', { name: 'Demo Supplier' })).closest('article')
    expect(within(card).getByText(/Unverified/)).toBeInTheDocument()
    expect(within(card).queryByText(/Verified by MediNexus/)).not.toBeInTheDocument()
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
  it('shows stale-stock warnings without distance information', async () => {
    client.rpc.mockResolvedValue({ data:{...response,matches:[{...match,stale:true,warnings:['Inventory is stale','Supplier confirmation required']}],insufficient:[]},error:null })
    await renderSearch()
    await searchMedicine()
    expect(await screen.findByText('Inventory is stale')).toBeInTheDocument()
    expect(screen.getByText('Stale information')).toBeInTheDocument()
    expect(screen.queryByText(/distance|coordinates/i)).not.toBeInTheDocument()
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
  it('searches recorded supplier stock after selecting an AI-suggested catalogue medicine', async () => {
    client.auth = { getSession: vi.fn(async () => ({ data: { session: { access_token: 'token' } }, error: null })) }
    client.rpc.mockResolvedValue({ data: { ...response, requested_quantity: 20, matches: [{ ...match, requested_quantity: 20, unit_of_measure: 'capsule' }], insufficient: [] }, error: null })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ fields: { medicineName: 'Amoxicillin', genericName: null, brandName: null, activeIngredient: null, strength: '250 mg', dosageForm: 'capsule', unit: 'capsule', quantity: 20 } }) })
    await renderSearch()
    fireEvent.change(screen.getByLabelText('Medicine description'), { target: { value: '20 amoxicillin 250 mg capsules' } })
    fireEvent.click(screen.getByRole('button', { name: 'Read medicine details' }))
    expect(await screen.findByRole('button', { name: 'Find reported supplier stock' })).toBeDisabled()
    expect(client.rpc).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Choose the exact medicine from the shared catalogue'), { target: { value: 'm2' } })
    expect(screen.getByLabelText('Catalogue medicine details')).toHaveTextContent('250 mg')
    fireEvent.click(screen.getByRole('button', { name: 'Find reported supplier stock' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('find_medicine_matches', { p_requesting_facility_id: 'clinic-1', p_medicine_id: 'm2', p_requested_quantity: 20 }))
    expect(await screen.findByRole('heading', { name: 'Demo Supplier' })).toBeInTheDocument()
    expect(screen.getByLabelText('Matched catalogue medicine details')).toHaveTextContent('250 mg')
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
