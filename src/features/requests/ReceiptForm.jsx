import { useState } from 'react'
import { positiveInteger } from '../inventory/inventory.js'
import './receipt.css'

const emptyBatch = (id) => ({ id, batch_number: '', quantity: '', expiry_date: '' })

export default function ReceiptForm({ request, disabled, onSubmit }) {
  const [batches, setBatches] = useState([emptyBatch(0)])
  const [nextId, setNextId] = useState(1)
  const [error, setError] = useState('')
  const fulfilled = Number(request.fulfilled_quantity)
  const unit = request.medicine?.unit_of_measure || 'units'

  function update(id, name, value) {
    setBatches((current) => current.map((batch) => batch.id === id ? { ...batch, [name]: value } : batch))
    setError('')
  }

  function submit(event) {
    event.preventDefault()
    if (batches.some((batch) => !batch.batch_number.trim() || !positiveInteger(batch.quantity) || !batch.expiry_date)) {
      setError('Enter a batch number, positive whole-number quantity and expiry date for every batch.')
      return
    }
    const total = batches.reduce((sum, batch) => sum + Number(batch.quantity), 0)
    if (!Number.isInteger(fulfilled) || fulfilled <= 0 || total !== fulfilled) {
      setError(`The total received must match the ${fulfilled || 0} ${unit} recorded as fulfilled. If it differs, contact the supplier before confirming.`)
      return
    }
    const names = batches.map((batch) => batch.batch_number.trim())
    if (new Set(names).size !== names.length) {
      setError('Enter each batch number only once.')
      return
    }
    onSubmit(batches.map(({ batch_number, quantity, expiry_date }) => ({ batch_number: batch_number.trim(), quantity: Number(quantity), expiry_date })))
  }

  return <form className="receipt-form" onSubmit={submit} noValidate>
    <h4>Record received medicine</h4>
    <p>Check the medicine and enter each batch that arrived. Confirming receipt adds it to your facility’s inventory. Total to account for: {fulfilled || 0} {unit}.</p>
    {batches.map((batch, index) => <fieldset key={batch.id} disabled={disabled}>
      <legend>Batch {index + 1}</legend>
      <div className="receipt-fields">
        <label>Batch number <input aria-label={`Batch ${index + 1} number`} value={batch.batch_number} onChange={(event) => update(batch.id, 'batch_number', event.target.value)} maxLength={200} /></label>
        <label>Quantity received <input aria-label={`Batch ${index + 1} quantity received`} type="number" min="1" step="1" value={batch.quantity} onChange={(event) => update(batch.id, 'quantity', event.target.value)} /></label>
        <label>Expiry date <input aria-label={`Batch ${index + 1} expiry date`} type="date" value={batch.expiry_date} onChange={(event) => update(batch.id, 'expiry_date', event.target.value)} /></label>
      </div>
      {batches.length > 1 && <button type="button" className="button button-outline" onClick={() => { setBatches((current) => current.filter((item) => item.id !== batch.id)); setError('') }}>Remove batch {index + 1}</button>}
    </fieldset>)}
    {error && <p role="alert" className="receipt-error">{error}</p>}
    <div className="receipt-actions">
      <button type="button" className="button button-outline" disabled={disabled} onClick={() => { setBatches((current) => [...current, emptyBatch(nextId)]); setNextId((id) => id + 1); setError('') }}>Add another batch</button>
      <button type="submit" className="button button-primary" disabled={disabled} aria-label={`Confirm receipt for request ${request.id}`}>{disabled ? 'Processing…' : 'Confirm receipt and add to inventory'}</button>
    </div>
  </form>
}
