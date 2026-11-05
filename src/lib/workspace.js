export const roleLabels = {
  PLATFORM_ADMIN: 'Platform administrator',
  FACILITY_ADMIN: 'Facility administrator',
  INVENTORY_MANAGER: 'Inventory manager',
  REQUESTING_STAFF: 'Requesting staff',
  SUPPLIER_STAFF: 'Supplier staff',
}

export const roleDescriptions = {
  PLATFORM_ADMIN: 'Platform administration',
  FACILITY_ADMIN: 'Facility administration, inventory and supply requests',
  INVENTORY_MANAGER: 'Inventory management',
  REQUESTING_STAFF: 'Medicine discovery and outgoing requests',
  SUPPLIER_STAFF: 'Incoming request review and fulfilment',
}

// Profile and facility data come from protected database reads, never user metadata.
export async function loadWorkspace(client, userId) {
  const { data: profile, error } = await client.from('profiles')
    .select('id, full_name, facility_id, role, account_status')
    .eq('id', userId).maybeSingle()
  if (error) throw new Error('We could not load your account. Please try again.')
  if (!profile) {
    const { data: canRegister, error: registrationError } = await client.rpc('can_register_facility')
    if (registrationError || typeof canRegister !== 'boolean') throw new Error('We could not check your account. Please try again.')
    if (canRegister) return { needsRegistration: true }
  }
  if (!profile || profile.account_status !== 'ACTIVE' || !roleLabels[profile.role]) {
    throw new Error('Your account has no active workspace. Please contact your administrator.')
  }
  if (profile.role === 'PLATFORM_ADMIN') return { profile, facility: null }
  if (!profile.facility_id) throw new Error('Your account has no facility. Please contact your administrator.')
  let { data: facility, error: facilityError } = await client.from('facility_directory')
    .select('id, name, facility_type, address, latitude, longitude, image_url, operational_status, verification_status, facility_type_details')
    .eq('id', profile.facility_id).maybeSingle()
  if (facilityError && ['42P01', 'PGRST205'].includes(facilityError.code)) {
    const fallback = await client.from('facilities').select('id, name, facility_type, address, operational_status')
      .eq('id', profile.facility_id).maybeSingle()
    facility = fallback.data ? { ...fallback.data, verification_status: 'UNVERIFIED' } : null
    facilityError = fallback.error
  }
  if (facilityError) throw new Error('We could not load your facility. Please try again.')
  if (!facility || facility.operational_status !== 'ACTIVE') {
    throw new Error('Your facility is unavailable or inactive. Please contact your administrator.')
  }
  const { data: setupComplete, error: setupError } = await client.rpc('facility_setup_complete')
  if (setupError || typeof setupComplete !== 'boolean') {
    throw new Error('We could not check your facility setup. Please try again.')
  }
  return { profile, facility, setupComplete }
}
