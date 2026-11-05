import { useEffect, useState } from 'react'
import { loadBatchHistory, medicineLabel } from './inventory.js'

const movementLabels = { INITIAL_STOCK:'Initial stock', ADJUSTMENT_IN:'Stock added', ADJUSTMENT_OUT:'Stock removed', FULFILMENT_OUT:'Request fulfilled' }

export default function BatchHistory({ client, batch, onClose }) {
  const [result, setResult] = useState(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    loadBatchHistory(client, batch.id)
      .then((items) => { if (active) setResult({ batchId: batch.id, retry, items }) })
      .catch(() => { if (active) setResult({ batchId: batch.id, retry, error: true }) })
    return () => { active = false }
  }, [client, batch.id, retry])
  const current = result?.batchId === batch.id && result.retry === retry ? result : null
  return <section className="inventory-form-panel" aria-labelledby="history-title">
    <div className="inventory-form-head"><div><p className="section-tag">AUDIT HISTORY</p><h2 id="history-title">Batch history</h2></div><button className="text-button compact" type="button" onClick={onClose}>Close</button></div>
    <p className="form-subtitle">{medicineLabel(batch.medicines)} · {batch.batch_number}</p>
    {!current && <p className="history-message" role="status">Loading batch history…</p>}
    {current?.error && <div className="history-message"><p role="alert">Unable to load batch history.</p><button className="button button-outline" type="button" onClick={() => setRetry((n) => n + 1)}>Try again</button></div>}
    {current?.items && current.items.length === 0 && <p className="history-message">No recorded activity for this batch.</p>}
    {current?.items?.length > 0 && <ol className="history-list">{current.items.map((item) => <li key={`${item.kind}-${item.id}`}><div><strong>{item.kind === 'movement' ? `${movementLabels[item.movement_type] || item.movement_type} · ${item.quantity}` : 'Batch details updated'}</strong><time dateTime={item.created_at}>{new Intl.DateTimeFormat('en-GB', { dateStyle:'medium', timeStyle:'short' }).format(new Date(item.created_at))}</time></div>{item.kind === 'metadata' && <p>Batch: {item.before_metadata.batch_number} → {item.after_metadata.batch_number}; expiry: {item.before_metadata.expiry_date} → {item.after_metadata.expiry_date}; threshold: {item.before_metadata.low_stock_threshold} → {item.after_metadata.low_stock_threshold}</p>}{item.notes && <p>{item.notes}</p>}{item.supply_request_id && <p>Request: {item.supply_request_id}</p>}<small>Actor ID: {item.kind === 'movement' ? item.performed_by : item.actor_id}</small></li>)}</ol>}
  </section>
}
