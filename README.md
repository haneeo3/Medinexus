# MediNexus

A healthcare facility medicine-availability and supply-coordination MVP. The React app includes authentication, facility-scoped inventory and explainable medicine discovery. Supply request screens are still in development.

## Run locally

1. Install Node.js 20 or later and run `npm install`.
2. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_PUBLISHABLE_KEY` to the project's **publishable** key (or legacy **anon** key). The example has the MediNexus project URL.
3. Run `npm run dev` and open the address printed by Vite.

Never put a Supabase secret or `service_role` key in a `VITE_` variable: these variables are bundled into browser code. `.env.local` is ignored by Git. The same public URL and publishable key must be configured in Netlify before a deployed build.

Sign-in requires an existing Supabase Auth user and a corresponding active `profiles` row. Facility staff must also belong to an active facility. Self-registration and staff onboarding have not yet been built. The app reads profile and facility access from the database; database RLS and RPC permissions enforce security independently of the UI.

## Checks

- `npm test` runs mocked authentication, workspace, inventory and medicine discovery screen tests.
- `npm run lint` checks the frontend.
- `npm run build` produces a production build.
- See `supabase/OPERATIONS.md` for database tests and operational rules.

Mocked tests do not replace an end-to-end test with real Supabase Auth accounts. Do not use real patient information in demo data.
