import { useRef, useState } from 'react'
import { filterMedicines } from './discovery.js'
import { medicineLabel } from '../inventory/inventory.js'

const LABELS = [
  ['medicineName', 'Medicine name'], ['genericName', 'Generic name'],
  ['brandName', 'Brand name'], ['activeIngredient', 'Active ingredient'],
  ['strength', 'Strength'], ['dosageForm', 'Form'], ['unit', 'Unit'], ['quantity', 'Quantity'],
]

export default function AiMedicineSearch({ client, catalogue, onSearch, onClear, searchError, searching }) {
  const [query, setQuery] = useState('')
  const [fields, setFields] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [medicineId, setMedicineId] = useState('')
  const [quantity, setQuantity] = useState('')
  const generation = useRef(0)

  async function interpret(event) {
    event.preventDefault()
    if (busy || !query.trim()) return
    const current = ++generation.current
    setBusy(true); setError(''); setFields(null); setMedicineId(''); setQuantity('')
    try {
      const { data, error: sessionError } = await client.auth.getSession()
      if (sessionError || !data?.session?.access_token) throw new Error('Please sign in again to use AI search.')
      const response = await fetch('/.netlify/functions/parse-medicine-search', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ query: query.trim() }),
      })
      let payload
      try { payload = await response.json() } catch { throw new Error('AI search is unavailable. Use the regular catalogue search.') }
      if (!response.ok) throw new Error(payload?.error || 'AI search is unavailable. Use the regular catalogue search.')
      if (!payload?.fields || typeof payload.fields !== 'object') throw new Error('AI search could not read that request. Please try again.')
      if (generation.current === current) { setFields(payload.fields); setQuantity(payload.fields.quantity == null ? '' : String(payload.fields.quantity)) }
    } catch (err) { if (generation.current === current) setError(err.message || 'AI search is unavailable. Use the regular catalogue search.') }
    finally { if (generation.current === current) setBusy(false) }
  }
  const searchName = fields?.medicineName || fields?.genericName || fields?.activeIngredient || fields?.brandName || ''
  const candidates = searchName ? filterMedicines(catalogue, searchName) : []
  const selected = candidates.find((medicine) => medicine.id === medicineId)
  return <section className="ai-search" aria-labelledby="ai-search-title">
    <div><p className="section-tag">OPTIONAL AI-ASSISTED SEARCH</p><h2 id="ai-search-title">Describe the medicine you need</h2><p>For example: Find 20 amoxicillin 250 mg capsules. Your text is sent to Groq; do not include patient information.</p></div>
    <form onSubmit={interpret}>
      <div className="field"><label htmlFor="ai-medicine-query">Medicine description</label><textarea id="ai-medicine-query" rows="2" maxLength="500" value={query} onChange={(event) => { generation.current += 1; onClear(); setQuery(event.target.value); setFields(null); setError(''); setBusy(false) }} placeholder="Medicine, strength, form and quantity" /></div>
      <button className="button button-outline" type="submit" disabled={busy || !query.trim()}>{busy ? 'Reading details…' : 'Read medicine details'}</button>
    </form>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {fields && <div className="ai-review"><h3>What you asked for</h3><p>These are details read from your search, not supplier stock. AI can make mistakes.</p><dl>{LABELS.filter(([key]) => fields[key] != null).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{fields[key]}</dd></div>)}</dl>
      {!searchName ? <p>Enter a medicine name or ingredient and try again, or use the regular search below.</p> : candidates.length === 0 ? <p>No catalogue medicines match this name. Try another name or use the regular search below.</p> : <form className="ai-catalogue-form" onSubmit={(event) => { event.preventDefault(); if (medicineId && quantity) onSearch({ medicineId, quantity }) }}>
        <div className="field"><label htmlFor="ai-catalogue-medicine">Choose the exact medicine from the shared catalogue</label><select id="ai-catalogue-medicine" value={medicineId} onChange={(event) => { onClear(); setMedicineId(event.target.value) }} required><option value="">Select a medicine</option>{candidates.map((medicine) => <option key={medicine.id} value={medicine.id}>{medicineLabel(medicine)}{medicine.brand_name ? ` · ${medicine.brand_name}` : ''} · {medicine.unit_of_measure}</option>)}</select><small>Catalogue entries are recorded by facilities; they do not guarantee stock.</small></div>
        {selected && <div className="selected-medicine-details" aria-label="Catalogue medicine details"><strong>Check the actual catalogue entry</strong><p>Medicine: {selected.name || 'Not recorded'} · Generic: {selected.generic_name || 'Not recorded'} · Brand: {selected.brand_name || 'Not recorded'} · Active ingredient: {selected.active_ingredient || 'Not recorded'} · Strength: {selected.strength || 'Not recorded'} · Form: {selected.dosage_form || 'Not recorded'} · Unit: {selected.unit_of_measure || 'Not recorded'}</p></div>}
        <div className="field"><label htmlFor="ai-requested-quantity">Quantity needed</label><input id="ai-requested-quantity" type="number" min="1" max="2147483647" step="1" value={quantity} onChange={(event) => { onClear(); setQuantity(event.target.value) }} required /><small>In the selected catalogue medicine's unit.</small></div>
        {searchError && <p role="alert" className="notice notice-error">{searchError}</p>}<p>Supplier results appear below the search forms.</p>
        <button className="button button-primary" type="submit" disabled={!selected || searching}>{searching ? 'Finding suppliers…' : 'Find reported supplier stock'}</button>
      </form>}
    </div>}
  </section>
}
