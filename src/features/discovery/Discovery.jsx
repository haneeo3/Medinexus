import { useEffect, useMemo, useRef, useState } from 'react'
import { medicineLabel } from '../inventory/inventory.js'
import { filterMedicines, findMatches, loadMedicineCatalogue } from './discovery.js'
import './discovery.css'

function percent(value) {
  const number = Number(value) * 100
  return new Intl.NumberFormat('en-GB', { maximumFractionDigits: 3 }).format(number)
}
function timestamp(value) {
  return value ? new Intl.DateTimeFormat('en-GB', { dateStyle:'medium', timeStyle:'short' }).format(new Date(value)) : 'Unavailable'
}
function SupplierCard({ item, rank, partial, canRequest, onRequest }) {
  return <article className={`supplier-card ${partial ? 'supplier-partial' : ''}`}>
    <div className="supplier-top"><div className="supplier-title"><span className="supplier-rank">{partial ? '—' : `#${rank}`}</span><div><h3>{item.facility_name}</h3><p>{item.facility_type?.toLowerCase()} · {item.address}</p></div></div>{partial ? <span className="badge badge-warning">Insufficient quantity</span> : <div className="match-score"><strong>{Number(item.match_score).toFixed(1)}</strong><span>match score / 100</span></div>}</div>
    <div className="supplier-facts"><div><span>Reported eligible stock</span><strong>{item.available_quantity} {item.unit_of_measure}</strong><small>Requested: {item.requested_quantity}</small></div><div><span>Approximate distance</span><strong>{item.distance_km == null ? 'Unavailable' : `${Number(item.distance_km).toFixed(1)} km`}</strong><small>{item.distance_km == null ? (partial ? 'Coordinates unavailable' : 'Configured fallback used') : 'Straight-line estimate'}</small></div><div><span>Oldest eligible stock update</span><strong>{timestamp(item.last_updated_at)}</strong><small>{item.stale ? 'Stale information' : 'Reported by facility'}</small></div></div>
    <div className="supplier-explanation"><strong>{partial ? 'Why this is separate' : 'Why this facility matched'}</strong><ul>{(item.reasons || []).map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul></div>
    {!partial && <details className="score-details"><summary>View score breakdown</summary><div><span>Quantity <strong>{Number(item.quantity_score).toFixed(1)} / 100</strong></span><span>Distance <strong>{Number(item.distance_score).toFixed(1)} / 100</strong></span><span>Freshness <strong>{Number(item.freshness_score).toFixed(1)} / 100</strong></span></div></details>}
    {(item.warnings || []).length > 0 && <div className="match-warnings"><strong>Important</strong><ul>{item.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></div>}
    <p className="supplier-verification">Platform verification: {item.verification_status?.toLowerCase() || 'unknown'} · Reported stock requires supplier confirmation.</p>
    {!partial && canRequest && <button className="button button-primary supplier-request" type="button" onClick={onRequest}>Request supply</button>}
  </article>
}

export default function Discovery({ client, facility, role, onRequest }) {
  const canRequest = role === 'FACILITY_ADMIN' || role === 'REQUESTING_STAFF'
  const [catalogue, setCatalogue] = useState(null)
  const [catalogueError, setCatalogueError] = useState('')
  const [catalogueRetry, setCatalogueRetry] = useState(0)
  const [search, setSearch] = useState('')
  const [medicineId, setMedicineId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const requestNumber = useRef(0)

  useEffect(() => {
    let active = true
    loadMedicineCatalogue(client).then((data) => { if (active) { setCatalogue(data); setCatalogueError('') } })
      .catch(() => { if (active) setCatalogueError('Could not load the medicine catalogue. Please try again.') })
    return () => { active = false }
  }, [client, catalogueRetry])
  useEffect(() => () => { requestNumber.current += 1 }, [])
  const filtered = useMemo(() => catalogue ? filterMedicines(catalogue, search) : [], [catalogue, search])
  function clearResults() { requestNumber.current += 1; setResult(null); setError(''); setBusy(false) }

  async function submit(event) {
    event.preventDefault()
    if (busy) return
    const selected = catalogue?.find((medicine) => medicine.id === medicineId)
    const number = ++requestNumber.current
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const data = await findMatches(client, facility.id, medicineId, quantity)
      if (requestNumber.current === number) setResult({ data, selected })
    } catch (err) {
      if (requestNumber.current === number) setError(err.message)
    } finally {
      if (requestNumber.current === number) setBusy(false)
    }
  }
  return <section className="discovery-page" aria-labelledby="discovery-title">
    <div className="discovery-heading"><div><p className="section-tag">MEDICINE DISCOVERY</p><h1 id="discovery-title">Find medicine across your network.</h1><p>Search reported stock at other participating facilities.</p></div></div>
    <div className="discovery-notice"><strong>Reported availability, not a guarantee.</strong> Stock requires supplier confirmation. Matching does not assess medicine quality or clinical suitability.</div>
    {facility.name.startsWith('MediNexus Demo ') && <p className="demo-note">Demo facilities, stock and any demo locations are fictional.</p>}
    {catalogueError && <div className="inventory-state"><p role="alert">{catalogueError}</p><button className="button button-outline" type="button" onClick={() => { setCatalogueError(''); setCatalogueRetry((n) => n + 1) }}>Try again</button></div>}
    {!catalogue && !catalogueError && <p className="inventory-state" role="status">Loading medicine catalogue…</p>}
    {catalogue && <form className="discovery-form" onSubmit={submit}>
      <div className="discovery-form-title"><div><p className="section-tag">SEARCH THE NETWORK</p><h2>What medicine do you need?</h2></div></div>
      <div className="discovery-form-grid"><div className="field"><label htmlFor="medicine-search">Search catalogue</label><input id="medicine-search" placeholder="Name, ingredient or strength" value={search} onChange={(e) => { clearResults(); setSearch(e.target.value); setMedicineId('') }} /></div><div className="field"><label htmlFor="medicine-select">Medicine and formulation</label><select id="medicine-select" value={medicineId} onChange={(e) => { clearResults(); setMedicineId(e.target.value) }} required><option value="">Select a medicine</option>{filtered.map((medicine) => <option value={medicine.id} key={medicine.id}>{medicineLabel(medicine)}</option>)}</select><small>{filtered.length === 0 ? 'No catalogue medicines match your search.' : `${filtered.length} formulation${filtered.length === 1 ? '' : 's'} found`}</small></div><div className="field"><label htmlFor="requested-quantity">Required quantity</label><input id="requested-quantity" type="number" min="1" max="2147483647" step="1" value={quantity} onChange={(e) => { clearResults(); setQuantity(e.target.value) }} required /><small>In the selected medicine’s unit</small></div></div>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <button className="button button-primary discovery-submit" type="submit" disabled={busy || !medicineId}>{busy ? 'Finding suppliers…' : 'Find suppliers'} <span aria-hidden="true">→</span></button>
    </form>}
    {result && <section className="match-results" aria-labelledby="match-results-title">
      <div className="match-heading"><div><p className="section-tag">MATCH RESULTS</p><h2 id="match-results-title">{medicineLabel(result.selected)}</h2><p>Requested quantity: {result.data.requested_quantity} {result.selected?.unit_of_measure || 'units'}</p></div><span className="result-count">{result.data.matches.length} full match{result.data.matches.length === 1 ? '' : 'es'}</span></div>
      {result.data.scoring && <div className="scoring-note"><strong>How ranking works</strong><p>Eligible suppliers are ranked by quantity ({percent(result.data.scoring.quantity_weight)}%), distance ({percent(result.data.scoring.distance_weight)}%) and freshness ({percent(result.data.scoring.freshness_weight)}%). Full matches have a quantity score of 100 because it is capped at the requested quantity. Distance scores fall to zero at {result.data.scoring.distance_max_km} km; missing distances use the configured fallback of {result.data.scoring.missing_distance_score} / 100. Freshness declines to zero at {result.data.scoring.stale_after_hours} hours, when stock is also flagged as stale.</p></div>}
      {result.data.matches.length === 0 ? <div className="discovery-empty"><strong>No supplier reports enough eligible stock.</strong><p>Try a different quantity or medicine. Insufficient quantities, if any, are shown separately below.</p></div> : <div className="supplier-list">{result.data.matches.map((item, index) => <SupplierCard key={item.facility_id} item={item} rank={index + 1} canRequest={canRequest} onRequest={() => onRequest({ supplier: item, medicine: result.selected, quantity: result.data.requested_quantity })} />)}</div>}
      {result.data.insufficient.length > 0 && <section className="partial-section"><div className="partial-heading"><h2>Other reported stock</h2><p>These facilities cannot meet the full requested quantity and are not full matches.</p></div><div className="supplier-list">{result.data.insufficient.map((item) => <SupplierCard key={item.facility_id} item={item} partial />)}</div></section>}
      <p className="discovery-next">{canRequest ? 'Select a full match to submit a supply request. Approval is needed before stock is reserved.' : 'Only requesting staff and facility administrators can submit supply requests.'}</p>
    </section>}
  </section>
}
