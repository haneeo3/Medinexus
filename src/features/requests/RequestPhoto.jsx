import { useEffect, useState } from 'react'
import { downloadRequestPhoto, getRequestProof } from './proof.js'

export default function RequestPhoto({ client, requestId }) {
  const [photoUrl, setPhotoUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl) }, [photoUrl])

  async function showPhoto() {
    setLoading(true)
    setMessage('')
    try {
      const proof = await getRequestProof(client, requestId)
      if (!proof) { setMessage('No photo is available for this request.'); return }
      const blob = await downloadRequestPhoto(client, proof.object_path)
      setPhotoUrl(URL.createObjectURL(blob))
    } catch {
      setMessage('The photo could not be loaded. Please try again.')
    } finally { setLoading(false) }
  }

  return <section className="request-photo" aria-label={`Photo for request ${requestId}`}>
    <h4>Fulfilment photo</h4>
    {!photoUrl && <button type="button" className="button button-outline" disabled={loading} onClick={showPhoto}>{loading ? 'Loading photo…' : 'View photo'}</button>}
    {photoUrl && <><img src={photoUrl} alt="Prepared medicine supplied for this request" /><button type="button" className="button button-outline" onClick={() => setPhotoUrl('')}>Hide photo</button></>}
    {message && <p role="status">{message}</p>}
  </section>
}
