# MediNexus database foundation

The initial migration creates core tables, relationships, quantity constraints, indexes and read-only row-level security policies. It relies on Supabase Auth (`auth.users` and `auth.uid()`).

## Current boundary

This is a foundation, not the finished application. Anonymous clients have no access. Authenticated users receive only the reads allowed by RLS; direct client writes are deliberately disabled. Authorised inventory and request operations are implemented as database functions. Onboarding and the supply request screens are not implemented yet. Aggregate medicine discovery is available through an authenticated matching function. See OPERATIONS.md for the current rules. Do not grant broad table writes to make the UI work.

The initial and transactional operations migrations were applied to the MediNexus Supabase project. Continue developing and testing migrations and policies in a development environment. Never put the service-role key in the browser or commit credentials.

## Remaining work

- Test the transactional operations and audit events with authenticated users against the live Supabase project.
- Define onboarding, role capabilities, verification and stock-freshness policies.
- Test authenticated cross-facility discovery and matching against Supabase with more than one supplier.
- Expand fictional demo data and role-specific test accounts through a safe development-only process.
- Run integration tests against Supabase, including unauthorised access and concurrent reservation tests.

Do not use real patient information. Reported stock is not confirmed availability, quality or clinical suitability.

## Demo-only accounts and facilities

The `demo_facility_accounts` migration is **only for the fictional MediNexus demo project**. It requires two manually created, email-confirmed Auth users, `clinic@medinexus.example` and `supplier@medinexus.example`, and links each to an unverified fictional facility as a facility administrator. Passwords are not in this repository. The migration deliberately fails rather than overwrite existing profiles or facilities.

Do not apply this fixture to production or a real facility environment. Separate demo seed data from production migrations before deploying a real environment. These two accounts are for a demonstration only; role-specific users and end-to-end Supabase tests remain to be prepared.

The `demo_inventory` migration adds two catalogue medicines and four fictional stock batches, including low-stock and approaching-expiry examples. It is demo-only and must also be kept out of production. The expiry warning period in the frontend defaults to 90 days and can be changed using `VITE_EXPIRY_WARNING_DAYS`. Expiry is evaluated using the UTC date.
