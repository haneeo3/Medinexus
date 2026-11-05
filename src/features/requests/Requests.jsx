import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import RequestForm from './RequestForm.jsx'
import RequestHistory from './RequestHistory.jsx'
import RequestPhoto from './RequestPhoto.jsx'
import ReceiptForm from './ReceiptForm.jsx'
import { uploadRequestPhoto, validatePhoto } from './proof.js'
import { isKnownMutationError, loadSupplyRequests, requestErrorMessage } from './requests.js'
import './requests.css'

function dateLabel(value) {
  if (!value) return 'Unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Unavailable' : new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
function medicineLabel(medicine) {
  return medicine ? [medicine.name, medicine.strength, medicine.dosage_form].filter(Boolean).join(' · ') : 'Medicine unavailable'
}
function getActions(request, facilityId, role) {
  const supplierSide = request.supplying_facility_id === facilityId
  const requesterSide = request.requesting_facility_id === facilityId
  const supplierStaff = supplierSide && ['FACILITY_ADMIN', 'SUPPLIER_STAFF'].includes(role)
  const requestingStaff = requesterSide && ['FACILITY_ADMIN', 'REQUESTING_STAFF'].includes(role)
  return { approve: supplierStaff && request.status === 'PENDING', reject: supplierStaff && request.status === 'PENDING', fulfil: supplierStaff && request.status === 'APPROVED', receive: requestingStaff && request.status === 'FULFILLED', cancel: ['PENDING', 'APPROVED'].includes(request.status) && (supplierStaff || requestingStaff) }
}
function StatusBadge({ status }) {
  const klass = ['APPROVED', 'FULFILLED', 'RECEIVED'].includes(status) ? 'badge-good' : status === 'PENDING' ? 'badge-warning' : ['REJECTED', 'CANCELLED'].includes(status) ? 'badge-danger' : ''
  return <span className={`badge ${klass}`}>{status || 'Unknown status'}</span>
}

function RequestCard({ request, client, facilityId, role, busy, actionsBlocked, onAction, historyRefreshKey }) {
  const actions = getActions(request, facilityId, role)
  const [expanded, setExpanded] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [photo, setPhoto] = useState(null)
  const [photoError, setPhotoError] = useState('')
  const isBusy = busy === request.id
  const medicine = request.medicine || {}
  const isIncoming = request.supplying_facility_id === facilityId

  return <article className="request-card" aria-labelledby={`request-title-${request.id}`}>
    <div className="request-card-top"><div className="request-card-title">
      <p className="request-direction">{isIncoming ? 'Incoming request' : 'Outgoing request'}</p>
      <h3 id={`request-title-${request.id}`}>{medicineLabel(medicine)}</h3>
      <p className="request-quantity">{request.requested_quantity} {medicine.unit_of_measure || 'units'} requested</p>
    </div><StatusBadge status={request.status} /></div>
    <dl className="request-parties">
      <div><dt>Requesting facility</dt><dd>{request.requesting_facility?.name || 'Unavailable'}</dd></div>
      <div><dt>Supplying facility</dt><dd>{request.supplying_facility?.name || 'Unavailable'}</dd></div>
      <div><dt>Created</dt><dd><time dateTime={request.created_at}>{dateLabel(request.created_at)}</time></dd></div>
    </dl>
    <div className="request-card-actions">
      <button type="button" className="button button-outline" aria-expanded={expanded} aria-controls={`request-details-${request.id}`} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Hide details' : 'View details'} · {request.id}</button>
      <button type="button" className="button button-outline" aria-expanded={showHistory} aria-controls={`request-history-${request.id}`} onClick={() => setShowHistory((value) => !value)}>{showHistory ? 'Hide history' : 'History'} · {request.id}</button>
    </div>
    {expanded && <div className="request-detail-panel" id={`request-details-${request.id}`}>
      <dl className="request-detail-grid">
        <div><dt>Request ID</dt><dd><code>{request.id}</code></dd></div>
        <div><dt>Medicine</dt><dd>{medicineLabel(medicine)}</dd></div>
        <div><dt>Requested quantity</dt><dd>{request.requested_quantity} {medicine.unit_of_measure || 'units'}</dd></div>
        <div><dt>Approved quantity</dt><dd>{request.approved_quantity ?? '—'}</dd></div>
        <div><dt>Fulfilled quantity</dt><dd>{request.fulfilled_quantity ?? 0}</dd></div>
        <div><dt>Updated</dt><dd><time dateTime={request.updated_at}>{dateLabel(request.updated_at)}</time></dd></div>
        <div><dt>Created by</dt><dd><code>{request.created_by || 'Unavailable'}</code></dd></div>
        <div><dt>Reviewed by</dt><dd><code>{request.reviewed_by || '—'}</code></dd></div>
      </dl>
      <p className="request-notes"><strong>Request notes</strong><span>{request.request_notes || 'No notes provided.'}</span></p>
      <p className="request-reservation-note">Approval reserves eligible stock. Fulfilment records stock leaving the supplier; only the requesting facility can confirm receipt. A photo supports the record but does not prove delivery.</p>
      {['FULFILLED', 'RECEIVED'].includes(request.status) && <RequestPhoto client={client} requestId={request.id} />}
    </div>}
    {showHistory && <div id={`request-history-${request.id}`}><RequestHistory key={`${request.id}-${historyRefreshKey}`} client={client} requestId={request.id} refreshKey={historyRefreshKey} /></div>}
    {(actions.approve || actions.reject || actions.fulfil || actions.receive || actions.cancel) && <div className="request-mutation-actions" aria-label={`Actions for request ${request.id}`}>
      {actions.approve && <button type="button" className="button button-primary" disabled={isBusy || Boolean(busy) || actionsBlocked} onClick={() => onAction(request, 'approve')} aria-label={`Approve request ${request.id}`}>{isBusy ? 'Processing…' : 'Approve request'}</button>}
      {actions.reject && <button type="button" className="button button-outline request-danger-action" disabled={isBusy || Boolean(busy) || actionsBlocked} onClick={() => onAction(request, 'reject')} aria-label={`Reject request ${request.id}`}>{isBusy ? 'Processing…' : 'Reject request'}</button>}
      {actions.fulfil && <div className="request-photo-input">
        <label htmlFor={`photo-${request.id}`}>Photo of prepared medicine (required)</label>
        <input id={`photo-${request.id}`} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" disabled={Boolean(busy) || actionsBlocked} onChange={(event) => { setPhoto(event.target.files?.[0] || null); setPhotoError('') }} />
        <p>JPEG, PNG or WebP, up to 5 MB. Do not include patient information.</p>
        {photoError && <p role="alert">{photoError}</p>}
        <button type="button" className="button button-primary" disabled={isBusy || Boolean(busy) || actionsBlocked} onClick={() => { const error = validatePhoto(photo); if (error) setPhotoError(error); else onAction(request, 'fulfil', photo) }} aria-label={`Record fulfilment for request ${request.id}`}>{isBusy ? 'Processing…' : 'Upload photo and record fulfilment'}</button>
      </div>}
      {actions.receive && <ReceiptForm request={request} disabled={Boolean(busy) || actionsBlocked} onSubmit={(batches) => onAction(request, 'receive', batches)} />}
      {actions.cancel && <button type="button" className="button button-outline request-danger-action" disabled={isBusy || Boolean(busy) || actionsBlocked} onClick={() => onAction(request, 'cancel')} aria-label={`Cancel request ${request.id}`}>{isBusy ? 'Processing…' : 'Cancel request'}</button>}
      {actionsBlocked && <p className="request-action-lock">Actions are blocked until you successfully refresh the list.</p>}
    </div>}
  </article>
}

export default function Requests({ client, facility, role, draft, onDraftCleared, onBusyChange, initialTab = 'incoming' }) {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState(() => initialTab === 'outgoing' ? 'outgoing' : 'incoming')
  const [success, setSuccess] = useState('')
  const [mutationError, setMutationError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [busy, setBusy] = useState(null)
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0)
  const mutationLock = useRef(false)
  const loadSequence = useRef(0)

  const reload = useCallback(async ({ unlock = false, preserveSuccess = false } = {}) => {
    const sequence = ++loadSequence.current
    setLoading(true)
    setLoadError('')
    setMutationError('')
    if (!preserveSuccess) setSuccess('')
    try {
      const rows = await loadSupplyRequests(client, facility.id)
      if (sequence !== loadSequence.current) return
      setRequests(rows)
      setHistoryRefreshKey((value) => value + 1)
      if (unlock) { mutationLock.current = false; setUncertain(false) }
    } catch (error) {
      if (sequence === loadSequence.current) { setRequests([]); setLoadError(requestErrorMessage(error)) }
    } finally { if (sequence === loadSequence.current) setLoading(false) }
  }, [client, facility.id])

  useEffect(() => {
    const sequence = ++loadSequence.current
    loadSupplyRequests(client, facility.id)
      .then((rows) => { if (sequence === loadSequence.current) { setRequests(rows); setLoadError(''); setHistoryRefreshKey((value) => value + 1) } })
      .catch((error) => { if (sequence === loadSequence.current) { setRequests([]); setLoadError(requestErrorMessage(error)) } })
      .finally(() => { if (sequence === loadSequence.current) setLoading(false) })
    return () => { loadSequence.current += 1 }
  }, [client, facility.id])
  const visibleRequests = useMemo(() => requests.filter((request) => tab === 'incoming'
    ? request.supplying_facility_id === facility.id
    : request.requesting_facility_id === facility.id), [requests, tab, facility.id])

  async function performAction(request, action, payload = null) {
    if (mutationLock.current || busy || uncertain) return
    const labels = { approve: 'approve this request', reject: 'reject this request', fulfil: 'record supplier fulfilment for this request', receive: 'confirm receipt and add these batches to your facility’s inventory', cancel: 'cancel this request' }
    if (!window.confirm(`Are you sure you want to ${labels[action]}? Approval reserves stock. Recording fulfilment records supplier stock leaving and does not confirm physical delivery.`)) return
    let notes = null
    if (action === 'reject' || action === 'cancel') {
      const response = window.prompt(`${action === 'reject' ? 'Rejection' : 'Cancellation'} note (optional):`, '')
      if (response === null) return
      notes = response.trim() || null
    }
    const calls = {
      approve: ['approve_supply_request', { p_request_id: request.id }],
      reject: ['reject_supply_request', { p_request_id: request.id, p_notes: notes }],
      receive: ['confirm_supply_request_receipt_with_inventory', { p_request_id: request.id, p_batches: payload }],
      cancel: ['cancel_supply_request', { p_request_id: request.id, p_notes: notes }],
    }
    mutationLock.current = true
    onBusyChange?.(true)
    setBusy(request.id)
    setMutationError('')
    setSuccess('')
    let uploading = action === 'fulfil'
    try {
      if (uploading) {
        const path = await uploadRequestPhoto(client, request.id, payload)
        uploading = false
        calls.fulfil = ['fulfil_supply_request_with_proof', { p_request_id: request.id, p_object_path: path }]
      }
      const [rpcName, args] = calls[action]
      const result = await client.rpc(rpcName, args)
      if (result?.error) {
        if (isKnownMutationError(result.error)) {
          mutationLock.current = false
          setMutationError(requestErrorMessage(result.error))
        } else {
          setUncertain(true)
          setMutationError('The outcome is uncertain. This operation may have completed. Further actions are blocked until you refresh the list and confirm the current status.')
        }
        return
      }
      if (!result || !Object.hasOwn(result, 'data') || result.data == null) {
        setUncertain(true)
        setMutationError('The outcome is uncertain. This operation may have completed. Further actions are blocked until you refresh the list and confirm the current status.')
        return
      }
      setSuccess({ approve: 'Request approved and stock reserved.', reject: 'Request rejected.', fulfil: 'Supplier fulfilment recorded. The requesting facility can now confirm receipt.', receive: 'Receipt confirmed and medicine added to your inventory.', cancel: 'Request cancelled.' }[action])
      await reload({ unlock: true, preserveSuccess: true })
    } catch (error) {
      if (uploading) {
        mutationLock.current = false
        setMutationError(error.message || 'The photo could not be uploaded. No fulfilment was recorded; please try again.')
      } else if (isKnownMutationError(error)) {
        mutationLock.current = false
        setMutationError(requestErrorMessage(error))
      } else {
        setUncertain(true)
        setMutationError('The outcome is uncertain. This operation may have completed. Further actions are blocked until you refresh the list and confirm the current status.')
      }
    } finally {
      onBusyChange?.(false)
      setBusy(null)
      if (!mutationLock.current) setUncertain(false)
    }
  }

  function clearDraft() { onDraftCleared?.(); void reload({ unlock: true }) }
  function savedDraft() {
    onDraftCleared?.()
    setTab('outgoing')
    setSuccess('Supply request created.')
    setMutationError('')
    void reload({ preserveSuccess: true })
  }

  if (draft) return <section className="requests-page" aria-labelledby="requests-title">
    <div className="requests-heading"><div><p className="section-tag">SUPPLY COORDINATION</p><h1 id="requests-title">Supply requests</h1></div></div>
    <RequestForm client={client} facility={facility} draft={draft} onSaved={savedDraft} onCancel={clearDraft} onBusyChange={onBusyChange} />
  </section>

  return <section className="requests-page" aria-labelledby="requests-title">
    <div className="requests-heading"><div><p className="section-tag">SUPPLY COORDINATION</p><h1 id="requests-title">Supply requests</h1><p>Review incoming and outgoing facility requests.</p></div><button className="button button-outline" type="button" onClick={() => reload({ unlock: true })} disabled={loading || Boolean(busy)}>Refresh list</button></div>
    <p className="requests-reservation-banner"><strong>Stock is not guaranteed at request creation.</strong> Supplier approval reserves eligible stock. The supplier uploads a photo when recording fulfilment. The requesting facility confirms receipt after checking the medicine.</p>
    {success && <p className="notice notice-success" role="status">{success}</p>}
    {mutationError && <p className="notice notice-error" role="alert">{mutationError}</p>}
    <div className="request-tabs" role="tablist" aria-label="Request direction">
      <button type="button" role="tab" id="requests-tab-incoming" aria-controls="requests-panel" aria-selected={tab === 'incoming'} onClick={() => setTab('incoming')}>Incoming</button>
      <button type="button" role="tab" id="requests-tab-outgoing" aria-controls="requests-panel" aria-selected={tab === 'outgoing'} onClick={() => setTab('outgoing')}>Outgoing</button>
    </div>
    {loading && <p className="request-state" role="status">Loading supply requests…</p>}
    {!loading && loadError && <div className="request-state request-error-state"><p role="alert">{loadError}</p><button className="button button-outline" type="button" onClick={() => reload({ unlock: uncertain || mutationLock.current })}>Try again</button></div>}
    {!loading && !loadError && <div id="requests-panel" role="tabpanel" aria-labelledby={`requests-tab-${tab}`} className="request-list-panel">
      <div className="request-list-heading"><div><h2>{tab === 'incoming' ? 'Incoming requests' : 'Outgoing requests'}</h2><p>{visibleRequests.length} request{visibleRequests.length === 1 ? '' : 's'}</p></div></div>
      {visibleRequests.length === 0 ? <div className="request-empty"><strong>No {tab} requests yet.</strong><p>{tab === 'incoming' ? 'Requests sent to your facility will appear here.' : 'Requests created by your facility will appear here.'}</p></div> : <div className="request-list">{visibleRequests.map((request) => <RequestCard key={request.id} request={request} client={client} facilityId={facility.id} role={role} busy={busy} actionsBlocked={uncertain} onAction={performAction} historyRefreshKey={historyRefreshKey} />)}</div>}
    </div>}
    {uncertain && <p className="request-action-lock" role="status">Actions remain blocked until a successful refresh confirms current request status.</p>}
  </section>
}
