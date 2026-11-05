# MediNexus fictional demo seed

`20261105230000_20_demo_hospitals.sql` is an optional demo-project seed, deliberately outside `supabase/migrations`. Do not deploy it to production or apply it to a real facility environment. It was applied to the MediNexus demo project as the fictional_demo_hospitals operation. Use only in a reviewed demo environment.

The seed uses one transaction and requires an explicit SQL-session opt-in: run `SET medinexus.demo_seed = 'enabled';` immediately before executing the file. It also refuses to run unless both known MediNexus demo facility IDs/names and both known catalogue IDs/formulations are present, plus an existing active `PLATFORM_ADMIN` profile. No secrets or credentials are needed. It does not change schema.

It adds 20 deterministic `MediNexus Demo/Fictional Hospital 01`–`20` hospital facilities with fictional placeholder addresses, null coordinates, `UNVERIFIED` status and no profiles or logins. It reuses the existing Paracetamol 500 mg tablet and Amoxicillin 250 mg capsule catalogue IDs and adds seven generic formulations: Paracetamol 1 g tablet, Amoxicillin 500 mg capsule, Ibuprofen 200 mg tablet, Oral Rehydration Salts 20.5 g powder sachet, Cetirizine 10 mg tablet, Metformin 500 mg tablet and Omeprazole 20 mg capsule. It adds 82 deterministic batches with batch numbers explicitly marked `SIM-`; every initial-stock movement has a demo note, is attributed to an existing active platform admin, and records the simulated starting quantity.

Scenarios include fresh and stale stock, low quantities, insufficient and sufficient quantities, split batches whose availability aggregates, near-expiry and expired inventory (expired stock is excluded from matching), multiple formulations/strengths, and medicines absent at a facility or entirely unstocked in the test baseline. All reserved quantities are zero. The seed creates no supply requests, reservations, profiles, logins, real locations, or verified claims. It never updates existing facilities, medicines, batches or audit rows: deterministic-ID/data conflicts or operated stock stop the transaction rather than being overwritten. Re-running an unchanged seed is idempotent.

## Local verification

From the repository root run `node supabase/tests/local_demo_hospitals.cjs`. The test uses PGlite with the repository's real schema migrations (excluding demo data/account/coordinate fixtures), local Auth/Storage stubs and fictional fixture rows. It checks the opt-in gate, guards and prerequisites, 20 facilities, seven added medicines, 82 batches and audit movements, no reservations/profiles/requests, idempotency, preservation of pre-existing records, formulation separation, matching and insufficient/absent/expired/fresh/stale/near-expiry scenarios. It never connects to Supabase or another remote database.

## Try the scenarios

Sign in as the existing demo clinic and search for Paracetamol 500 mg tablets with a quantity of 20. Hospital 01 has enough simulated stock, Hospitals 03 and 04 have insufficient stock, Hospital 07 is stale, and Hospital 06 has only expired stock and is excluded. Hospital 08 has two batches totalling 14 tablets. Search for Paracetamol 1 g to see a separate formulation. Hospital accounts are not provisioned: simulated hospitals cannot sign in or approve requests, and their low-stock or expiry dashboards cannot be opened as a hospital user.
