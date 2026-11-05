import { useEffect, useState } from 'react'
import { supabase, configurationError } from './lib/supabase'
import { loadWorkspace, roleDescriptions, roleLabels } from './lib/workspace'
import Inventory from './features/inventory/Inventory.jsx'
import Discovery from './features/discovery/Discovery.jsx'
import Requests from './features/requests/Requests.jsx'
import './App.css'

function Mark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M16 5v22M5 16h22" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/><circle cx="16" cy="16" r="13" stroke="currentColor" strokeWidth="1.5" opacity=".45"/></svg></span>
}

function Brand({ light = false }) {
  return <div className={`brand ${light ? 'brand-light' : ''}`}><Mark /><span>Medi<span className="brand-accent">Nexus</span><small>FIND IT. CONNECT. DELIVER.</small></span></div>
}

function Login({ client }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const { error: signInError } = await client.auth.signInWithPassword({ email: email.trim(), password })
      if (signInError) setError('Unable to sign in. Check your email and password, then try again.')
    } catch {
      setError('Unable to reach the service. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return <main className="auth-layout">
    <section className="auth-story" aria-label="About MediNexus">
      <Brand light />
      <div className="story-content">
        <p className="eyebrow story-eyebrow"><span className="status-dot" /> CONNECTED CARE STARTS HERE</p>
        <h1>Better access to medicines, <em>together.</em></h1>
        <p className="story-copy">A shared space for healthcare facilities to find medicine availability and coordinate supply with confidence.</p>
        <div className="story-card"><span className="story-card-icon" aria-hidden="true">✦</span><div><strong>One connected network</strong><p>From finding stock to tracking a supply request, all in one place.</p></div></div>
      </div>
      <p className="story-footer">Built for better healthcare coordination.</p>
      <div className="orb orb-one" aria-hidden="true" /><div className="orb orb-two" aria-hidden="true" />
    </section>
    <section className="auth-main" aria-label="Sign in">
      <div className="mobile-brand"><Brand /></div>
      <div className="login-wrap">
        <div className="login-heading"><span className="section-tag">WELCOME TO MEDINEXUS</span><h2>Welcome back.</h2><p>Sign in to access your facility workspace.</p></div>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="field"><label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="username" placeholder="you@facility.com" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label htmlFor="password">Password</label><input id="password" type="password" autoComplete="current-password" placeholder="Enter your password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<span aria-hidden="true">→</span></button>
        </form>
        <p className="login-help">Need access? Contact your facility administrator.</p>
        <div className="privacy-note"><span aria-hidden="true">◇</span><p><strong>Your workspace, protected.</strong><br />Access is limited to authorised facility staff.</p></div>
      </div>
      <p className="auth-bottom">MediNexus <span>•</span> Healthcare supply, connected.</p>
    </section>
  </main>
}

function Workspace({ workspace, email, onSignOut, signOutError, signingOut }) {
  const { profile, facility } = workspace
  const [page, setPage] = useState('overview')
  const [requestDraft, setRequestDraft] = useState(null)
  const [requestBusy, setRequestBusy] = useState(false)
  const facilityName = facility?.name || 'Platform workspace'
  const verification = facility?.verification_status?.toLowerCase() || ''
  return <div className="workspace-layout">
    <header className="topbar"><Brand /><div className="topbar-right"><div className="account-summary"><strong>{profile.full_name}</strong><span>{roleLabels[profile.role]}</span></div><button className="button button-outline" type="button" onClick={onSignOut} disabled={signingOut || requestBusy}>{signingOut ? 'Signing out…' : 'Sign out'}</button></div></header>
    <main className="workspace-main">
      {facility && <nav className="workspace-nav" aria-label="Workspace"><button type="button" disabled={requestBusy} aria-current={page === 'overview' ? 'page' : undefined} onClick={() => setPage('overview')}>Overview</button><button type="button" disabled={requestBusy} aria-current={page === 'inventory' ? 'page' : undefined} onClick={() => setPage('inventory')}>Inventory</button><button type="button" disabled={requestBusy} aria-current={page === 'discovery' ? 'page' : undefined} onClick={() => setPage('discovery')}>Find medicine</button><button type="button" disabled={requestBusy} aria-current={page === 'requests' ? 'page' : undefined} onClick={() => setPage('requests')}>Supply requests</button></nav>}
      {signOutError && <p className="notice notice-error" role="alert">{signOutError}</p>}
      {page === 'inventory' && facility ? <Inventory client={supabase} facility={facility} role={profile.role} /> : page === 'discovery' && facility ? <Discovery client={supabase} facility={facility} role={profile.role} onRequest={(draft) => { setRequestDraft(draft); setPage('requests') }} /> : page === 'requests' && facility ? <Requests client={supabase} facility={facility} role={profile.role} draft={requestDraft} onDraftCleared={() => setRequestDraft(null)} onBusyChange={setRequestBusy} /> : <>
      <div className="workspace-heading"><div><p className="section-tag">YOUR WORKSPACE</p><h1>Welcome, {profile.full_name.split(' ')[0]}.</h1><p>You’re signed in to your MediNexus workspace.</p></div><span className="access-chip"><span className="status-dot" /> Active account</span></div>
      <section className="facility-panel" aria-labelledby="facility-heading">
        <div className="panel-icon" aria-hidden="true">✚</div><div className="facility-copy"><span className="section-tag">{facility ? 'YOUR FACILITY' : 'YOUR ACCOUNT'}</span><h2 id="facility-heading">{facilityName}</h2><p>{facility ? facility.address : 'Platform-wide administration'}</p></div>
        {facility && <div className="verification"><span>Platform verification</span><strong>{verification}</strong></div>}
      </section>
      <div className="workspace-grid"><section className="info-panel"><div className="panel-header"><div><p className="section-tag">ACCOUNT DETAILS</p><h2>Your access</h2></div><span className="mini-icon" aria-hidden="true">↗</span></div><dl><div><dt>Signed in as</dt><dd>{email}</dd></div><div><dt>Role</dt><dd>{roleLabels[profile.role]}</dd></div><div><dt>Access area</dt><dd>{roleDescriptions[profile.role]}</dd></div></dl><p className="panel-footnote">Actions are checked by the server for your role and facility.</p></section>
      <section className="info-panel next-panel"><div className="panel-header"><div><p className="section-tag">FACILITY TOOLS</p><h2>Your workspace</h2></div><span className="mini-icon" aria-hidden="true">✦</span></div><p>Explore the tools available in your facility workspace.</p><div className="next-list"><div><span className="list-number">01</span><span>Manage facility inventory</span><small>Available</small></div><div><span className="list-number">02</span><span>Find medicine availability</span><small>Available</small></div><div><span className="list-number">03</span><span>Coordinate supply requests</span><small>Available</small></div></div></section></div>
      </>}
      <p className="workspace-footer">MediNexus · Find it. Connect. Deliver.</p>
    </main>
  </div>
}

function StateScreen({ title, message, action, actionLabel, secondary, secondaryLabel }) {
  return <main className="state-page"><div className="state-card"><Brand /><div className="state-body"><p className="section-tag">MEDINEXUS</p><h1>{title}</h1><p role="status">{message}</p>{action && <button className="button button-primary" type="button" onClick={action}>{actionLabel}</button>}{secondary && <button className="text-button" type="button" onClick={secondary}>{secondaryLabel}</button>}</div></div></main>
}

function App() {
  const [session, setSession] = useState(undefined)
  const [workspaceState, setWorkspaceState] = useState(null)
  const [authError, setAuthError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    if (!supabase) return undefined
    let active = true
    let receivedEvent = false
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      receivedEvent = true
      if (active) { setAuthError(''); setSession(nextSession) }
    })
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active || receivedEvent) return
      if (error) { setAuthError('Unable to check your session. Please refresh and try again.'); setSession(null) }
      else setSession(data.session)
    }).catch(() => { if (active && !receivedEvent) { setAuthError('Unable to check your session. Please refresh and try again.'); setSession(null) } })
    return () => { active = false; subscription.unsubscribe() }
  }, [])

  useEffect(() => {
    if (!session?.user?.id) return undefined
    let active = true
    loadWorkspace(supabase, session.user.id)
      .then((result) => { if (active) setWorkspaceState({ session, retry, result }) })
      .catch((error) => { if (active) setWorkspaceState({ session, retry, error: error.message }) })
    return () => { active = false }
  }, [session, retry])

  async function signOut() {
    setSigningOut(true)
    setAuthError('')
    try {
      const { error } = await supabase.auth.signOut()
      if (error) setAuthError('Unable to sign out. Please try again.')
    } catch { setAuthError('Unable to sign out. Please try again.') }
    finally { setSigningOut(false) }
  }

  if (configurationError) return <StateScreen title="Setup needed" message={configurationError} />
  if (session === undefined) return <StateScreen title="Welcome to MediNexus" message="Checking your session…" />
  if (!session) return authError ? <StateScreen title="Connection problem" message={authError} action={() => window.location.reload()} actionLabel="Try again" /> : <Login client={supabase} />
  const current = workspaceState?.session === session && workspaceState.retry === retry ? workspaceState : null
  if (current?.error) return <StateScreen title="Workspace unavailable" message={authError || current.error} action={() => setRetry((value) => value + 1)} actionLabel="Try again" secondary={signOut} secondaryLabel={signingOut ? 'Signing out…' : 'Sign out'} />
  if (!current?.result) return <StateScreen title="Preparing your workspace" message="Checking your facility access…" />
  return <Workspace workspace={current.result} email={session.user.email} onSignOut={signOut} signOutError={authError} signingOut={signingOut} />
}

export default App
