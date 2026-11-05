// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import RequestForm from './RequestForm.jsx'
const facility = { id:'clinic', name:'Demo Clinic' }
const draft = { supplier:{facility_id:'pharmacy',facility_name:'Demo Pharmacy',available_quantity:140,stale:false},medicine:{id:'m1',name:'Paracetamol',strength:'500 mg',dosage_form:'tablet',unit_of_measure:'tablet'},quantity:5 }
let client, onSaved, onCancel
beforeEach(() => { client={rpc:vi.fn(async()=>({data:'request-uuid',error:null}))};onSaved=vi.fn();onCancel=vi.fn();vi.spyOn(window,'confirm').mockReturnValue(true) })
afterEach(() => { cleanup();vi.restoreAllMocks() })
function setup(value=draft) { render(<RequestForm client={client} facility={facility} draft={value} onSaved={onSaved} onCancel={onCancel} />) }
describe('request confirmation', () => {
  it('submits the exact selected facility, formulation and quantity after confirmation', async () => {
    setup()
    fireEvent.change(screen.getByLabelText(/Notes to supplier/),{target:{value:'Demo replenishment'}})
    fireEvent.click(screen.getByRole('button',{name:'Send request'}))
    await waitFor(()=>expect(client.rpc).toHaveBeenCalledWith('create_supply_request',{p_requesting_facility_id:'clinic',p_supplying_facility_id:'pharmacy',p_medicine_id:'m1',p_quantity:5,p_notes:'Demo replenishment'}))
    expect(onSaved).toHaveBeenCalledWith('request-uuid')
  })
  it('does not submit when confirmation is cancelled',()=>{
    window.confirm.mockReturnValue(false);setup();fireEvent.click(screen.getByRole('button',{name:'Send request'}));expect(client.rpc).not.toHaveBeenCalled()
  })
  it('warns that stale stock is not confirmed',()=>{
    setup({...draft,supplier:{...draft.supplier,stale:true}})
    expect(screen.getByText(/stock information is stale/i)).toBeInTheDocument()
  })
  it('shows known permission errors without making a success claim',async()=>{
    client.rpc.mockResolvedValue({data:null,error:{code:'42501'}});setup();fireEvent.click(screen.getByRole('button',{name:'Send request'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('do not have permission');expect(onSaved).not.toHaveBeenCalled()
  })
  it('does not submit twice while the first request is in flight',async()=>{
    let finish
    client.rpc.mockImplementation(()=>new Promise(resolve=>{finish=resolve}))
    setup()
    const button=screen.getByRole('button',{name:'Send request'})
    fireEvent.click(button)
    fireEvent.click(button)
    expect(client.rpc).toHaveBeenCalledTimes(1)
    finish({data:'request-uuid',error:null})
    await waitFor(()=>expect(onSaved).toHaveBeenCalledTimes(1))
  })
  it('blocks retry if the network outcome is uncertain',async()=>{
    client.rpc.mockRejectedValue(new Error('network lost'));setup();fireEvent.click(screen.getByRole('button',{name:'Send request'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not confirm')
    expect(screen.getByRole('button',{name:'Send request'})).toBeDisabled()
    fireEvent.click(screen.getByRole('button',{name:'Return to requests'}));expect(onCancel).toHaveBeenCalled()
  })
  it('blocks retry when the server returns an unclassified error',async()=>{
    client.rpc.mockResolvedValue({data:null,error:{code:'',message:'fetch failed'}});setup();fireEvent.click(screen.getByRole('button',{name:'Send request'}))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not confirm')
    expect(screen.getByRole('button',{name:'Send request'})).toBeDisabled()
  })
})
