// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Facilities from './Facilities.jsx'

const facility = { id: 'f1', name: 'Clinic One', facility_type: 'CLINIC', address: 'Demo Road', latitude: 7.1, longitude: 3.3, image_url: null, verification_status: 'UNVERIFIED', operational_status: 'ACTIVE' }
const licence = { facility_id: 'f1', license_number: 'LIC-123', license_authority: 'Ministry of Health', license_expiry_date: '2099-12-31' }
let client
function makeClient() {
  return {
    from: vi.fn((table) => {
      const query = { select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query), range: vi.fn(async () => ({ data: [facility], error: null })), maybeSingle: vi.fn(async () => ({ data: table === 'facility_directory' ? facility : licence, error: null })) }
      return query
    }),
    rpc: vi.fn(async () => ({ data: 'f1', error: null })),
  }
}
beforeEach(() => { client = makeClient(); vi.spyOn(window, 'confirm').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('facility profiles and manual review', () => {
  it('lets facility administrators submit private licence details but not verify', async () => {
    render(<Facilities client={client} role="FACILITY_ADMIN" facility={facility} />)
    expect(await screen.findByText('Unverified')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Verify facility' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile and submit licence' }))
    expect(await screen.findByDisplayValue('LIC-123')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Location / address'), { target: { value: 'New Road' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('submit_facility_profile', {
      p_name: 'Clinic One', p_facility_type: 'CLINIC', p_address: 'New Road', p_latitude: null, p_longitude: null, p_image_url: null,
      p_license_number: 'LIC-123', p_license_authority: 'Ministry of Health', p_license_expiry_date: '2099-12-31',
    }))
    expect(await screen.findByText(/remains unverified until reviewed/i)).toBeInTheDocument()
  })

  it('preserves existing coordinates when the address is unchanged without asking the user for them', async () => {
    render(<Facilities client={client} role="FACILITY_ADMIN" facility={facility} />)
    await screen.findByText('Unverified')
    fireEvent.click(screen.getByRole('button', { name: 'Edit profile and submit licence' }))
    await screen.findByDisplayValue('LIC-123')
    expect(screen.queryByLabelText(/latitude/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/longitude/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('submit_facility_profile', expect.objectContaining({ p_address: 'Demo Road', p_latitude: 7.1, p_longitude: 3.3 })))
  })

  it('lets platform admins add an unverified facility', async () => {
    render(<Facilities client={client} role="PLATFORM_ADMIN" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add facility' }))
    fireEvent.change(screen.getByLabelText('Facility name'), { target: { value: 'New Hospital' } })
    fireEvent.change(screen.getByLabelText('Facility type'), { target: { value: 'HOSPITAL' } })
    fireEvent.change(screen.getByLabelText('Location / address'), { target: { value: 'Abeokuta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save facility' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('platform_admin_save_facility', {
      p_facility_id: null, p_name: 'New Hospital', p_facility_type: 'HOSPITAL', p_address: 'Abeokuta', p_latitude: null, p_longitude: null, p_image_url: null, p_operational_status: 'ACTIVE',
    }))
  })

  it('requires a manual review note before verification', async () => {
    render(<Facilities client={client} role="PLATFORM_ADMIN" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review licence' }))
    expect(await screen.findByText('LIC-123')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Verify facility' }))
    expect(screen.getByRole('alert')).toHaveTextContent('record checked')
    expect(client.rpc).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Record checked and review notes'), { target: { value: 'Licence checked against official register' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify facility' }))
    await waitFor(() => expect(client.rpc).toHaveBeenCalledWith('review_facility_verification', { p_facility_id: 'f1', p_decision: 'VERIFIED', p_notes: 'Licence checked against official register' }))
  })

  it('blocks a review when the private licence cannot be loaded', async () => {
    client.from.mockImplementation((table) => {
      const query = { select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query), range: vi.fn(async () => ({ data: [facility], error: null })), maybeSingle: vi.fn(async () => ({ data: null, error: table === 'facility_licenses' ? { message: 'offline' } : null })) }
      return query
    })
    render(<Facilities client={client} role="PLATFORM_ADMIN" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review licence' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load licence')
    expect(screen.getByRole('button', { name: 'Verify facility' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Reject verification' })).toBeDisabled()
  })

  it('explains why an expired licence cannot be verified', async () => {
    client.from.mockImplementation(() => {
      const query = { select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query), range: vi.fn(async () => ({ data: [facility], error: null })), maybeSingle: vi.fn(async () => ({ data: { ...licence, license_expiry_date: '2000-01-01' }, error: null })) }
      return query
    })
    render(<Facilities client={client} role="PLATFORM_ADMIN" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review licence' }))
    expect(await screen.findByText(/licence has expired/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify facility' })).toBeDisabled()
  })

  it('does not offer verification without a submitted licence', async () => {
    client.from.mockImplementation((table) => {
      const query = { select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query), range: vi.fn(async () => ({ data: [facility], error: null })), maybeSingle: vi.fn(async () => ({ data: table === 'facility_licenses' ? null : facility, error: null })) }
      return query
    })
    render(<Facilities client={client} role="PLATFORM_ADMIN" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Review licence' }))
    expect(await screen.findByText(/No licence details submitted yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Verify facility' })).toBeDisabled()
  })
})
