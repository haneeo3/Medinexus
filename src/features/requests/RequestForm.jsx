import { useRef, useState } from 'react'
import { medicineLabel, positiveInteger } from '../inventory/inventory.js'

function knownError(error) {
  if (error?.code === '42501') return 'You do not have permission to create this request.'
  if (error?.code === '22023' || error?.code === 'P0002' || error?.code === '23503') return 'The supplier, medicine or quantity is no longer valid. Search again.'
  return null
}

export default function RequestForm({ client, facility, draft, onSaved, onCancel, onBusyChange = () => {} }) {
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const submitting = useRef(false)
  const { supplier, medicine, quantity } = draft

  async function submit(event) {
    event.preventDefault()
    if (submitting.current || uncertain) return
    setError('')
    if (!supplier?.facility_id || !medicine?.id || !positiveInteger(quantity)) {
      setError('The match is incomplete. Return to medicine search and try again.')
      return
    }
    if (!window.confirm(`Send a request for ${quantity} ${medicine.unit_of_measure} to ${supplier.facility_name}? Reported stock is not reserved until the supplier approves.`)) return
    submitting.current = true
    onBusyChange(true)
    setBusy(true)
    try {
      const { data, error: rpcError } = await client.rpc('create_supply_request', {
        p_requesting_facility_id: facility.id,
        p_supplying_facility_id: supplier.facility_id,
        p_medicine_id: medicine.id,
        p_quantity: Number(quantity),
        p_notes: notes.trim() || null,
      })
      if (rpcError) {
        const message = knownError(rpcError)
        if (message) setError(message)
        else { setUncertain(true); setError('We could not confirm whether the request was sent. Return to the requests list and refresh before trying again.') }
      } else if (!data) {
        setUncertain(true)
        setError('We could not confirm whether the request was sent. Return to the requests list and refresh before trying again.')
      } else onSaved(data)
    } catch {
      setUncertain(true)
      setError('We could not confirm whether the request was sent. Return to the requests list and refresh before trying again.')
    } finally {
      submitting.current = false
      onBusyChange(false)
      setBusy(false)
    }
  }

  return <section className="request-form-panel" aria-labelledby="request-form-title">
    <div className="request-form-header"><div><p className="section-tag">NEW SUPPLY REQUEST</p><h2 id="request-form-title">Review your request</h2></div><button className="text-button compact" type="button" onClick={onCancel} disabled={busy}>Close</button></div>
    <p className="request-form-copy">Stock is reported, not guaranteed. The supplier must review and approve the request before stock is reserved.</p>
    <dl className="request-review"><div><dt>Requesting facility</dt><dd>{facility.name}</dd></div><div><dt>Supplier</dt><dd>{supplier?.facility_name}</dd></div><div><dt>Medicine</dt><dd>{medicineLabel(medicine)}</dd></div><div><dt>Quantity requested</dt><dd>{quantity} {medicine?.unit_of_measure}</dd></div><div><dt>Stock reported at search</dt><dd>{supplier?.available_quantity} {medicine?.unit_of_measure}</dd></div></dl>
    {supplier?.stale && <p className="request-caution">The supplier’s stock information is stale. Availability requires confirmation.</p>}
    <form onSubmit={submit} className="request-create-form"><div className="field"><label htmlFor="request-notes">Notes to supplier <span className="optional">(optional)</span></label><textarea id="request-notes" rows="3" maxLength="500" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Add context for the supplier" /></div>
      <p className="request-form-hint">To change the medicine, supplier or quantity, return to Find medicine and search again.</p>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || uncertain}>{busy ? 'Sending…' : 'Send request'}</button><button className="button button-outline" type="button" onClick={onCancel} disabled={busy}>{uncertain ? 'Return to requests' : 'Cancel'}</button></div>
    </form>
  </section>
}
