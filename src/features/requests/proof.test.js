import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROOF_BUCKET, MAX_PHOTO_BYTES, validatePhoto, uploadRequestPhoto, getRequestProof, downloadRequestPhoto } from './proof.js'

afterEach(() => vi.unstubAllGlobals())

describe('private request photo helpers', () => {
  it('accepts only supported non-empty images within the size limit', () => {
    expect(validatePhoto(null)).toMatch(/choose a photo/i)
    expect(validatePhoto({ type: 'text/plain', size: 1 })).toMatch(/JPEG, PNG or WebP/)
    expect(validatePhoto({ type: 'image/jpeg', size: 0 })).toMatch(/larger than 0/)
    expect(validatePhoto({ type: 'image/png', size: MAX_PHOTO_BYTES + 1 })).toMatch(/5 MB/)
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) expect(validatePhoto({ type, size: MAX_PHOTO_BYTES })).toBeNull()
  })

  it('uploads to the private bucket under a generated name, without exposing the original filename', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    const upload = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ upload })
    const client = { storage: { from } }
    const file = { name: 'patient-name.jpg', type: 'image/jpeg', size: 10 }
    const path = await uploadRequestPhoto(client, 'request-id', file)
    expect(path).toBe('request-id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg')
    expect(from).toHaveBeenCalledWith(PROOF_BUCKET)
    expect(upload).toHaveBeenCalledWith(path, file, { contentType: 'image/jpeg', upsert: false })
  })

  it('reports upload failures without claiming fulfilment was recorded', async () => {
    vi.stubGlobal('crypto', { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    const client = { storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: new Error('offline') }) }) } }
    await expect(uploadRequestPhoto(client, 'request-id', { type: 'image/png', size: 10 })).rejects.toThrow('No fulfilment was recorded')
  })

  it('reads proof metadata and downloads through storage', async () => {
    const proof = { object_path: 'request-id/photo.jpg' }
    const query = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: vi.fn().mockResolvedValue({ data: proof, error: null }) }
    const download = vi.fn().mockResolvedValue({ data: 'image', error: null })
    const client = { from: vi.fn(() => query), storage: { from: vi.fn(() => ({ download })) } }
    await expect(getRequestProof(client, 'request-id')).resolves.toEqual(proof)
    expect(query.eq).toHaveBeenCalledWith('request_id', 'request-id')
    await expect(downloadRequestPhoto(client, proof.object_path)).resolves.toBe('image')
    expect(client.storage.from).toHaveBeenCalledWith(PROOF_BUCKET)
  })
})
