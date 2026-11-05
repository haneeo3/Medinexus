# MediNexus

A healthcare facility medicine-availability and supply-coordination MVP. The React app includes authentication, facility-scoped inventory, explainable medicine discovery, supply requests, and facility profiles with manual licence review.

## Run locally

1. Install Node.js 20 or later and run `npm install`.
2. Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_PUBLISHABLE_KEY` to the project's **publishable** key (or legacy **anon** key). The example has the MediNexus project URL.
3. Run `npm run dev` and open the address printed by Vite.

Never put a Supabase secret or `service_role` key in a `VITE_` variable: these variables are bundled into browser code. `.env.local` is ignored by Git. The same public URL and publishable key must be configured in Netlify before a deployed build.

A new facility administrator creates a Supabase Auth account first. If email confirmation is enabled, they confirm their email and sign in, then provide their name, facility details, address and licence information. The server creates their facility and administrator profile together, with the facility Unverified until manual review. Existing facility administrators who have not submitted their licence are prompted to complete setup; other staff wait until this is done. Staff account creation has not yet been built. The setup screen is an app navigation requirement, not an additional database authorization policy. The app reads profile and facility access from the database; database RLS and RPC permissions enforce security independently of the UI. Facility locations are written addresses; medicine matching does not calculate or use distance.

## Checks

- `npm test` runs mocked authentication, workspace, inventory and medicine discovery screen tests.
- `npm run lint` checks the frontend.
- `npm run build` produces a production build.
- See `supabase/OPERATIONS.md` for database tests and operational rules.

Mocked tests do not replace an end-to-end test with real Supabase Auth accounts. Do not use real patient information in demo data.
