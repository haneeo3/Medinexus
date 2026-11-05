import { useEffect, useState } from 'react'
import { supabase, configurationError } from './lib/supabase'
import { loadWorkspace, roleDescriptions, roleLabels } from './lib/workspace'
import Inventory from './features/inventory/Inventory.jsx'
import Discovery from './features/discovery/Discovery.jsx'
import Requests from './features/requests/Requests.jsx'
import Facilities, { FacilityForm } from './features/facilities/Facilities.jsx'
import Dashboard from './features/dashboard/Dashboard.jsx'
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
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [signupMessage, setSignupMessage] = useState('')

  async function handleSubmit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (creatingAccount) {
        const { data, error: signupError } = await client.auth.signUp({ email: email.trim(), password })
        if (signupError) setError('Unable to create your account. Check your details and try again.')
        else if (!data?.session) setSignupMessage('Check your email for a confirmation link. After confirming, return here and sign in to set up your facility.')
      } else {
        const { error: signInError } = await client.auth.signInWithPassword({ email: email.trim(), password })
        if (signInError) setError('Unable to sign in. Check your email and password, then try again.')
      }
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
    <section className="auth-main" aria-label={creatingAccount ? 'Create account' : 'Sign in'}>
      <div className="mobile-brand"><Brand /></div>
      <div className="login-wrap">
        <div className="login-heading"><span className="section-tag">WELCOME TO MEDINEXUS</span><h2>{creatingAccount ? 'Create your account.' : 'Welcome back.'}</h2><p>{creatingAccount ? 'First create your account, then set up your facility.' : 'Sign in to access your facility workspace.'}</p></div>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="field"><label htmlFor="email">Email address</label><input id="email" type="email" autoComplete="username" placeholder="you@facility.com" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
          <div className="field"><label htmlFor="password">Password</label><input id="password" type="password" autoComplete={creatingAccount ? 'new-password' : 'current-password'} minLength={creatingAccount ? 8 : undefined} placeholder={creatingAccount ? 'At least 8 characters' : 'Enter your password'} value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
          {error && <p className="notice notice-error" role="alert">{error}</p>}
          {signupMessage && <p className="notice notice-success" role="status">{signupMessage}</p>}
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? (creatingAccount ? 'Creating account…' : 'Signing in…') : (creatingAccount ? 'Create account' : 'Sign in')}<span aria-hidden="true">→</span></button>
        </form>
<p className="login-help">{creatingAccount ? 'Already have an account?' : 'New to MediNexus?'} <button type="button" className="text-button" disabled={busy} onClick={() => { setCreatingAccount(!creatingAccount); setError(''); setSignupMessage(''); setPassword('') }}>{creatingAccount ? 'Sign in' : 'Create an account'}</button></p>
        <p className="login-help">Facility staff needing access should contact their facility administrator.</p>
        <div className="privacy-note"><span aria-hidden="true">◇</span><p><strong>Your workspace, protected.</strong><br />Access is limited to authorised facility staff.</p></div>
      </div>
      <p className="auth-bottom">MediNexus <span>•</span> Healthcare supply, connected.</p>
    </section>
  </main>
}

// Remember only the selected screen, never form values or private facility data.
function restorePage(profile, facility) {
  const allowed = ['overview']
  if (facility) allowed.push('inventory', 'discovery', 'requests')
  if (['FACILITY_ADMIN', 'PLATFORM_ADMIN'].includes(profile.role)) allowed.push('facilities')
  try {
    const page = sessionStorage.getItem(`medinexus-page:${profile.id}:${facility?.id || 'platform'}`)
    return allowed.includes(page) ? page : 'overview'
  } catch { return 'overview' }
}

function Workspace({ workspace, email, onSignOut, signOutError, signingOut, onRefreshWorkspace }) {
  const { profile } = workspace
  const [facility, setFacility] = useState(workspace.facility)
  const [page, setPage] = useState(() => restorePage(profile, workspace.facility))
  useEffect(() => {
    try { sessionStorage.setItem(`medinexus-page:${profile.id}:${workspace.facility?.id || 'platform'}`, page) } catch { /* Storage can be unavailable. */ }
  }, [page, profile.id, workspace.facility?.id])
  const [requestDraft, setRequestDraft] = useState(null)
  const [requestBusy, setRequestBusy] = useState(false)
  const facilityName = facility?.name || 'Platform workspace'
  const verification = facility?.verification_status?.toLowerCase() || ''
  if (facility && !workspace.setupComplete) return <div className="workspace-layout">
    <header className="topbar"><Brand /><div className="topbar-right"><div className="account-summary"><strong>{profile.full_name}</strong><span>{roleLabels[profile.role]}</span></div><button className="button button-outline" type="button" onClick={onSignOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button></div></header>
    <main className="workspace-main"><section className="facilities-page" aria-labelledby="setup-title">
      <div className="facilities-heading"><div><p className="section-tag">GETTING STARTED</p><h1 id="setup-title">Set up your facility</h1><p>Complete your facility profile before using the workspace. Your facility remains Unverified until a MediNexus administrator reviews it.</p></div></div>
      {signOutError && <p className="notice notice-error" role="alert">{signOutError}</p>}
      {profile.role === 'FACILITY_ADMIN' ? <FacilityForm client={supabase} role={profile.role} item={facility} setup onSaved={onRefreshWorkspace} /> : <p className="facility-note">Your facility administrator needs to submit the facility information and licence details before staff can use the workspace.</p>}
      <p className="facilities-help">Already submitted your details, or unsure whether your submission was saved? <button className="text-button" type="button" onClick={onRefreshWorkspace}>Check setup status</button></p>
    </section></main>
  </div>
  return <div className="workspace-layout">
    <header className="topbar"><Brand /><div className="topbar-right"><div className="account-summary"><strong>{profile.full_name}</strong><span>{roleLabels[profile.role]}</span></div><button className="button button-outline" type="button" onClick={onSignOut} disabled={signingOut || requestBusy}>{signingOut ? 'Signing out…' : 'Sign out'}</button></div></header>
    <main className="workspace-main">
      {(facility || profile.role === 'PLATFORM_ADMIN') && <nav className="workspace-nav" aria-label="Workspace">
        <button type="button" disabled={requestBusy} aria-current={page === 'overview' ? 'page' : undefined} onClick={() => setPage('overview')}>Overview</button>
        {facility && <><button type="button" disabled={requestBusy} aria-current={page === 'inventory' ? 'page' : undefined} onClick={() => setPage('inventory')}>Inventory</button><button type="button" disabled={requestBusy} aria-current={page === 'discovery' ? 'page' : undefined} onClick={() => setPage('discovery')}>Find medicine</button><button type="button" disabled={requestBusy} aria-current={page === 'requests' ? 'page' : undefined} onClick={() => setPage('requests')}>Supply requests</button></>}
        {['FACILITY_ADMIN', 'PLATFORM_ADMIN'].includes(profile.role) && <button type="button" disabled={requestBusy} aria-current={page === 'facilities' ? 'page' : undefined} onClick={() => setPage('facilities')}>{facility ? 'Facility profile' : 'Manage facilities'}</button>}
      </nav>}
      {signOutError && <p className="notice notice-error" role="alert">{signOutError}</p>}
      {page === 'facilities' && ['FACILITY_ADMIN', 'PLATFORM_ADMIN'].includes(profile.role) ? <Facilities client={supabase} role={profile.role} facility={facility} onFacilityUpdated={setFacility} /> : page === 'inventory' && facility ? <Inventory client={supabase} facility={facility} role={profile.role} /> : page === 'discovery' && facility ? <Discovery client={supabase} facility={facility} role={profile.role} onRequest={(draft) => { setRequestDraft(draft); setPage('requests') }} /> : page === 'requests' && facility ? <Requests client={supabase} facility={facility} role={profile.role} draft={requestDraft} onDraftCleared={() => setRequestDraft(null)} onBusyChange={setRequestBusy} /> : <>
      <div className="workspace-heading"><div><p className="section-tag">YOUR WORKSPACE</p><h1>Welcome, {profile.full_name.split(' ')[0]}.</h1><p>You’re signed in to your MediNexus workspace.</p></div><span className="access-chip"><span className="status-dot" /> Active account</span></div>
      <section className="facility-panel" aria-labelledby="facility-heading">
        <div className="panel-icon" aria-hidden="true">✚</div><div className="facility-copy"><span className="section-tag">{facility ? 'YOUR FACILITY' : 'YOUR ACCOUNT'}</span><h2 id="facility-heading">{facilityName}</h2><p>{facility ? facility.address : 'Platform-wide administration'}</p></div>
        {facility && <div className="verification"><span>Platform verification</span><strong>{verification}</strong></div>}
      </section>
      <div className="workspace-grid"><section className="info-panel"><div className="panel-header"><div><p className="section-tag">ACCOUNT DETAILS</p><h2>Your access</h2></div><span className="mini-icon" aria-hidden="true">↗</span></div><dl><div><dt>Signed in as</dt><dd>{email}</dd></div><div><dt>Role</dt><dd>{roleLabels[profile.role]}</dd></div><div><dt>Access area</dt><dd>{roleDescriptions[profile.role]}</dd></div></dl><p className="panel-footnote">Actions are checked by the server for your role and facility.</p></section>
      <section className="info-panel next-panel"><div className="panel-header"><div><p className="section-tag">FACILITY TOOLS</p><h2>Your workspace</h2></div><span className="mini-icon" aria-hidden="true">✦</span></div><p>Explore the tools available in your facility workspace.</p><div className="next-list"><div><span className="list-number">01</span><span>Manage facility inventory</span><small>Available</small></div><div><span className="list-number">02</span><span>Find medicine availability</span><small>Available</small></div><div><span className="list-number">03</span><span>Coordinate supply requests</span><small>Available</small></div></div></section></div>
      {facility && <Dashboard client={supabase} facility={facility} />}
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
      if (active) {
        setAuthError('')
        if (!nextSession) setWorkspaceState(null)
        setSession(nextSession)
      }
    })
    supabase.auth.getSession().then(({ data, error }) => {
      if (!active || receivedEvent) return
      if (error) { setAuthError('Unable to check your session. Please refresh and try again.'); setSession(null) }
      else setSession(data.session)
    }).catch(() => { if (active && !receivedEvent) { setAuthError('Unable to check your session. Please refresh and try again.'); setSession(null) } })
    return () => { active = false; subscription.unsubscribe() }
  }, [])

  const userId = session?.user?.id
  useEffect(() => {
    if (!userId) return undefined
    let active = true
    loadWorkspace(supabase, userId)
      .then((result) => { if (active) setWorkspaceState({ userId, retry, result }) })
      .catch((error) => { if (active) setWorkspaceState({ userId, retry, error: error.message }) })
    return () => { active = false }
  }, [userId, retry])

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
  const current = workspaceState?.userId === userId && workspaceState.retry === retry ? workspaceState : null
  if (current?.error) return <StateScreen title="Workspace unavailable" message={authError || current.error} action={() => setRetry((value) => value + 1)} actionLabel="Try again" secondary={signOut} secondaryLabel={signingOut ? 'Signing out…' : 'Sign out'} />
  if (!current?.result) return <StateScreen title="Preparing your workspace" message="Checking your facility access…" />
  if (current.result.needsRegistration) return <div className="workspace-layout">
    <header className="topbar"><Brand /><div className="topbar-right"><span>{session.user.email}</span><button className="button button-outline" type="button" onClick={signOut} disabled={signingOut}>{signingOut ? 'Signing out…' : 'Sign out'}</button></div></header>
    <main className="workspace-main"><section className="facilities-page" aria-labelledby="registration-title">
      <div className="facilities-heading"><div><p className="section-tag">GETTING STARTED</p><h1 id="registration-title">Set up your facility</h1><p>Your account is ready. Add your facility details and licence to continue. Your facility remains Unverified until reviewed.</p></div></div>
      {authError && <p className="notice notice-error" role="alert">{authError}</p>}
      <FacilityForm client={supabase} role="FACILITY_ADMIN" setup registration onSaved={() => setRetry((value) => value + 1)} />
      <p className="facilities-help">Already submitted your details, or unsure whether your submission was saved? <button className="text-button" type="button" onClick={() => setRetry((value) => value + 1)}>Check setup status</button></p>
    </section></main>
  </div>
  return <Workspace key={userId} workspace={current.result} email={session.user.email} onSignOut={signOut} signOutError={authError} signingOut={signingOut} onRefreshWorkspace={() => setRetry((value) => value + 1)} />
}

export default App
