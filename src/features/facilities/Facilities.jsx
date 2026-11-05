import { useCallback, useEffect, useState } from 'react'
import { uploadFacilityPhoto } from './facilityPhoto.js'
import { validatePhoto } from '../requests/proof.js'
import './facilities.css'

const FIELDS = 'id, name, facility_type, address, latitude, longitude, image_url, verification_status, verification_valid_until, operational_status, created_at, updated_at, facility_type_details'
const LICENCE_FIELDS = 'facility_id, license_number, license_authority, license_expiry_date, submitted_at, updated_at'
const blankFacility = { name: '', facility_type: 'PHARMACY', address: '', latitude: '', longitude: '', image_url: '', facility_type_details: '', operational_status: 'ACTIVE' }
const blankLicence = { license_number: '', license_authority: '', license_expiry_date: '' }
const typeQuestions = {
  PHARMACY: { details: 'Pharmacy services (optional)', example: 'For example: dispensing, retail or wholesale', number: 'Pharmacy premises licence number', authority: 'Licence issuing authority', expiry: 'Pharmacy licence expiry date' },
  CLINIC: { details: 'Clinic services (optional)', example: 'For example: primary care or dental care', number: 'Clinic registration or licence number', authority: 'Registration or licensing authority', expiry: 'Registration or licence expiry date' },
  HOSPITAL: { details: 'Hospital departments (optional)', example: 'For example: emergency or maternity', number: 'Hospital registration or licence number', authority: 'Registration or licensing authority', expiry: 'Registration or licence expiry date' },
}
const defaultQuestions = { details: 'Facility services (optional)', example: 'Describe the services your facility offers', number: 'Licence number', authority: 'Issuing authority', expiry: 'Licence expiry date' }

function badge(status) {
  return status === 'VERIFIED' ? 'Verified by MediNexus' : status === 'REJECTED' ? 'Not verified' : 'Unverified'
}
function values(row = {}) {
  return { ...blankFacility, ...row, latitude: row.latitude ?? '', longitude: row.longitude ?? '', image_url: row.image_url ?? '', facility_type_details: row.facility_type_details ?? '' }
}
function fieldError(form) {
  if (!form.name.trim() || !form.address.trim()) return 'Enter the facility name and address.'
  if (form.image_url && !/^https:\/\//i.test(form.image_url)) return 'The facility image link must start with https://.'
  return ''
}
async function listFacilities(client, facilityId) {
  if (facilityId) {
    const { data, error } = await client.from('facility_directory').select(FIELDS).eq('id', facilityId).maybeSingle()
    if (error) throw error
    return data ? [data] : []
  }
  const rows = []
  for (let offset = 0; ; offset += 200) {
    const { data, error } = await client.from('facility_directory').select(FIELDS).order('name').order('id').range(offset, offset + 199)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < 200) return rows
  }
}
async function getLicence(client, id) {
  const { data, error } = await client.from('facility_licenses').select(LICENCE_FIELDS).eq('facility_id', id).maybeSingle()
  if (error) throw error
  return data
}
function Field({ label, name, value, onChange, type = 'text', required = false, children }) {
  return <label className="facility-field"><span>{label}</span>{children || <input name={name} type={type} value={value} onChange={onChange} required={required} />}</label>
}
function Status({ status }) { return <span className={`facility-status facility-status-${(status || 'unverified').toLowerCase()}`}>{badge(status)}</span> }

export function FacilityForm({ client, role, item, onSaved, onCancel, setup = false, registration = false }) {
  const isPlatform = role === 'PLATFORM_ADMIN'
  const [form, setForm] = useState(() => registration ? { ...values(item), facility_type: '' } : values(item))
  const [licence, setLicence] = useState(blankLicence)
  const [fullName, setFullName] = useState('')
  const [photo, setPhoto] = useState(null)
  const [loading, setLoading] = useState(Boolean(item?.id && !isPlatform))
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  useEffect(() => {
    if (!item?.id || isPlatform) return
    let active = true
    getLicence(client, item.id).then((row) => { if (active && row) setLicence({ ...blankLicence, ...row }) })
      .catch(() => { if (active) { setLoadFailed(true); setError('Could not load licence details. Close and reopen the form to retry.') } })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [client, isPlatform, item?.id])
  const questions = typeQuestions[form.facility_type] || defaultQuestions
  function change(event) {
    const { name, value } = event.target
    setForm((old) => ({ ...old, [name]: value, ...(name === 'facility_type' && value !== old.facility_type ? { facility_type_details: '' } : {}) }))
  }
  function changeLicence(event) { setLicence((old) => ({ ...old, [event.target.name]: event.target.value })) }
  async function submit(event) {
    event.preventDefault()
    if (busy || uncertain || loading || loadFailed) return
    const validation = fieldError(form)
    if (validation) { setError(validation); return }
    if (photo) { const photoError = validatePhoto(photo); if (photoError) { setError(photoError); return } }
    if (form.facility_type_details.length > 1000) { setError('Facility services or departments must be 1,000 characters or fewer.'); return }
    if (registration && !fullName.trim()) { setError('Enter your name.'); return }
    if (!isPlatform && (!licence.license_number.trim() || !licence.license_authority.trim() || !licence.license_expiry_date)) { setError('Enter the licence number, issuing authority and expiry date.'); return }
    if (!window.confirm(isPlatform ? 'Save this facility profile?' : 'Submit this profile for review? Its status will become Unverified.')) return
    const addressChanged = item && form.address.trim() !== item.address?.trim()
    const common = { p_name: form.name.trim(), p_facility_type: form.facility_type, p_address: form.address.trim(), p_image_url: form.image_url.trim() || null }
    const coordinates = { p_latitude: addressChanged || form.latitude === '' ? null : Number(form.latitude), p_longitude: addressChanged || form.longitude === '' ? null : Number(form.longitude) }
    const licenceArgs = { p_license_number: licence.license_number.trim(), p_license_authority: licence.license_authority.trim(), p_license_expiry_date: licence.license_expiry_date }
    const name = registration ? 'register_facility_with_details' : isPlatform ? 'platform_admin_save_facility_with_details' : 'submit_facility_profile_with_details'
    const details = { p_facility_type_details: form.facility_type_details.trim() || null }
    const args = registration ? { p_full_name: fullName.trim(), ...common, ...licenceArgs, ...details } : isPlatform ? { p_facility_id: item?.id || null, ...common, ...coordinates, p_operational_status: form.operational_status, ...details } : { ...common, ...coordinates, ...licenceArgs, ...details }
    setBusy(true); setError('')
    let uploaded = null
    try {
      if (photo) {
        uploaded = await uploadFacilityPhoto(client, item.id, photo)
        args.p_image_url = uploaded.url
      }
      const { data, error: rpcError } = await client.rpc(name, args)
      if (rpcError) {
        if (['22023', '42501', 'P0002', '23514', '23505'].includes(rpcError.code)) {
          setError('Could not save this facility. Check the details and your permissions.'); return
        }
        setUncertain(true); setError('The result is uncertain. Check setup status or refresh the facility list before trying again.'); return
      }
      if (data == null) { setUncertain(true); setError('The result is uncertain. Check setup status or refresh the facility list before trying again.'); return }
      onSaved(isPlatform ? 'Facility saved.' : 'Profile submitted. Your facility remains unverified until reviewed.')
    } catch (err) {
      if (err?.code === 'PHOTO_UPLOAD_FAILED') setError('The photo could not be uploaded. The profile was not saved. Please try again.')
      else { setUncertain(true); setError('The result is uncertain. Check setup status or refresh the facility list before trying again.') }
    } finally { setBusy(false) }
  }
  return <section className="facility-box"><h2>{isPlatform ? (item ? 'Edit facility' : 'Add a facility') : 'Submit your facility profile'}</h2>
    <p className="facilities-help">{isPlatform ? 'Create or update a clinic, pharmacy or hospital. New facilities are unverified.' : 'An administrator checks your licence before granting verification. Saving these details resets your status to Unverified.'}</p>
    {loading && <p role="status">Loading licence details…</p>}
    <form className="facility-form" onSubmit={submit}>
      {registration && <Field label="Your name" name="full_name" value={fullName} onChange={(event) => setFullName(event.target.value)} required />}
      <Field label="Facility name" name="name" value={form.name} onChange={change} required />
      <label className="facility-field"><span>Facility type</span><select name="facility_type" value={form.facility_type} onChange={change} required>{registration && <option value="" disabled>Select facility type</option>}<option value="PHARMACY">Pharmacy</option><option value="CLINIC">Clinic</option><option value="HOSPITAL">Hospital</option></select></label>
      <Field label="Location / address" name="address" value={form.address} onChange={change} required />
      {form.facility_type && <Field label={questions.details} name="facility_type_details" value={form.facility_type_details} onChange={change}><input name="facility_type_details" value={form.facility_type_details} onChange={change} maxLength={1000} placeholder={questions.example} /></Field>}
      {form.facility_type && <p className="facilities-help facility-field-full">Services and departments may be visible to other facilities. Do not include patient information.</p>}
      <Field label="Facility image link (HTTPS, optional)" name="image_url" type="url" value={form.image_url} onChange={change} />
      {item?.id && !registration ? <label className="facility-field facility-field-full"><span>Upload facility photo</span><input type="file" aria-label="Upload facility photo" accept="image/jpeg,image/png,image/webp" disabled={busy || loading || loadFailed || uncertain} onChange={(event) => { setPhoto(event.target.files?.[0] || null); setError('') }} /><small>Choose a JPEG, PNG or WebP image, up to 5 MB. Uploaded photos are public. Do not include patient information.</small>{photo && <small>Selected: {photo.name}. It will be uploaded when you save.</small>}</label> : <p className="facilities-help facility-field-full">To upload a photo from your device, save the facility first, then edit its profile.</p>}
      {isPlatform ? <label className="facility-field"><span>Facility status</span><select name="operational_status" value={form.operational_status} onChange={change}><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option></select></label> : <>
        <p className="facility-note facility-field-full">Licence details are private to your facility administrator and MediNexus reviewers. Do not include patient information.</p>
        <Field label={questions.number} name="license_number" value={licence.license_number} onChange={changeLicence} required />
        <Field label={questions.authority} name="license_authority" value={licence.license_authority} onChange={changeLicence} required />
        <Field label={questions.expiry} name="license_expiry_date" type="date" value={licence.license_expiry_date} onChange={changeLicence} required />
      </>}
      {error && <p role="alert" className="facility-error facility-field-full">{error}</p>}
      <div className="facility-form-actions"><button type="submit" className="button button-primary" disabled={busy || loading || uncertain || loadFailed}>{busy ? 'Saving…' : isPlatform ? 'Save facility' : 'Submit for review'}</button>{!setup && <button type="button" className="button button-outline" disabled={busy} onClick={onCancel}>Cancel</button>}</div>
    </form>
  </section>
}

function Review({ client, item, onDone, onCancel }) {
  const [licence, setLicence] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [today] = useState(() => new Date().toISOString().slice(0, 10))
  const licenceExpired = Boolean(licence?.license_expiry_date && licence.license_expiry_date < today)
  const alreadyReviewed = item.verification_status !== 'UNVERIFIED'
  useEffect(() => {
    let active = true
    getLicence(client, item.id).then((data) => { if (active) setLicence(data) }).catch(() => { if (active) { setLoadFailed(true); setError('Could not load licence details.') } }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [client, item.id])
  async function decide(decision) {
    if (busy || uncertain || loading || loadFailed) return
    if (!notes.trim()) { setError('Add the record checked and review notes.'); return }
    if (!window.confirm(`${decision === 'VERIFIED' ? 'Verify' : 'Reject'} this facility? Only decide after checking the relevant official records.`)) return
    setBusy(true); setError('')
    try {
      const { data, error: rpcError } = await client.rpc('review_facility_verification', { p_facility_id: item.id, p_decision: decision, p_notes: notes.trim() })
      if (rpcError) {
        if (['22023', '42501', 'P0002', '23514'].includes(rpcError.code)) { setError('Review could not be saved. Check the licence and your permissions.'); return }
        setUncertain(true); setError('The result is uncertain. Close this review and refresh before trying again.'); return
      }
      if (data == null) { setUncertain(true); setError('The result is uncertain. Close this review and refresh before trying again.'); return }
      onDone(decision === 'VERIFIED' ? 'Facility verified after review.' : 'Facility review rejected.')
    } catch { setUncertain(true); setError('The result is uncertain. Close this review and refresh before trying again.') }
    finally { setBusy(false) }
  }
  return <section className="facility-box" aria-labelledby="review-title"><h2 id="review-title">Review {item.name}</h2>
    <p className="facility-note">Check the facility against relevant official records before making a decision. A MediNexus badge records your review; it is not a regulator-issued badge. Check <a href="https://pcncore.azurewebsites.net/PublicSearch/SearchForPremises" target="_blank" rel="noopener noreferrer">PCN pharmacy premises</a> or the <a href="https://hfr.fmohconnect.gov.ng/facilitieslist" target="_blank" rel="noopener noreferrer">Nigeria Health Facility Registry</a> as appropriate, and confirm current licensing with the relevant authority.</p>
    {loading ? <p role="status">Loading licence details…</p> : licence ? <div className="facility-review"><h3>Submitted licence</h3><dl><div><dt>Licence number</dt><dd>{licence.license_number}</dd></div><div><dt>Issuing authority</dt><dd>{licence.license_authority}</dd></div><div><dt>Expiry</dt><dd>{licence.license_expiry_date || 'Not provided'}</dd></div></dl></div> : <p className="facilities-help">No licence details submitted yet. Ask the facility administrator to sign in, open Facility profile, and submit its licence details before verifying.</p>}
    {!loading && licenceExpired && <p className="facilities-help">This licence has expired. The facility administrator must submit current licence details before verification.</p>}
    {!loading && alreadyReviewed && <p className="facilities-help">This facility has already been reviewed. Its administrator must submit an updated profile before another review.</p>}
    <label className="facility-field"><span>Record checked and review notes</span><textarea rows="3" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
    {error && <p role="alert" className="facility-error">{error}</p>}
    <div className="facility-card-actions"><button className="button button-primary" type="button" disabled={busy || loading || !licence || licenceExpired || alreadyReviewed || uncertain} onClick={() => decide('VERIFIED')}>Verify facility</button><button className="button button-outline" type="button" disabled={busy || loading || uncertain || loadFailed || alreadyReviewed} onClick={() => decide('REJECTED')}>Reject verification</button><button className="button button-outline" type="button" disabled={busy} onClick={onCancel}>Close review</button></div>
  </section>
}

export default function Facilities({ client, role, facility, onFacilityUpdated }) {
  const isPlatform = role === 'PLATFORM_ADMIN'
  const facilityId = facility?.id
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [editor, setEditor] = useState(null)
  const [review, setReview] = useState(null)
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try { const data = await listFacilities(client, isPlatform ? null : facilityId); setRows(data); if (!isPlatform && data[0]) onFacilityUpdated?.(data[0]) }
    catch { setError('Could not load facilities. Please try again.') }
    finally { setLoading(false) }
  }, [client, isPlatform, facilityId, onFacilityUpdated])
  useEffect(() => {
    let active = true
    listFacilities(client, isPlatform ? null : facilityId).then((data) => {
      if (active) { setRows(data); if (!isPlatform && data[0]) onFacilityUpdated?.(data[0]) }
    }).catch(() => { if (active) setError('Could not load facilities. Please try again.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [client, isPlatform, facilityId, onFacilityUpdated])
  function saved(message) { setEditor(null); setReview(null); setSuccess(message); void load() }
  return <section className="facilities-page" aria-labelledby="facilities-title">
    <div className="facilities-heading"><div><p className="section-tag">FACILITY MANAGEMENT</p><h1 id="facilities-title">{isPlatform ? 'Manage facilities' : 'Your facility profile'}</h1><p>{isPlatform ? 'Manage profiles and review submitted licences.' : 'Keep your facility details and licence information up to date.'}</p></div><button type="button" className="button button-outline" disabled={loading} onClick={() => { setSuccess(''); void load() }}>Refresh list</button></div>
    <p className="facility-note">Facilities remain unverified until a MediNexus administrator checks their information. Listing a facility does not establish that it is licensed.</p>
    {success && <p className="notice notice-success" role="status">{success}</p>}
    {error && <p className="notice notice-error" role="alert">{error}</p>}
    {loading && <p className="facility-empty" role="status">Loading facilities…</p>}
    {!loading && !error && <div className="facilities-grid">
      {isPlatform && !editor && !review && <div><button type="button" className="button button-primary" onClick={() => { setSuccess(''); setEditor({ mode: 'create' }) }}>Add facility</button></div>}
      {editor && <FacilityForm key={editor.item?.id || 'new'} client={client} role={role} item={editor.item} onSaved={saved} onCancel={() => { setEditor(null); void load() }} />}
      {review && <Review key={review.id} client={client} item={review} onDone={saved} onCancel={() => { setReview(null); void load() }} />}
      {!editor && !review && rows.length === 0 && <p className="facility-empty">No facilities found.</p>}
      {!editor && !review && rows.map((item) => <article className="facility-box facility-card" key={item.id}>
        {item.image_url && <img className="facility-photo" src={item.image_url} alt="" referrerPolicy="no-referrer" />}
        <div className="facility-card-body"><h2>{item.name}</h2><p>{item.facility_type?.toLowerCase()} · {item.address}</p>{item.facility_type_details && <p>{(typeQuestions[item.facility_type] || defaultQuestions).details.replace(' (optional)', '')}: {item.facility_type_details}</p>}<p>{item.operational_status === 'ACTIVE' ? 'Active' : 'Inactive'}</p><Status status={item.verification_status} />
          <div className="facility-card-actions"><button className="button button-outline" type="button" onClick={() => { setSuccess(''); setEditor({ item }) }}>{isPlatform ? 'Edit facility' : 'Edit profile and submit licence'}</button>{isPlatform && <button className="button button-outline" type="button" onClick={() => { setSuccess(''); setReview(item) }}>Review licence</button>}</div>
        </div>
      </article>)}
    </div>}
  </section>
}
