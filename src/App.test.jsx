// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mock = vi.hoisted(() => {
  const state = { callback: null, session: null, profile: null, facility: null, profileError: null, facilityError: null }
  const client = {
    auth: {
      onAuthStateChange: vi.fn((callback) => { state.callback = callback; return { data: { subscription: { unsubscribe: vi.fn() } } } }),
      getSession: vi.fn(async () => ({ data: { session: state.session }, error: null })),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
    from: vi.fn((table) => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
      data: table === 'profiles' ? state.profile : state.facility,
      error: table === 'profiles' ? state.profileError : state.facilityError,
    }) }) }) })),
  }
  return { state, client }
})
vi.mock('./lib/supabase', () => ({ supabase: mock.client, configurationError: null }))
import App from './App'

const session = { user: { id: 'user-1', email: 'staff@example.test' } }
const profile = { id: 'user-1', full_name: 'Ada Staff', role: 'REQUESTING_STAFF', account_status: 'ACTIVE', facility_id: 'facility-1' }
const facility = { id: 'facility-1', name: 'Fictional Clinic', address: 'Demo Road', operational_status: 'ACTIVE', verification_status: 'UNVERIFIED' }

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(mock.state, { callback: null, session: null, profile: { ...profile }, facility: { ...facility }, profileError: null, facilityError: null })
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
    expect(screen.getAllByText('Requesting staff').length).toBeGreaterThan(0)
    expect(screen.getByText('Unverified', { exact: false })).toBeInTheDocument()
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
