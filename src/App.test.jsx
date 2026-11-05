// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

configure({ asyncUtilTimeout: 10000 })

const mock = vi.hoisted(() => {
  const state = { callback: null, session: null, profile: null, facility: null, profileError: null, facilityError: null, setupComplete: true, setupError: null }
  const client = {
    auth: {
      onAuthStateChange: vi.fn((callback) => { state.callback = callback; return { data: { subscription: { unsubscribe: vi.fn() } } } }),
      getSession: vi.fn(async () => ({ data: { session: state.session }, error: null })),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
    },
    rpc: vi.fn(),
    from: vi.fn((table) => {
      if (['profiles', 'facilities', 'facility_directory', 'facility_licenses'].includes(table)) return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: table === 'profiles' ? state.profile : table === 'facility_licenses' ? null : state.facility,
        error: table === 'profiles' ? state.profileError : table === 'facility_licenses' ? null : state.facilityError,
      }) }) }) }
      const query = { select: () => query, eq: () => query, or: () => query, in: () => query, order: () => query, range: async () => ({ data: [], error: null }) }
      return query
    }),
  }
  return { state, client }
})
vi.mock('./lib/supabase', () => ({ supabase: mock.client, configurationError: null }))
import App from './App'

const session = { user: { id: 'user-1', email: 'staff@example.test' } }
const profile = { id: 'user-1', full_name: 'Ada Staff', role: 'REQUESTING_STAFF', account_status: 'ACTIVE', facility_id: 'facility-1' }
const facility = { id: 'facility-1', name: 'Fictional Clinic', address: 'Demo Road', operational_status: 'ACTIVE', verification_status: 'UNVERIFIED' }

beforeEach(() => {
  sessionStorage.clear()
  vi.clearAllMocks()
  Object.assign(mock.state, { callback: null, session: null, profile: { ...profile }, facility: { ...facility }, profileError: null, facilityError: null, setupComplete: true, setupError: null })
  mock.client.rpc.mockImplementation(async (name) => name === 'facility_setup_complete' ? { data: mock.state.setupComplete, error: mock.state.setupError } : name === 'can_register_facility' ? { data: false, error: null } : { data: 'facility-1', error: null })
  mock.client.auth.signInWithPassword.mockImplementation(async () => {
    mock.state.callback('SIGNED_IN', session)
    return { error: null }
  })
  mock.client.auth.signOut.mockImplementation(async () => {
    mock.state.callback('SIGNED_OUT', null)
    return { error: null }
  })
})
afterEach(cleanup)

describe('facility authentication', () => {
  it('signs in and shows only the user facility and role', async () => {
    const user = userEvent.setup()
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'staff@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'test-password' } })
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(mock.client.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'staff@example.test', password: 'test-password' })
    expect(await screen.findByRole('heading', { name: 'Fictional Clinic' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Good day, Fictional Clinic' })).toBeInTheDocument()
    expect(screen.getAllByText('Requesting staff').length).toBeGreaterThan(0)
    expect(screen.getByText('Unverified', { exact: false })).toBeInTheDocument()
  })

  it('creates the account before asking for facility information', async () => {
    mock.client.auth.signUp.mockResolvedValue({ data: { session: null }, error: null })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Create an account' }))
    expect(screen.queryByLabelText('Facility name')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'new@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secure-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))
    expect(await screen.findByText(/Check your email for a confirmation link/)).toBeInTheDocument()
    expect(mock.client.auth.signUp).toHaveBeenCalledWith({ email: 'new@example.test', password: 'secure-password' })
  })

  it('asks a new signed-in account to register its facility using an address', async () => {
    mock.state.session = session
    mock.state.profile = null
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mock.client.rpc.mockImplementation(async (name) => {
      if (name === 'can_register_facility') return { data: true, error: null }
      if (name === 'facility_setup_complete') return { data: true, error: null }
      if (name === 'register_facility') { mock.state.profile = { ...profile, role: 'FACILITY_ADMIN' }; return { data: 'facility-1', error: null } }
    })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Set up your facility' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/latitude/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/longitude/i)).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ada' } })
    fireEvent.change(screen.getByLabelText('Facility name'), { target: { value: 'Fictional Clinic' } })
    fireEvent.change(screen.getByLabelText('Facility type'), { target: { value: 'CLINIC' } })
    fireEvent.change(screen.getByLabelText('Location / address'), { target: { value: 'Demo Road' } })
    fireEvent.change(screen.getByLabelText('Licence number'), { target: { value: 'LIC-123' } })
    fireEvent.change(screen.getByLabelText('Issuing authority'), { target: { value: 'Health Authority' } })
    fireEvent.change(screen.getByLabelText('Licence expiry date'), { target: { value: '2099-12-31' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }))
    expect(await screen.findByRole('button', { name: 'Inventory' })).toBeInTheDocument()
    expect(mock.client.rpc).toHaveBeenCalledWith('register_facility', { p_full_name: 'Ada', p_name: 'Fictional Clinic', p_facility_type: 'CLINIC', p_address: 'Demo Road', p_image_url: null, p_license_number: 'LIC-123', p_license_authority: 'Health Authority', p_license_expiry_date: '2099-12-31' })
    confirm.mockRestore()
  })

  it('keeps the current screen when the same user session refreshes', async () => {
    mock.state.session = session
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Find medicine' }))
    expect(screen.getByRole('button', { name: 'Find medicine' })).toHaveAttribute('aria-current', 'page')
    const profileReads = mock.client.from.mock.calls.filter(([table]) => table === 'profiles').length
    act(() => mock.state.callback('TOKEN_REFRESHED', { ...session, access_token: 'refreshed-token' }))
    expect(screen.getByRole('button', { name: 'Find medicine' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('heading', { name: 'Preparing your workspace' })).not.toBeInTheDocument()
    expect(mock.client.from.mock.calls.filter(([table]) => table === 'profiles')).toHaveLength(profileReads)
  })

  it('restores the screen after a reload for the same user', async () => {
    mock.state.session = session
    const first = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Find medicine' }))
    await waitFor(() => expect(sessionStorage.getItem('medinexus-page:user-1:facility-1')).toBe('discovery'))
    first.unmount()
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Find medicine' })).toHaveAttribute('aria-current', 'page')
  })

  it('does not restore a different user’s screen', async () => {
    sessionStorage.setItem('medinexus-page:user-1:facility-1', 'discovery')
    mock.state.session = { user: { id: 'user-2', email: 'other@example.test' } }
    mock.state.profile = { ...profile, id: 'user-2', facility_id: 'facility-2' }
    mock.state.facility = { ...facility, id: 'facility-2', name: 'Other Clinic' }
    render(<App />)
    expect(await screen.findByRole('button', { name: 'Overview' })).toHaveAttribute('aria-current', 'page')
  })

  it('shows an error for invalid credentials without revealing account details', async () => {
    mock.client.auth.signInWithPassword.mockResolvedValue({ error: { message: 'internal detail' } })
    const user = userEvent.setup()
    render(<App />)
    fireEvent.change(await screen.findByLabelText('Email address'), { target: { value: 'staff@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'incorrect' } })
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Unable to sign in')
    expect(screen.queryByText('internal detail')).not.toBeInTheDocument()
  })

  it('blocks accounts without an active profile', async () => {
    mock.state.session = session
    mock.state.profile = null
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Workspace unavailable' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Fictional Clinic' })).not.toBeInTheDocument()
  })

  it('blocks inactive facilities', async () => {
    mock.state.session = session
    mock.state.facility = { ...facility, operational_status: 'INACTIVE' }
    render(<App />)
    expect(await screen.findByText(/facility is unavailable or inactive/i)).toBeInTheDocument()
  })

  it('supports platform administrators without a facility', async () => {
    mock.state.session = session
    mock.state.profile = { ...profile, role: 'PLATFORM_ADMIN', facility_id: null }
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Platform workspace' })).toBeInTheDocument()
    expect(mock.client.from).not.toHaveBeenCalledWith('facilities')
  })

  it('requires a facility administrator to submit setup before entering the workspace', async () => {
    mock.state.session = session
    mock.state.profile = { ...profile, role: 'FACILITY_ADMIN' }
    mock.state.facility = { ...facility, facility_type: 'CLINIC', latitude: 7.1, longitude: 3.3, image_url: 'https://example.test/facility.jpg' }
    mock.state.setupComplete = false
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    mock.client.rpc.mockImplementation(async (name) => {
      if (name === 'facility_setup_complete') return { data: mock.state.setupComplete, error: null }
      mock.state.setupComplete = true
      return { data: [{ facility_id: 'facility-1' }], error: null }
    })
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Set up your facility' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Inventory' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Facility image link (HTTPS, optional)')).toHaveValue('https://example.test/facility.jpg')
    fireEvent.change(screen.getByLabelText('Licence number'), { target: { value: 'LIC-123' } })
    fireEvent.change(screen.getByLabelText('Issuing authority'), { target: { value: 'Ministry of Health' } })
    fireEvent.change(screen.getByLabelText('Licence expiry date'), { target: { value: '2099-12-31' } })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit for review' })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }))
    expect(await screen.findByRole('button', { name: 'Inventory' })).toBeInTheDocument()
    expect(mock.client.rpc).toHaveBeenCalledWith('submit_facility_profile', expect.objectContaining({ p_license_number: 'LIC-123', p_image_url: 'https://example.test/facility.jpg', p_latitude: 7.1, p_longitude: 3.3 }))
    expect(screen.getByText('Unverified', { exact: false })).toBeInTheDocument()
    confirm.mockRestore()
  })

  it('asks other staff to wait for their facility administrator', async () => {
    mock.state.session = session
    mock.state.setupComplete = false
    render(<App />)
    expect(await screen.findByRole('heading', { name: 'Set up your facility' })).toBeInTheDocument()
    expect(screen.getByText(/facility administrator needs to submit/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Inventory' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Licence number')).not.toBeInTheDocument()
    mock.state.setupComplete = true
    fireEvent.click(screen.getByRole('button', { name: 'Check setup status' }))
    expect(await screen.findByRole('button', { name: 'Inventory' })).toBeInTheDocument()
  })

  it('does not bypass setup when the status check fails', async () => {
    mock.state.session = session
    mock.state.setupError = { message: 'offline' }
    render(<App />)
    expect(await screen.findByText(/could not check your facility setup/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Inventory' })).not.toBeInTheDocument()
  })

  it('signs out of a protected workspace', async () => {
    mock.state.session = session
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('heading', { name: 'Fictional Clinic' })
    await user.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByLabelText('Email address')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Fictional Clinic' })).not.toBeInTheDocument()
  })

  it('does not show the previous facility after an account switch', async () => {
    mock.state.session = session
    render(<App />)
    await screen.findByRole('heading', { name: 'Fictional Clinic' })
    mock.state.profile = { ...profile, id: 'user-2', full_name: 'Bola Staff', facility_id: 'facility-2' }
    mock.state.facility = { ...facility, id: 'facility-2', name: 'Other Clinic' }
    act(() => mock.state.callback('SIGNED_IN', { user: { id: 'user-2', email: 'other@example.test' } }))
    expect(screen.queryByRole('heading', { name: 'Fictional Clinic' })).not.toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'Other Clinic' })).toBeInTheDocument()
  })
})
