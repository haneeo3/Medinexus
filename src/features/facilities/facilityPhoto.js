import { validatePhoto } from '../requests/proof.js'

export const FACILITY_PHOTO_BUCKET = 'facility-photos'
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export async function uploadFacilityPhoto(client, facilityId, file) {
  const message = validatePhoto(file)
  if (message) throw new Error(message)
  if (!facilityId || !globalThis.crypto?.randomUUID) throw new Error('Unable to create a secure photo identifier.')
  const path = `${facilityId}/${globalThis.crypto.randomUUID()}.${EXTENSIONS[file.type]}`
  const bucket = client.storage.from(FACILITY_PHOTO_BUCKET)
  let result
  try { result = await bucket.upload(path, file, { contentType: file.type, upsert: false }) }
  catch { throw Object.assign(new Error('Photo upload failed'), { code: 'PHOTO_UPLOAD_FAILED' }) }
  if (result.error) throw Object.assign(new Error('Photo upload failed'), { code: 'PHOTO_UPLOAD_FAILED' })
  const { data } = bucket.getPublicUrl(path)
  if (!data?.publicUrl?.startsWith('https://')) throw new Error('Unable to create a photo link.')
  return { path, url: data.publicUrl }
}
