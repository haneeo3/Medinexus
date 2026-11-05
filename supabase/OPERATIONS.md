# Inventory and supply request operations

The RPCs in the transactional migration identify the actor from Supabase Auth and require an active profile and active facility. Do not trust client-supplied user IDs or grant direct table writes.

## MVP rules

- Facility administrators and inventory managers can create batches, edit batch metadata and adjust stock at their own facility. Initial quantities and adjustments create stock movements. An adjustment cannot consume reserved stock. Metadata changes are separately audited; expiry cannot change while stock is reserved.
- Facility administrators and requesting staff can create outgoing requests for an active supplier and catalogue medicine. Approval, not creation, confirms whether enough eligible stock is available.
- Facility administrators and supplier staff can approve or reject pending incoming requests. Approval allocates the entire requested quantity across non-expired batches in expiry/date ID order. Batch locks and the request status change run in the same transaction. Partial approvals are not supported.
- Requesting staff or authorised supplier staff may cancel a pending or approved request for their own facility. Cancellation releases the reservation; terminal requests cannot be cancelled.
- Authorised supplier staff can fulfil an approved request once, after uploading a proof photo to the private `request-proof-photos` bucket. The object path must be `<request-uuid>/<file-uuid>.(jpg|png|webp)` with lowercase canonical UUIDs. The bucket limits uploads to 5 MiB and JPEG, PNG or WebP MIME types. `fulfil_supply_request_with_proof(p_request_id, p_object_path)` verifies the private uploaded object, request binding, reservations and expiry, then atomically deducts supplier stock, records the proof and events, and marks the request `FULFILLED`. Missing, mismatched or repeated proof/fulfilment attempts fail without committing changes. The legacy `fulfil_supply_request(p_request_id)` remains callable for compatibility but fails closed because it cannot provide a photo path.
- Only active users at either active facility on the request can read proof metadata or private photo objects. Only authorised supplier administrators/staff can upload for their own approved incoming requests. They can delete an uploaded object only while it is unregistered; a registered proof is not client-deletable. An abandoned object can remain if its request is no longer approved, and may require trusted storage administration to clean up.
- The requesting facility administrator or requesting staff can call `confirm_supply_request_receipt(p_request_id)` once after fulfilment. This records `received_by`, `received_at` and a `RECEIVED` event. It does not create receiving-facility inventory; transfer intake and quantity reconciliation are separate operational work.
- Reserving or releasing stock does not refresh the physical inventory timestamp. All stock remains reported availability and requires confirmation.

## RPC signatures

- `create_inventory_batch(p_facility_id, p_medicine_id, p_batch_number, p_quantity, p_expiry_date, p_low_stock_threshold)`
- `adjust_inventory(p_batch_id, p_delta, p_notes)`
- `update_inventory_batch(p_batch_id, p_batch_number, p_expiry_date, p_low_stock_threshold, p_notes)`
- `find_medicine_matches(p_requesting_facility_id, p_medicine_id, p_requested_quantity)` returns full matches, separately listed insufficient stock and effective scoring settings.
- `create_supply_request(p_requesting_facility_id, p_supplying_facility_id, p_medicine_id, p_quantity, p_notes)`
- `approve_supply_request(p_request_id)`
- `reject_supply_request(p_request_id, p_notes)`
- `cancel_supply_request(p_request_id, p_notes)`
- `fulfil_supply_request_with_proof(p_request_id, p_object_path)`
- `fulfil_supply_request(p_request_id)` (compatibility signature; fails closed without a proof path)
- `confirm_supply_request_receipt(p_request_id)`

Mutation functions return the affected batch or request UUID; the matching function returns a JSON result. PostgreSQL rejects invalid input, unauthorised actions, insufficient stock and invalid status transitions. Integration tests against a real Supabase instance, including simultaneous approvals, remain required before relying on this design.

## Local tests

`tests/inventory_metadata.cjs` checks metadata authorization, isolation and audit. `tests/operations.cjs` exercises the workflow with PGlite and a Supabase Auth stub. `tests/photo_proof_receipt.cjs` applies the initial schema, transactional operations and photo/receipt migrations locally, seeds isolated fictional facilities, and stubs Supabase Auth and Storage tables. Demo-account, inventory and coordinate seed migrations are intentionally omitted. It checks proof path/bucket constraints, table and object RLS, role and facility isolation, upload/cleanup, atomic fulfilment, and independent receipt confirmation. `tests/concurrency.cjs` uses two independent connections to an isolated PostgreSQL 17 server and verifies that competing approvals cannot allocate the same stock and concurrent duplicate fulfilment deducts stock only once. The temporary server is stopped after the test.

Install `@electric-sql/pglite`, `pg` and `embedded-postgres@17.11.0-beta.19` in a separate test environment and make them available on `NODE_PATH`, then run the scripts from the repository root. Run the photo/receipt suite with `NODE_PATH="$HYPER_SCRATCH_DIR/node_modules" node supabase/tests/photo_proof_receipt.cjs`; it requires only PGlite. These local tests passed, but they do not replace authenticated integration tests on Supabase.

## Medicine discovery and scoring

The matching RPC checks the caller's active facility and role, then aggregates only positive, unreserved, non-expired batches for the exact medicine at other active facilities. Facilities with insufficient eligible stock appear separately; no score can override eligibility. Full matches are ranked by quantity (50%), distance (30%) and freshness (20%) by default. Quantity is capped at 100, so all full matches have a quantity score of 100. Distance uses a straight-line estimate and declines to zero at 100 km; missing coordinates use a configurable fallback of 50/100 rather than an invented distance. Freshness uses the oldest update among eligible positive-availability batches and declines to zero over 168 hours. Data at least 168 hours old is flagged, not excluded. The singleton settings table is configurable through trusted database administration; clients cannot modify it. These are demo defaults, not validated operational parameters.

Matching does not reserve or guarantee stock and does not assess quality, clinical suitability, regulatory compliance or delivery. The demo coordinates in the demo_coordinates migration are invented for fictional facilities and must never be presented as real locations. The deployed demo currently has one supplier; local tests include multiple suppliers, insufficient stock, stale data, inactive facilities and expired batches.

Run `NODE_PATH="$HYPER_SCRATCH_DIR/node_modules" node supabase/tests/medicine_matching.cjs` for the local matching checks. Authenticated end-to-end comparisons across multiple real Supabase accounts remain outstanding.
