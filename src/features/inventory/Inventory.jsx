import { useEffect, useMemo, useState } from 'react'
import { batchStatus, expiryWarningDays, loadInventory, medicineLabel } from './inventory.js'
import InventoryForm from './InventoryForm'
import BatchHistory from './BatchHistory'
import './inventory.css'

function dateLabel(value) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
}
function updatedLabel(value) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
function Status({ batch }) {
  const state = batchStatus(batch)
  return <div className="status-list">{state.expired && <span className="badge badge-danger">Expired</span>}{state.approaching && <span className="badge badge-warning">Expiring soon</span>}{state.low && <span className="badge badge-warning">Low stock</span>}{!state.expired && !state.approaching && !state.low && <span className="badge badge-good">In stock</span>}</div>
}

export default function Inventory({ client, facility, role }) {
  const canManage = role === 'FACILITY_ADMIN' || role === 'INVENTORY_MANAGER'
  const [request, setRequest] = useState(null)
  const [revision, setRevision] = useState(0)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [form, setForm] = useState(null)
  const [historyBatch, setHistoryBatch] = useState(null)
  const [success, setSuccess] = useState('')

  useEffect(() => {
    let active = true
    loadInventory(client, facility.id)
      .then((data) => { if (active) setRequest({ facilityId: facility.id, revision, data }) })
      .catch(() => { if (active) setRequest({ facilityId: facility.id, revision, error: 'Unable to load inventory. Check your connection or permissions and try again.' }) })
    return () => { active = false }
  }, [client, facility.id, revision])
  const current = request?.facilityId === facility.id && request.revision === revision ? request : null
  const batches = current?.data?.batches
  const filtered = useMemo(() => {
    if (!batches) return []
    const needle = search.trim().toLowerCase()
    return batches.filter((batch) => {
      const medicine = batch.medicines || {}
      const haystack = [medicine.name, medicine.generic_name, medicine.brand_name, medicine.active_ingredient, medicine.strength, medicine.dosage_form, batch.batch_number].filter(Boolean).join(' ').toLowerCase()
      const status = batchStatus(batch)
      return (!needle || haystack.includes(needle)) && (filter === 'all' || (filter === 'low' && status.low) || (filter === 'expiring' && status.approaching) || (filter === 'expired' && status.expired))
    })
  }, [batches, search, filter])
  const metrics = batches ? {
    total: batches.length,
    low: batches.filter((batch) => batchStatus(batch).low).length,
    expiring: batches.filter((batch) => batchStatus(batch).approaching).length,
    expired: batches.filter((batch) => batchStatus(batch).expired).length,
  } : null
  function openForm(mode, batch = null) { setSuccess(''); setHistoryBatch(null); setForm({ mode, batch }) }
  function saved(message) { setForm(null); setSuccess(message); setRevision((value) => value + 1) }

  return <section className="inventory-page" aria-labelledby="inventory-title">
    <div className="inventory-heading"><div><p className="section-tag">FACILITY INVENTORY</p><h1 id="inventory-title">Your medicine stock.</h1><p>Manage batches and monitor availability at {facility.name}.</p></div>{canManage && <button className="button button-primary" type="button" onClick={() => openForm('create')} disabled={!current?.data}>+ Add batch</button>}</div>
    <p className="inventory-explainer">Recorded inventory is facility-reported. Expired batches are not eligible for supply. Expiry alerts use a {expiryWarningDays()}-day warning period.</p>
    {success && <p className="notice notice-success" role="status">{success}</p>}
    {form && current?.data && <InventoryForm key={`${form.mode}-${form.batch?.id || 'new'}`} client={client} facilityId={facility.id} medicines={current.data.medicines} batch={form.batch} mode={form.mode} onCancel={() => setForm(null)} onSaved={saved} />}
    {historyBatch && <BatchHistory key={historyBatch.id} client={client} batch={historyBatch} onClose={() => setHistoryBatch(null)} />}
    {!canManage && <p className="inventory-readonly">You can view inventory. Only facility administrators and inventory managers can make changes.</p>}
    {!current && <p className="inventory-state" role="status">Loading inventory…</p>}
    {current?.error && <div className="inventory-state"><p role="alert">{current.error}</p><button className="button button-outline" type="button" onClick={() => setRevision((value) => value + 1)}>Try again</button></div>}
    {current?.data && <>
      <div className="inventory-metrics" aria-label="Inventory summary"><div><span>Recorded batches</span><strong>{metrics.total}</strong></div><div><span>Low-stock batches</span><strong>{metrics.low}</strong></div><div><span>Expiring within {expiryWarningDays()} days</span><strong>{metrics.expiring}</strong></div><div><span>Expired batches</span><strong>{metrics.expired}</strong></div></div>
      <div className="inventory-list"><div className="inventory-list-head"><div><h2>Inventory batches</h2><p>On hand, reserved and eligible stock by batch.</p></div><div className="inventory-controls"><div className="field"><label htmlFor="inventory-search">Search inventory</label><input id="inventory-search" placeholder="Medicine or batch number" value={search} onChange={(e) => setSearch(e.target.value)} /></div><div className="field"><label htmlFor="inventory-filter">Filter</label><select id="inventory-filter" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All batches</option><option value="low">Low stock</option><option value="expiring">Expiring soon</option><option value="expired">Expired</option></select></div></div></div>
      {filtered.length === 0 ? <p className="inventory-empty">{batches.length === 0 ? 'No inventory batches yet.' : 'No batches match your search or filter.'}</p> : <div className="table-scroll"><table><thead><tr><th>Medicine / batch</th><th>Expiry / updated</th><th>Stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>{filtered.map((batch) => { const stock = batchStatus(batch); return <tr key={batch.id}><td><strong>{medicineLabel(batch.medicines)}</strong><small>Batch: {batch.batch_number}</small></td><td><strong>{dateLabel(batch.expiry_date)}</strong><small>Updated {updatedLabel(batch.last_updated_at)}</small></td><td><strong>{stock.eligible} eligible {batch.medicines?.unit_of_measure || 'units'}</strong><small>{batch.quantity_on_hand} on hand · {batch.quantity_reserved} reserved</small>{stock.expired && stock.unreserved > 0 && <small>Expired: {stock.unreserved} unreserved</small>}</td><td><Status batch={batch} /></td><td><div className="row-actions"><button type="button" aria-label={`History for batch ${batch.batch_number}`} onClick={() => { setForm(null); setHistoryBatch(batch) }}>History</button>{canManage && <><button type="button" aria-label={`Adjust batch ${batch.batch_number}`} onClick={() => openForm('adjust', batch)}>Adjust</button><button type="button" aria-label={`Edit batch ${batch.batch_number}`} onClick={() => openForm('edit', batch)}>Edit</button></>}</div></td></tr> })}</tbody></table></div>}
      </div>
    </>}
  </section>
}
