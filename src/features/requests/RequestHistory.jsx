import { useEffect, useState } from 'react'
import { loadRequestHistory, requestErrorMessage } from './requests.js'

function timeLabel(value) {
  if (!value) return 'Time unavailable'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Time unavailable' : new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export default function RequestHistory({ client, requestId, refreshKey = 0 }) {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    let active = true
    loadRequestHistory(client, requestId)
      .then((rows) => { if (active) setEvents(rows) })
      .catch((err) => { if (active) setError(requestErrorMessage(err)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [client, requestId, refreshKey, retry])

  return <section className="request-history" aria-label={`History for request ${requestId}`}>
    <h4>Request history</h4>
    {loading && <p role="status">Loading request history…</p>}
    {!loading && error && <div className="request-history-error"><p role="alert">{error}</p><button className="button button-outline" type="button" onClick={() => { setLoading(true); setError(''); setRetry((value) => value + 1) }}>Retry history</button></div>}
    {!loading && !error && events.length === 0 && <p>No request events are visible.</p>}
    {!loading && !error && events.length > 0 && <ol className="request-events">{events.map((event) => <li key={event.id}>
      <div className="event-heading"><strong>{event.event_type}</strong><time dateTime={event.created_at}>{timeLabel(event.created_at)}</time></div>
      <p>Status: {event.previous_status ? `${event.previous_status} → ` : ''}{event.new_status}</p>
      <p>Actor ID: <code>{event.actor_id}</code></p>
      {event.notes && <p className="event-notes">{event.notes}</p>}
    </li>)}</ol>}
  </section>
}
