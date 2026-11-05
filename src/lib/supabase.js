import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

function isSecretKey(value) {
  if (!value) return false
  if (value.startsWith('sb_secret_')) return true
  try {
    const payload = value.split('.')[1]
    if (!payload) return false
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return decoded.role === 'service_role'
  } catch {
    return false
  }
}

export const configurationError = !url || !key
  ? 'Supabase is not configured yet. Add the project URL and publishable key to .env.local.'
  : isSecretKey(key)
    ? 'A secret key cannot be used in the browser. Use a publishable or legacy anon key instead.'
    : null

export const supabase = configurationError ? null : createClient(url, key)
