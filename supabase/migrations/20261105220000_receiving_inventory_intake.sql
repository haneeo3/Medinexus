-- Receiving-side inventory intake after a supplier has fulfilled a request.
-- Apply only through a reviewed development migration; do not apply to live Supabase here.
begin;

-- Receipt movements are distinct from supplier fulfilment movements. A receipt is
-- an inbound physical count at the requesting facility and is linked to the request.
alter table public.stock_movements
  drop constraint stock_movements_movement_type_check,
  add constraint stock_movements_movement_type_check
    check (movement_type in ('INITIAL_STOCK', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'FULFILMENT_OUT', 'RECEIPT_IN')),
  add constraint stock_movements_receipt_request_check
    check (movement_type <> 'RECEIPT_IN' or supply_request_id is not null);

-- Keep the received batch lines as immutable-by-client snapshots, including the
-- actual batch/expiry reported at delivery, while linking each line to its stock row.
alter table public.supply_requests
  add constraint supply_requests_receiving_facility_medicine_key
    unique (id, requesting_facility_id, medicine_id);

create table public.supply_request_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  supply_request_id uuid not null,
  receiving_facility_id uuid not null,
  medicine_id uuid not null,
  inventory_batch_id uuid not null,
  batch_number text not null check (length(trim(batch_number)) > 0),
  quantity integer not null check (quantity > 0),
  expiry_date date not null,
  created_at timestamptz not null default now(),
  foreign key (supply_request_id, receiving_facility_id, medicine_id)
    references public.supply_requests(id, requesting_facility_id, medicine_id) on delete restrict,
  foreign key (inventory_batch_id, receiving_facility_id, medicine_id)
    references public.inventory_batches(id, facility_id, medicine_id) on delete restrict,
  unique (supply_request_id, batch_number),
  unique (supply_request_id, inventory_batch_id)
);
create index supply_request_receipt_lines_request_idx
  on public.supply_request_receipt_lines(supply_request_id, created_at);

create function public.can_view_supply_request_receipt(p_request_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(exists (
    select 1
    from public.supply_requests r
    join public.profiles p on p.id = auth.uid() and p.account_status = 'ACTIVE'
      and p.facility_id in (r.requesting_facility_id, r.supplying_facility_id)
    join public.facilities f on f.id = p.facility_id and f.operational_status = 'ACTIVE'
    where r.id = p_request_id
  ), false);
$$;
revoke all on function public.can_view_supply_request_receipt(uuid) from public, anon;
grant execute on function public.can_view_supply_request_receipt(uuid) to authenticated;

alter table public.supply_request_receipt_lines enable row level security;
revoke all on public.supply_request_receipt_lines from public, anon, authenticated;
grant select on public.supply_request_receipt_lines to authenticated;
create policy supply_request_receipt_lines_participants_read
  on public.supply_request_receipt_lines for select to authenticated
  using (public.can_view_supply_request_receipt(supply_request_id));

-- Defend against duplicate receipt movements even if a future privileged code
-- path bypasses the receipt RPC's request-row lock and status transition.
create unique index stock_movements_receipt_once_per_batch_idx
  on public.stock_movements(supply_request_id, inventory_batch_id)
  where movement_type = 'RECEIPT_IN';

create function public.confirm_supply_request_receipt_with_inventory(
  p_request_id uuid,
  p_batches jsonb
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_req public.supply_requests%rowtype;
  v_item jsonb;
  v_batch_number text;
  v_quantity bigint;
  v_expiry_date date;
  v_total bigint := 0;
  v_seen_batch_numbers text[] := array[]::text[];
  v_batch_id uuid;
  v_actor uuid;
begin
  -- Serializes confirmations of this request. Concurrent replays wait, then fail
  -- the FULFILLED status check after the first transaction commits.
  select * into v_req from public.supply_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Request not found'; end if;
  v_actor := public.require_facility_role(v_req.requesting_facility_id, array['FACILITY_ADMIN','REQUESTING_STAFF']);
  if v_req.status <> 'FULFILLED' then
    raise exception using errcode = '22023', message = 'Only fulfilled requests can be confirmed with received inventory';
  end if;
  if v_req.fulfilled_quantity is null or v_req.fulfilled_quantity <= 0 then
    raise exception using errcode = '22023', message = 'Fulfilled quantity is missing or invalid';
  end if;
  if p_batches is null or jsonb_typeof(p_batches) <> 'array' or jsonb_array_length(p_batches) = 0 then
    raise exception using errcode = '22023', message = 'At least one received batch line is required';
  end if;

  -- Validate every line and the aggregate before changing inventory. This MVP
  -- requires a complete exact count; partial or mismatched counts fail closed.
  for v_item in select value from jsonb_array_elements(p_batches) as e(value) loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array['batch_number', 'quantity', 'expiry_date'])
       or (v_item - 'batch_number' - 'quantity' - 'expiry_date') <> '{}'::jsonb
       or jsonb_typeof(v_item->'batch_number') <> 'string'
       or jsonb_typeof(v_item->'quantity') <> 'number'
       or jsonb_typeof(v_item->'expiry_date') <> 'string' then
      raise exception using errcode = '22023', message = 'Each received batch line must contain only batch_number, quantity, and expiry_date';
    end if;

    v_batch_number := btrim(v_item->>'batch_number');
    if length(v_batch_number) = 0 then
      raise exception using errcode = '22023', message = 'Received batch number must not be blank';
    end if;
    if (v_item->>'quantity') !~ '^[1-9][0-9]*$' then
      raise exception using errcode = '22023', message = 'Received quantity must be a positive integer';
    end if;
    v_quantity := (v_item->>'quantity')::bigint;
    if v_quantity > 2147483647 then
      raise exception using errcode = '22023', message = 'Received quantity exceeds the supported inventory range';
    end if;
    if (v_item->>'expiry_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception using errcode = '22023', message = 'Expiry date must use YYYY-MM-DD';
    end if;
    v_expiry_date := (v_item->>'expiry_date')::date;

    if v_batch_number = any(v_seen_batch_numbers) then
      raise exception using errcode = '22023', message = 'A received batch may appear only once';
    end if;
    v_seen_batch_numbers := array_append(v_seen_batch_numbers, v_batch_number);
    v_total := v_total + v_quantity;
    if v_total > v_req.fulfilled_quantity then
      raise exception using errcode = '22023', message = 'Received batch total exceeds fulfilled quantity';
    end if;
  end loop;
  if v_total <> v_req.fulfilled_quantity then
    raise exception using errcode = '22023', message = 'Received batch total must exactly equal fulfilled quantity';
  end if;

  -- Upsert keeps an identical physical batch as one inventory row. A batch-number
  -- collision with a different expiry is rejected rather than corrupting identity.
  for v_item in select e.value from jsonb_array_elements(p_batches) as e(value) order by btrim(e.value->>'batch_number') loop
    v_batch_number := btrim(v_item->>'batch_number');
    v_quantity := (v_item->>'quantity')::bigint;
    v_expiry_date := (v_item->>'expiry_date')::date;

    insert into public.inventory_batches as existing_batch
      (facility_id, medicine_id, batch_number, quantity_on_hand, expiry_date, low_stock_threshold, last_updated_at)
    values
      (v_req.requesting_facility_id, v_req.medicine_id, v_batch_number, v_quantity::integer, v_expiry_date, 0, now())
    on conflict (facility_id, medicine_id, batch_number) do update
      set quantity_on_hand = existing_batch.quantity_on_hand + excluded.quantity_on_hand,
          last_updated_at = now()
      where existing_batch.expiry_date = excluded.expiry_date
        and existing_batch.quantity_on_hand::bigint + excluded.quantity_on_hand::bigint <= 2147483647
    returning existing_batch.id into v_batch_id;
    if not found then
      raise exception using errcode = '22023', message = 'Received batch number already exists with a different expiry or inventory would overflow';
    end if;

    insert into public.supply_request_receipt_lines
      (supply_request_id, receiving_facility_id, medicine_id, inventory_batch_id, batch_number, quantity, expiry_date)
    values
      (v_req.id, v_req.requesting_facility_id, v_req.medicine_id, v_batch_id, v_batch_number, v_quantity::integer, v_expiry_date);
    insert into public.stock_movements
      (facility_id, inventory_batch_id, medicine_id, movement_type, quantity, supply_request_id, performed_by, notes)
    values
      (v_req.requesting_facility_id, v_batch_id, v_req.medicine_id, 'RECEIPT_IN', v_quantity::integer,
       v_req.id, v_actor, 'Received against supply request ' || v_req.id::text);
  end loop;

  update public.supply_requests
    set status = 'RECEIVED', received_by = v_actor, received_at = now()
    where id = v_req.id;
  insert into public.request_events
    (supply_request_id, event_type, actor_id, previous_status, new_status, metadata)
  values
    (v_req.id, 'RECEIVED', v_actor, 'FULFILLED', 'RECEIVED',
     jsonb_build_object('received_quantity', v_total, 'batches',
       (select jsonb_agg(jsonb_build_object('batch_number', batch_number, 'quantity', quantity, 'expiry_date', expiry_date)
                         order by batch_number)
        from public.supply_request_receipt_lines where supply_request_id = v_req.id)));
  return v_req.id;
end;
$$;

-- Retain the old signature for compatibility, but forbid confirmations without
-- actual batch details. Existing already-RECEIVED rows are left untouched.
create or replace function public.confirm_supply_request_receipt(p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = '22023',
    message = 'Received batch details are required; use confirm_supply_request_receipt_with_inventory';
end;
$$;

revoke all on function public.confirm_supply_request_receipt_with_inventory(uuid, jsonb),
  public.confirm_supply_request_receipt(uuid) from public, anon;
grant execute on function public.confirm_supply_request_receipt_with_inventory(uuid, jsonb),
  public.confirm_supply_request_receipt(uuid) to authenticated;

commit;
