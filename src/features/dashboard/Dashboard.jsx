import { useEffect, useMemo, useState } from 'react'
import { expiryWarningDays, inventorySignals, loadDashboard, recentActivity } from './dashboard.js'
import './dashboard.css'

const dateLabel = (value) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`))
const timeLabel = (value) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
const medicineLabel = (medicine) => medicine ? [medicine.name, medicine.strength, medicine.dosage_form].filter(Boolean).join(' · ') : 'Unknown medicine'

const FACILITY_PRIORITIES = {
  PHARMACY: {
    title: 'Pharmacy priorities',
    description: 'Keep stock visible and respond to supply requests from other facilities.',
    actions: [
      { page: 'inventory', label: 'Manage inventory', priority: true },
      { page: 'requests', label: 'Review incoming requests', priority: true },
      { page: 'discovery', label: 'Find medicine', priority: false },
    ],
  },
  CLINIC: {
    title: 'Clinic priorities',
    description: 'Find available medicine and follow your facility’s outgoing requests.',
    actions: [
      { page: 'discovery', label: 'Find medicine', priority: true },
      { page: 'requests', label: 'Review outgoing requests', priority: true },
      { page: 'inventory', label: 'Manage inventory', priority: false },
    ],
  },
  HOSPITAL: {
    title: 'Hospital priorities',
    description: 'Search medicine availability and keep facility inventory up to date.',
    actions: [
      { page: 'discovery', label: 'Find medicine', priority: true },
      { page: 'inventory', label: 'Manage inventory', priority: true },
      { page: 'requests', label: 'Supply requests', priority: false },
    ],
  },
}

function Panel({ title, description, count, emptyMessage, children }) {
  return <section className="dashboard-panel">
    <div className="dashboard-panel-heading"><div><h2>{title}</h2><p>{description}</p></div><span className="dashboard-count" aria-label={`${count} items`}>{count}</span></div>
    {children || <p className="dashboard-empty">{emptyMessage}</p>}
  </section>
}

function BatchList({ batches, kind, snapshotAt }) {
  return <ul className="dashboard-list">{batches.slice(0, 5).map((batch) => {
    const signals = inventorySignals(batch, snapshotAt)
    return <li className="dashboard-list-item" key={batch.id}>
      <span className={`dashboard-item-icon ${kind === 'low' ? 'icon-alert' : 'icon-clock'}`} aria-hidden="true">{kind === 'low' ? '!' : '◷'}</span>
      <div className="dashboard-item-main"><strong>{medicineLabel(batch.medicines)}</strong><span>Batch {batch.batch_number} · {kind === 'low' ? `${signals.eligible} / ${batch.low_stock_threshold} ${batch.medicines?.unit_of_measure || 'units'} available / threshold` : `${batch.quantity_on_hand} ${batch.medicines?.unit_of_measure || 'units'} on hand`}</span></div>
      {kind === 'low' ? <span className="dashboard-pill pill-alert">Low</span> : <span className="dashboard-pill pill-warning">{dateLabel(batch.expiry_date)}</span>}
    </li>
  })}</ul>
}

function RequestList({ requests, direction }) {
  return <ul className="dashboard-list">{requests.slice(0, 5).map((request) => {
    const incoming = direction === 'incoming'
    const other = incoming ? request.requesting_facility : request.supplying_facility
    return <li className="dashboard-list-item" key={request.id}>
      <span className="dashboard-item-icon" aria-hidden="true">↔</span>
      <div className="dashboard-item-main"><strong>{medicineLabel(request.medicine)}</strong><span>{incoming ? 'From' : 'To'} {other?.name || 'another facility'} · {request.requested_quantity} {request.medicine?.unit_of_measure || 'units'}</span></div>
      <time dateTime={request.created_at}>{timeLabel(request.created_at)}</time>
    </li>
  })}</ul>
}

export default function Dashboard({ client, facility, role, onNavigate }) {
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState(null)

  useEffect(() => {
    let active = true
    loadDashboard(client, facility.id)
      .then((data) => { if (active) setResult({ facilityId: facility.id, revision, data }) })
      .catch(() => { if (active) setResult({ facilityId: facility.id, revision, error: 'We could not load the facility dashboard. Check your connection or permissions and try again.' }) })
    return () => { active = false }
  }, [client, facility.id, revision])

  const current = result?.facilityId === facility.id && result.revision === revision ? result : null
  const summary = useMemo(() => {
    if (!current?.data) return null
    const data = current.data
    const warningDays = expiryWarningDays()
    const lowStock = data.batches.filter((batch) => inventorySignals(batch, data.snapshotAt).low)
      .sort((a, b) => inventorySignals(a, data.snapshotAt).eligible - inventorySignals(b, data.snapshotAt).eligible || a.expiry_date.localeCompare(b.expiry_date))
    const expiring = data.batches.filter((batch) => inventorySignals(batch, data.snapshotAt).expiring)
      .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date))
    return {
      warningDays, lowStock, expiring,
      incoming: data.requests.filter((request) => request.supplying_facility_id === facility.id && request.status === 'PENDING'),
      outgoing: data.requests.filter((request) => request.requesting_facility_id === facility.id && request.status === 'PENDING'),
      activity: recentActivity(data, facility.id),
    }
  }, [current, facility.id])

  const refresh = () => setRevision((value) => value + 1)
  const content = (items, component) => items.length ? component : null
  const facilityType = typeof facility.facility_type === 'string' ? facility.facility_type.trim().toUpperCase() : ''
  const priorities = FACILITY_PRIORITIES[facilityType]

  return <section className="dashboard-page" aria-labelledby="dashboard-title">
    <header className="dashboard-header"><div><p className="dashboard-eyebrow">FACILITY OVERVIEW</p><h1 id="dashboard-title">Good day, {facility.name}</h1><p className="dashboard-subtitle">Facility stock, supply requests, and recent activity. Refresh to see the latest updates.</p></div>
      <button className="dashboard-refresh" type="button" onClick={refresh} aria-label="Refresh dashboard"><span aria-hidden="true">↻</span> Refresh</button>
    </header>
    {priorities && <section className="dashboard-focus" aria-labelledby="dashboard-focus-title">
      <div className="dashboard-focus-copy"><h2 id="dashboard-focus-title">{priorities.title}</h2><p>{priorities.description}</p></div>
      <div className="dashboard-focus-actions">{priorities.actions.map((action) => <button key={action.page} className={action.priority ? 'dashboard-action dashboard-action-priority' : 'dashboard-action'} type="button" onClick={() => onNavigate?.(action.page)}>{action.page === 'inventory' && role && !['FACILITY_ADMIN', 'INVENTORY_MANAGER'].includes(role) ? 'View inventory' : action.label}<span aria-hidden="true">↗</span></button>)}</div>
    </section>}
    {!current && <div className="dashboard-state" role="status"><span className="dashboard-spinner" aria-hidden="true" />Loading facility dashboard…</div>}
    {current?.error && <div className="dashboard-state dashboard-error" role="alert"><div><strong>Dashboard unavailable</strong><p>{current.error}</p></div><button className="dashboard-retry" type="button" onClick={refresh}>Try again</button></div>}
    {current?.data && summary && <>
      <section className="dashboard-metrics" aria-label="Facility stock and request summary">
        <article className="dashboard-metric metric-stock"><span className="dashboard-metric-icon" aria-hidden="true">!</span><div><span>Low-stock batches</span><strong>{summary.lowStock.length}</strong><small>At or below the recorded threshold</small></div></article>
        <article className="dashboard-metric metric-expiry"><span className="dashboard-metric-icon" aria-hidden="true">◷</span><div><span>Expiring soon</span><strong>{summary.expiring.length}</strong><small>Within {summary.warningDays} days</small></div></article>
        <article className="dashboard-metric metric-incoming"><span className="dashboard-metric-icon" aria-hidden="true">↓</span><div><span>Incoming requests</span><strong>{summary.incoming.length}</strong><small>Pending supplier review</small></div></article>
        <article className="dashboard-metric metric-outgoing"><span className="dashboard-metric-icon" aria-hidden="true">↑</span><div><span>Outgoing requests</span><strong>{summary.outgoing.length}</strong><small>Awaiting a supplier response</small></div></article>
      </section>
      <div className="dashboard-grid">
        <Panel title="Low stock" description="Batches at or below their available-stock threshold." count={summary.lowStock.length} emptyMessage="No low-stock batches at this facility.">{content(summary.lowStock, <BatchList batches={summary.lowStock} kind="low" snapshotAt={current.data.snapshotAt} />)}</Panel>
        <Panel title="Expiring batches" description={`Expiry date within ${summary.warningDays} days.`} count={summary.expiring.length} emptyMessage="No batches are approaching expiry.">{content(summary.expiring, <BatchList batches={summary.expiring} kind="expiry" snapshotAt={current.data.snapshotAt} />)}</Panel>
        <Panel title="Incoming requests" description="Pending requests from other facilities." count={summary.incoming.length} emptyMessage="No pending incoming requests.">{content(summary.incoming, <RequestList requests={summary.incoming} direction="incoming" />)}</Panel>
        <Panel title="Outgoing requests" description="Your facility's pending supply requests." count={summary.outgoing.length} emptyMessage="No pending outgoing requests.">{content(summary.outgoing, <RequestList requests={summary.outgoing} direction="outgoing" />)}</Panel>
        <Panel title="Recent activity" description="Latest inventory movements and request updates." count={summary.activity.length} emptyMessage="No recent inventory or request activity.">{content(summary.activity, <ul className="dashboard-list dashboard-activity-list">{summary.activity.map((item) => <li className="dashboard-list-item" key={item.id}><span className="dashboard-item-icon icon-activity" aria-hidden="true">•</span><div className="dashboard-item-main"><strong>{item.title}</strong><span>{item.detail}</span></div><time dateTime={item.createdAt}>{timeLabel(item.createdAt)}</time></li>)}</ul>)}</Panel>
      </div>
    </>}
  </section>
}
