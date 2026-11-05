import { positiveInteger } from '../inventory/inventory.js'
const PAGE_SIZE = 500

export async function loadMedicineCatalogue(client) {
  const all = []
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await client.from('medicines')
      .select('id, name, generic_name, brand_name, active_ingredient, strength, dosage_form, unit_of_measure')
      .order('name').order('id').range(start, start + PAGE_SIZE - 1)
    if (error) throw error
    all.push(...data)
    if (data.length < PAGE_SIZE) return all
  }
}

export function filterMedicines(medicines, term) {
  const words = term.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return medicines.filter((medicine) => {
    const text = [medicine.name, medicine.generic_name, medicine.brand_name, medicine.active_ingredient, medicine.strength, medicine.dosage_form].filter(Boolean).join(' ').toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

export async function findMatches(client, facilityId, medicineId, quantity) {
  if (!medicineId || !positiveInteger(quantity)) throw new Error('Choose a medicine and enter a positive whole-number quantity.')
  const { data, error } = await client.rpc('find_medicine_matches', {
    p_requesting_facility_id: facilityId,
    p_medicine_id: medicineId,
    p_requested_quantity: Number(quantity),
  })
  if (error) {
    if (error.code === '42501') throw new Error('Your account cannot search for this facility.')
    if (error.code === '22023' || error.code === 'P0002') throw new Error('The medicine or quantity is invalid. Please check your selection.')
    throw new Error('Could not search for suppliers. Please try again.')
  }
  if (!data || !Array.isArray(data.matches) || !Array.isArray(data.insufficient)) throw new Error('Could not read the matching results. Please try again.')
  return data
}

// Optional public profile images should never prevent a medicine search.
export async function loadFacilityImages(client, facilityIds) {
  const images = {}
  const ids = [...new Set(facilityIds.filter(Boolean))]
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await client.from('facility_directory').select('id, image_url, verification_status, facility_type_details').in('id', ids.slice(i, i + 100))
    if (error) throw error
    for (const facility of data || []) {
      images[facility.id] = { imageUrl: typeof facility.image_url === 'string' && facility.image_url.startsWith('https://') ? facility.image_url : null, status: facility.verification_status, details: facility.facility_type_details }
    }
  }
  return images
}
