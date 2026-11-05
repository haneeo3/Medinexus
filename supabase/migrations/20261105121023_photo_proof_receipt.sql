-- Private supplier photo proof and independent receiving-facility confirmation.
-- Apply only through a reviewed development migration; do not apply to live Supabase here.
begin;

alter table public.supply_requests
  drop constraint supply_requests_status_check,
  add constraint supply_requests_status_check
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'RECEIVED', 'CANCELLED'));
alter table public.supply_requests
  add column received_by uuid references public.profiles(id) on delete restrict,
  add column received_at timestamptz,
  add constraint supply_requests_receipt_fields_check check (
    (status = 'RECEIVED' and received_by is not null and received_at is not null)
    or (status <> 'RECEIVED' and received_by is null and received_at is null)
  );
alter table public.request_events
  drop constraint request_events_event_type_check,
  add constraint request_events_event_type_check
    check (event_type in ('CREATED', 'APPROVED', 'REJECTED', 'FULFILLED', 'RECEIVED', 'CANCELLED'));
alter table public.request_events
  drop constraint request_events_previous_status_check,
  add constraint request_events_previous_status_check
    check (previous_status is null or previous_status in ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'RECEIVED', 'CANCELLED')),
  drop constraint request_events_new_status_check,
  add constraint request_events_new_status_check
    check (new_status in ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'RECEIVED', 'CANCELLED'));

create table public.request_proofs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.supply_requests(id) on delete restrict,
  object_path text not null unique,
  uploaded_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint request_proofs_object_path_format check (
    object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$'
  )
);
create index request_proofs_uploaded_by_idx on public.request_proofs(uploaded_by);
alter table public.request_proofs enable row level security;
revoke all on public.request_proofs from public, anon, authenticated;
grant select on public.request_proofs to authenticated;

create function public.is_valid_request_proof_object_path(p_object_path text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|png|webp)$', false);
$$;

-- Proof access deliberately excludes platform-wide access: only the two active
-- facilities on the request can read photo metadata or the private object.
create function public.can_view_request_proof_object(p_object_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.is_valid_request_proof_object_path(p_object_path) and exists (
    select 1
    from public.supply_requests r
    join public.profiles p on p.id = auth.uid() and p.account_status = 'ACTIVE'
    join public.facilities f on f.id = p.facility_id and f.operational_status = 'ACTIVE'
    where r.id = case when public.is_valid_request_proof_object_path(p_object_path)
      then split_part(p_object_path, '/', 1)::uuid else null end
      and p.facility_id in (r.requesting_facility_id, r.supplying_facility_id)
  ), false);
$$;

create function public.can_upload_request_proof_object(p_object_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.is_valid_request_proof_object_path(p_object_path) and exists (
    select 1
    from public.supply_requests r
    join public.profiles p on p.id = auth.uid() and p.account_status = 'ACTIVE'
      and p.facility_id = r.supplying_facility_id and p.role in ('FACILITY_ADMIN', 'SUPPLIER_STAFF')
    join public.facilities f on f.id = p.facility_id and f.operational_status = 'ACTIVE'
    where r.id = case when public.is_valid_request_proof_object_path(p_object_path)
      then split_part(p_object_path, '/', 1)::uuid else null end
      and r.status = 'APPROVED'
  ), false);
$$;

create function public.can_delete_unregistered_request_proof_object(p_object_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_upload_request_proof_object(p_object_path)
    and not exists (select 1 from public.request_proofs rp where rp.object_path = p_object_path);
$$;

revoke all on function public.is_valid_request_proof_object_path(text),
  public.can_view_request_proof_object(text), public.can_upload_request_proof_object(text),
  public.can_delete_unregistered_request_proof_object(text) from public, anon;
grant execute on function public.is_valid_request_proof_object_path(text),
  public.can_view_request_proof_object(text), public.can_upload_request_proof_object(text),
  public.can_delete_unregistered_request_proof_object(text) to authenticated;

create policy request_proofs_participants_read on public.request_proofs
  for select to authenticated using (public.can_view_request_proof_object(object_path));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('request-proof-photos', 'request-proof-photos', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[])
on conflict (id) do update set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

grant usage on schema storage to authenticated;
grant select, insert, delete on storage.objects to authenticated;
create policy request_proof_photos_participants_read on storage.objects
  for select to authenticated
  using (bucket_id = 'request-proof-photos' and public.can_view_request_proof_object(name));
create policy request_proof_photos_supplier_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'request-proof-photos' and public.can_upload_request_proof_object(name));
create policy request_proof_photos_supplier_cleanup on storage.objects
  for delete to authenticated
  using (bucket_id = 'request-proof-photos' and public.can_delete_unregistered_request_proof_object(name));

create function public.fulfil_supply_request_with_proof(p_request_id uuid, p_object_path text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_req public.supply_requests%rowtype; v_row record; v_actor uuid;
begin
  select * into v_req from public.supply_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Request not found'; end if;
  v_actor := public.require_facility_role(v_req.supplying_facility_id, array['FACILITY_ADMIN','SUPPLIER_STAFF']);
  if v_req.status <> 'APPROVED' then
    raise exception using errcode = '22023', message = 'Only approved requests can be fulfilled';
  end if;
  if not public.is_valid_request_proof_object_path(p_object_path)
     or split_part(p_object_path, '/', 1) <> p_request_id::text then
    raise exception using errcode = '22023', message = 'A valid request proof photo path is required';
  end if;
  if not exists (
    select 1 from storage.buckets b join storage.objects o on o.bucket_id = b.id
    where b.id = 'request-proof-photos' and b.public = false and o.name = p_object_path
  ) then
    raise exception using errcode = '22023', message = 'Upload the proof photo to the private request-proof-photos bucket first';
  end if;
  if exists (select 1 from public.request_proofs where request_id = v_req.id) then
    raise exception using errcode = '22023', message = 'A proof photo is already registered for this request';
  end if;
  if v_req.approved_quantity is null or (select coalesce(sum(quantity), 0) from public.request_reservations where supply_request_id = v_req.id) <> v_req.approved_quantity then
    raise exception using errcode = '22023', message = 'Reservation totals are inconsistent';
  end if;
  for v_row in
    select b.id, b.quantity_on_hand, b.quantity_reserved, b.expiry_date, r.quantity
    from public.inventory_batches b join public.request_reservations r on r.inventory_batch_id = b.id
    where r.supply_request_id = v_req.id order by b.expiry_date, b.id for update of b
  loop
    if v_row.expiry_date < current_date or v_row.quantity_reserved < v_row.quantity or v_row.quantity_on_hand < v_row.quantity then
      raise exception using errcode = '22023', message = 'Reserved stock is expired or inconsistent';
    end if;
    update public.inventory_batches set quantity_on_hand = quantity_on_hand - v_row.quantity,
      quantity_reserved = quantity_reserved - v_row.quantity, last_updated_at = now() where id = v_row.id;
    insert into public.stock_movements(facility_id,inventory_batch_id,medicine_id,movement_type,quantity,supply_request_id,performed_by)
      values (v_req.supplying_facility_id,v_row.id,v_req.medicine_id,'FULFILMENT_OUT',v_row.quantity,v_req.id,v_actor);
  end loop;
  insert into public.request_proofs(request_id, object_path, uploaded_by)
    values (v_req.id, p_object_path, v_actor);
  delete from public.request_reservations where supply_request_id = v_req.id;
  update public.supply_requests set status = 'FULFILLED', fulfilled_quantity = approved_quantity where id = v_req.id;
  insert into public.request_events(supply_request_id,event_type,actor_id,previous_status,new_status,metadata)
    values (v_req.id,'FULFILLED',v_actor,'APPROVED','FULFILLED',jsonb_build_object('fulfilled_quantity',v_req.approved_quantity));
  return v_req.id;
end;
$$;

-- Preserve the old RPC signature for callers, but make it fail closed without a path.
create or replace function public.fulfil_supply_request(p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  return public.fulfil_supply_request_with_proof(p_request_id, null);
end;
$$;

create function public.confirm_supply_request_receipt(p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_req public.supply_requests%rowtype; v_actor uuid;
begin
  select * into v_req from public.supply_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Request not found'; end if;
  v_actor := public.require_facility_role(v_req.requesting_facility_id, array['FACILITY_ADMIN','REQUESTING_STAFF']);
  if v_req.status <> 'FULFILLED' then
    raise exception using errcode = '22023', message = 'Only fulfilled requests can be confirmed as received';
  end if;
  update public.supply_requests set status = 'RECEIVED', received_by = v_actor, received_at = now() where id = v_req.id;
  insert into public.request_events(supply_request_id,event_type,actor_id,previous_status,new_status)
    values (v_req.id,'RECEIVED',v_actor,'FULFILLED','RECEIVED');
  return v_req.id;
end;
$$;

revoke all on function public.fulfil_supply_request_with_proof(uuid, text),
  public.fulfil_supply_request(uuid), public.confirm_supply_request_receipt(uuid) from public, anon;
grant execute on function public.fulfil_supply_request_with_proof(uuid, text),
  public.fulfil_supply_request(uuid), public.confirm_supply_request_receipt(uuid) to authenticated;

commit;
