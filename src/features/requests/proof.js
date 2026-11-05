export const PROOF_BUCKET = 'request-proof-photos'
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export function validatePhoto(file) {
  if (!file) return 'Choose a photo before continuing.'
  if (!EXTENSIONS[file.type]) return 'Choose a JPEG, PNG or WebP image.'
  if (file.size <= 0 || file.size > MAX_PHOTO_BYTES) return 'The image must be larger than 0 and no more than 5 MB.'
  return null
}

export async function uploadRequestPhoto(client, requestId, file) {
  const error = validatePhoto(file)
  if (error) throw new Error(error)
  if (!globalThis.crypto?.randomUUID) throw new Error('This browser cannot securely create a photo identifier. Use a current browser.')
  // The original filename is intentionally not retained in the private object path.
  const path = `${requestId}/${globalThis.crypto.randomUUID()}.${EXTENSIONS[file.type]}`
  const { error: uploadError } = await client.storage.from(PROOF_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
  if (uploadError) throw new Error('The photo could not be uploaded. No fulfilment was recorded; please try again.')
  return path
}

export async function getRequestProof(client, requestId) {
  const { data, error } = await client.from('request_proofs')
    .select('id, request_id, object_path, uploaded_by, created_at')
    .eq('request_id', requestId).maybeSingle()
  if (error) throw error
  return data
}

export async function downloadRequestPhoto(client, objectPath) {
  const { data, error } = await client.storage.from(PROOF_BUCKET).download(objectPath)
  if (error || !data) throw error || new Error('Photo unavailable')
  return data
}
