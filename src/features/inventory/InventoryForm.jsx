import { useRef, useState } from 'react'
import { inventoryError, medicineLabel, positiveInteger } from './inventory.js'

export default function InventoryForm({ client, facilityId, medicines, batch, mode, onCancel, onSaved }) {
  const [medicineId, setMedicineId] = useState(batch?.medicine_id || '')
  const [medicineEntryMode, setMedicineEntryMode] = useState('select')
  const [medicineDetails, setMedicineDetails] = useState({ name: '', genericName: '', brandName: '', activeIngredient: '', strength: '', dosageForm: '', unit: '' })
  const [batchNumber, setBatchNumber] = useState(batch?.batch_number || '')
  const [expiry, setExpiry] = useState(batch?.expiry_date || '')
  const [threshold, setThreshold] = useState(String(batch?.low_stock_threshold ?? 0))
  const [quantity, setQuantity] = useState('')
  const [direction, setDirection] = useState('add')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const editing = mode === 'edit'
  const adjusting = mode === 'adjust'
  const title = adjusting ? 'Adjust stock' : editing ? 'Edit batch details' : 'Add a batch'

  async function submit(event) {
    event.preventDefault()
    if (submitting.current) return
    setError('')
    if (adjusting && !positiveInteger(quantity)) return setError('Enter a positive whole number for the adjustment.')
    if (!adjusting && (!batchNumber.trim() || !expiry || !positiveInteger(threshold, true))) return setError('Enter a batch number, expiry date and valid low-stock threshold.')
    if (!adjusting && !editing && ((!medicineId && medicineEntryMode === 'select') || !positiveInteger(quantity, true))) return setError('Choose a catalogue medicine and enter a valid whole-number starting quantity.')
    if (!adjusting && !editing && medicineEntryMode === 'new' && Object.entries(medicineDetails).some(([key, value]) => key !== 'brandName' && !value.trim())) return setError('Enter the medicine name, generic name, active ingredient, strength, dosage form and unit.')
    const confirmation = adjusting
      ? `${direction === 'add' ? 'Add' : 'Remove'} ${quantity} units ${direction === 'add' ? 'to' : 'from'} batch ${batch.batch_number}?`
      : editing ? `Save changes to batch ${batch.batch_number}?` : `Create batch ${batchNumber.trim()} with ${quantity} units?`
    if (!window.confirm(confirmation)) return
    submitting.current = true
    setBusy(true)
    try {
      let result
      if (adjusting) {
        result = await client.rpc('adjust_inventory', { p_batch_id: batch.id, p_delta: Number(quantity) * (direction === 'add' ? 1 : -1), p_notes: notes.trim() || null })
      } else if (editing) {
        result = await client.rpc('update_inventory_batch', { p_batch_id: batch.id, p_batch_number: batchNumber.trim(), p_expiry_date: expiry, p_low_stock_threshold: Number(threshold), p_notes: notes.trim() || null })
      } else if (medicineEntryMode === 'new') {
        result = await client.rpc('create_inventory_batch_with_medicine', {
          p_facility_id: facilityId, p_medicine_name: medicineDetails.name.trim(), p_generic_name: medicineDetails.genericName.trim(),
          p_brand_name: medicineDetails.brandName.trim() || null, p_active_ingredient: medicineDetails.activeIngredient.trim(),
          p_strength: medicineDetails.strength.trim(), p_dosage_form: medicineDetails.dosageForm.trim(), p_unit_of_measure: medicineDetails.unit.trim(),
          p_batch_number: batchNumber.trim(), p_quantity: Number(quantity), p_expiry_date: expiry, p_low_stock_threshold: Number(threshold),
        })
      } else {
        result = await client.rpc('create_inventory_batch', { p_facility_id: facilityId, p_medicine_id: medicineId, p_batch_number: batchNumber.trim(), p_quantity: Number(quantity), p_expiry_date: expiry, p_low_stock_threshold: Number(threshold) })
      }
      if (result.error) setError(inventoryError(result.error))
      else onSaved(adjusting ? 'Stock adjustment saved.' : editing ? 'Batch details saved.' : 'Inventory batch created.')
    } catch {
      setError('Could not save the change. Check your connection and try again.')
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return <section className="inventory-form-panel" aria-labelledby="inventory-form-title">
    <div className="inventory-form-head"><div><p className="section-tag">{adjusting ? 'STOCK MOVEMENT' : 'BATCH DETAILS'}</p><h2 id="inventory-form-title">{title}</h2></div><button className="text-button compact" type="button" onClick={onCancel} disabled={busy}>Close</button></div>
    {batch && <p className="form-subtitle">{medicineLabel(batch.medicines)} · {batch.batch_number}</p>}
    <form onSubmit={submit} className="inventory-form">
      {!adjusting && !editing && <fieldset className="medicine-choice"><legend>Medicine formulation</legend><div className="medicine-choice-options"><label><input type="radio" name="medicine-entry-mode" value="select" checked={medicineEntryMode === 'select'} onChange={() => setMedicineEntryMode('select')} /> Select from shared catalogue</label><label><input type="radio" name="medicine-entry-mode" value="new" checked={medicineEntryMode === 'new'} onChange={() => setMedicineEntryMode('new')} /> Enter medicine details</label></div>{medicineEntryMode === 'select' ? <div className="field"><label htmlFor="medicine">Exact catalogue medicine</label><select id="medicine" value={medicineId} onChange={(e) => setMedicineId(e.target.value)} required><option value="">Select a medicine</option>{medicines.map((medicine) => <option key={medicine.id} value={medicine.id}>{medicineLabel(medicine)}{medicine.generic_name ? ` · ${medicine.generic_name}` : ''}{medicine.brand_name ? ` · ${medicine.brand_name}` : ''}</option>)}</select>{medicines.length === 0 && <small>No medicines are in the catalogue yet. Enter details to add one.</small>}</div> : <><p className="form-subtitle">All formulation details must match exactly to reuse an existing catalogue entry. No clinical equivalence is inferred.</p><div className="form-grid">{[['name','Medicine name'],['genericName','Generic name'],['brandName','Brand name'],['activeIngredient','Active ingredient'],['strength','Strength'],['dosageForm','Dosage form'],['unit','Unit']].map(([key, label]) => <div className="field" key={key}><label htmlFor={`medicine-${key}`}>{label}{key === 'brandName' && <span className="optional"> (optional)</span>}</label><input id={`medicine-${key}`} value={medicineDetails[key]} maxLength="200" onChange={(e) => setMedicineDetails((current) => ({ ...current, [key]: e.target.value }))} required={key !== 'brandName'} /></div>)}</div><small>Existing batches use the exact shared catalogue medicine ID. Different strength, dosage form, unit, ingredient or brand remains a separate entry.</small></>}</fieldset>}
      {!adjusting && <div className="form-grid"><div className="field"><label htmlFor="batch-number">Batch number</label><input id="batch-number" value={batchNumber} maxLength="100" onChange={(e) => setBatchNumber(e.target.value)} required /></div><div className="field"><label htmlFor="expiry-date">Expiry date</label><input id="expiry-date" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} required /></div></div>}
      {adjusting && <div className="field"><label htmlFor="direction">Adjustment</label><select id="direction" value={direction} onChange={(e) => setDirection(e.target.value)}><option value="add">Add stock</option><option value="remove">Remove stock</option></select><small>Reserved stock cannot be removed.</small></div>}
      {(adjusting || !editing) && <div className="field"><label htmlFor="quantity">{adjusting ? 'Quantity to adjust' : 'Starting quantity'}</label><input id="quantity" type="number" min={adjusting ? '1' : '0'} max="2147483647" step="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} required /></div>}
      {!adjusting && <div className="field"><label htmlFor="threshold">Low-stock threshold</label><input id="threshold" type="number" min="0" max="2147483647" step="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} required /><small>Alert when eligible unreserved stock is at or below this number.</small></div>}
      {(adjusting || editing) && <div className="field"><label htmlFor="notes">Reason or note <span className="optional">(optional)</span></label><textarea id="notes" value={notes} maxLength="500" onChange={(e) => setNotes(e.target.value)} rows="3" /></div>}
      {editing && batch.quantity_reserved > 0 && <p className="form-hint">Expiry cannot be changed while this batch has reserved stock.</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="form-actions"><button className="button button-primary" type="submit" disabled={busy || (!editing && !adjusting && medicineEntryMode === 'select' && !medicines.length)}>{busy ? 'Saving…' : adjusting ? 'Save adjustment' : editing ? 'Save batch' : 'Create batch'}</button><button className="button button-outline" type="button" onClick={onCancel} disabled={busy}>Cancel</button></div>
    </form>
  </section>
}
