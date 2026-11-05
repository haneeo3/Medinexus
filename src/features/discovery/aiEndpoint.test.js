import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseMedicineSearch } from '../../../netlify/functions/parse-medicine-search.mjs'

const config = { SUPABASE_URL: 'https://supabase.test', SUPABASE_PUBLISHABLE_KEY: 'public-key', GROQ_API_KEY: 'secret-key' }
const uid = '10000000-0000-0000-0000-000000000001'
const facilityId = '20000000-0000-0000-0000-000000000001'
const fields = { medicineName: 'amoxicillin', genericName: null, brandName: null, activeIngredient: null, strength: '250 mg', dosageForm: 'capsule', unit: 'capsule', quantity: 20 }
function request(query = '20 amoxicillin 250 mg capsules', token = 'user-token') {
  return new Request('https://site.test/api', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) })
}
function mockFetch({ inactive = false, badAi = false } = {}) {
  return vi.fn(async (url) => {
    if (url.endsWith('/auth/v1/user')) return Response.json({ id: uid })
    if (url.includes('/rest/v1/profiles')) return Response.json([{ facility_id: facilityId, role: 'REQUESTING_STAFF', account_status: inactive ? 'INACTIVE' : 'ACTIVE' }])
    if (url.includes('/rest/v1/facility_directory')) return Response.json([{ id: facilityId, operational_status: 'ACTIVE' }])
    if (url.includes('api.groq.com')) return Response.json({ choices: [{ message: { content: JSON.stringify(badAi ? { ...fields, quantity: -1 } : fields) } }] })
    throw new Error('unexpected request')
  })
}
afterEach(() => vi.unstubAllGlobals())

describe('medicine search endpoint', () => {
  it('checks authentication and never sends the user token to Groq', async () => {
    const fetchMock = mockFetch(); vi.stubGlobal('fetch', fetchMock)
    const response = await parseMedicineSearch(request(), config)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ fields })
    const [url, options] = fetchMock.mock.calls.at(-1)
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer secret-key')
    expect(JSON.stringify(options)).not.toContain('user-token')
    expect(JSON.parse(options.body).response_format.json_schema.strict).toBe(true)
  })
  it('rejects unauthenticated or inactive accounts before calling Groq', async () => {
    const fetchMock = mockFetch({ inactive: true }); vi.stubGlobal('fetch', fetchMock)
    const missing = await parseMedicineSearch(new Request('https://site.test/api', { method: 'POST' }), config)
    expect(missing.status).toBe(401)
    const inactive = await parseMedicineSearch(request(), config)
    expect(inactive.status).toBe(403)
    expect(fetchMock.mock.calls.some(([url]) => url.includes('api.groq.com'))).toBe(false)
  })
  it('rejects invalid model output without inventing missing values', async () => {
    vi.stubGlobal('fetch', mockFetch({ badAi: true }))
    const response = await parseMedicineSearch(request(), config)
    expect(response.status).toBe(502)
  })
  it('does not add ingredients, brands, strengths or quantities absent from the search', async () => {
    const base = mockFetch()
    vi.stubGlobal('fetch', vi.fn(async (url, options) => url.includes('api.groq.com')
      ? Response.json({ choices: [{ message: { content: JSON.stringify({ ...fields, brandName: 'Imaginary brand', strength: '500 mg', quantity: 50 }) } }] })
      : base(url, options)) )
    const response = await parseMedicineSearch(request(), config)
    expect(response.status).toBe(200)
    const { fields: result } = await response.json()
    expect(result.brandName).toBeNull()
    expect(result.strength).toBeNull()
    expect(result.quantity).toBeNull()
  })

  it('does not treat the strength unit as the inventory unit', async () => {
    const base = mockFetch()
    vi.stubGlobal('fetch', vi.fn(async (url, options) => url.includes('api.groq.com')
      ? Response.json({ choices: [{ message: { content: JSON.stringify({ ...fields, unit: 'mg' }) } }] })
      : base(url, options)))
    const response = await parseMedicineSearch(request(), config)
    expect((await response.json()).fields.unit).toBeNull()
  })

  it('reports missing configuration without exposing secrets', async () => {
    const response = await parseMedicineSearch(request(), { ...config, GROQ_API_KEY: '' })
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('secret-key')
  })
})
