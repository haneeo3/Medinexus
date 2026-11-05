// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import AiMedicineSearch from './AiMedicineSearch.jsx'

const client = { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'user-token' } }, error: null })) } }
const fields = { medicineName: 'amoxicillin', genericName: null, brandName: null, activeIngredient: null, strength: '250 mg', dosageForm: 'capsule', unit: 'capsule', quantity: 20 }
const catalogue = [{ id:'m1', name:'Amoxicillin', generic_name:'Amoxicillin', active_ingredient:'Amoxicillin', brand_name:'Supplier Brand', strength:'250 mg', dosage_form:'capsule', unit_of_measure:'capsule' }]
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('AI medicine search', () => {
  it('shows catalogue details and requires a choice before searching', async () => {
    const onSearch = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ fields }) })))
    render(<AiMedicineSearch client={client} catalogue={catalogue} onSearch={onSearch} onClear={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Medicine description'), { target: { value: '20 amoxicillin 250 mg capsules' } })
    fireEvent.click(screen.getByRole('button', { name: 'Read medicine details' }))
    expect(await screen.findByText('What you asked for')).toBeInTheDocument()
    expect(screen.getByText(/not supplier stock/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Find reported supplier stock' })).toBeDisabled()
    expect(onSearch).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Choose the exact medicine from the shared catalogue'), { target: { value: 'm1' } })
    expect(screen.getByLabelText('Catalogue medicine details')).toHaveTextContent('Supplier Brand')
    fireEvent.click(screen.getByRole('button', { name: 'Find reported supplier stock' }))
    expect(onSearch).toHaveBeenCalledWith({ medicineId: 'm1', quantity: '20' })
  })
  it('does not offer a supplier search for a medicine absent from the catalogue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ fields: { ...fields, medicineName: 'Unknown medicine' } }) })))
    render(<AiMedicineSearch client={client} catalogue={catalogue} onSearch={vi.fn()} onClear={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Medicine description'), { target: { value: 'Unknown medicine' } })
    fireEvent.click(screen.getByRole('button', { name: 'Read medicine details' }))
    expect(await screen.findByText(/No catalogue medicines match/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Find reported supplier stock' })).not.toBeInTheDocument()
  })
  it('shows an error and preserves manual search when the service is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ error: 'AI search is not configured yet. Use the regular catalogue search.' }) })))
    render(<AiMedicineSearch client={client} catalogue={catalogue} onSearch={vi.fn()} onClear={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Medicine description'), { target: { value: 'Amoxicillin' } })
    fireEvent.click(screen.getByRole('button', { name: 'Read medicine details' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('regular catalogue search'))
  })
})
