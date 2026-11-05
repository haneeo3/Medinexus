-- Facility-scoped inventory metadata edits with an immutable change record.
begin;

create table public.inventory_batch_changes (
  id uuid primary key default gen_random_uuid(),
  inventory_batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  facility_id uuid not null references public.facilities(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  before_metadata jsonb not null,
  after_metadata jsonb not null,
  notes text,
  created_at timestamptz not null default now()
);

create index inventory_batch_changes_batch_idx
  on public.inventory_batch_changes(inventory_batch_id, created_at desc);

alter table public.inventory_batch_changes enable row level security;
create policy inventory_batch_changes_read on public.inventory_batch_changes
  for select to authenticated using (public.can_access_facility(facility_id));

revoke all on public.inventory_batch_changes from public, anon, authenticated;
grant select on public.inventory_batch_changes to authenticated;

create function public.update_inventory_batch(
  p_batch_id uuid,
  p_batch_number text,
  p_expiry_date date,
  p_low_stock_threshold integer,
  p_notes text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_batch public.inventory_batches%rowtype;
  v_actor uuid;
  v_batch_number text;
  v_before jsonb;
  v_after jsonb;
begin
  if p_batch_id is null then
    raise exception using errcode = '22023', message = 'Batch id is required';
  end if;

  select * into v_batch
    from public.inventory_batches
    where id = p_batch_id
    for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'Batch not found';
  end if;

  v_actor := public.require_facility_role(
    v_batch.facility_id, array['FACILITY_ADMIN','INVENTORY_MANAGER']
  );

  if p_batch_number is null or length(trim(p_batch_number)) = 0
     or length(trim(p_batch_number)) > 200
     or p_expiry_date is null
     or p_low_stock_threshold is null or p_low_stock_threshold < 0
     or (p_notes is not null and
         (length(trim(p_notes)) = 0 or length(p_notes) > 2000)) then
    raise exception using errcode = '22023', message = 'Invalid inventory metadata';
  end if;

  v_batch_number := trim(p_batch_number);
  if p_expiry_date is distinct from v_batch.expiry_date
     and v_batch.quantity_reserved <> 0 then
    raise exception using errcode = '22023', message = 'Cannot change expiry date while stock is reserved';
  end if;

  v_before := jsonb_build_object(
    'batch_number', v_batch.batch_number,
    'expiry_date', v_batch.expiry_date,
    'low_stock_threshold', v_batch.low_stock_threshold
  );
  v_after := jsonb_build_object(
    'batch_number', v_batch_number,
    'expiry_date', p_expiry_date,
    'low_stock_threshold', p_low_stock_threshold
  );

  if v_before = v_after then
    return p_batch_id;
  end if;

  begin
    update public.inventory_batches
      set batch_number = v_batch_number,
          expiry_date = p_expiry_date,
          low_stock_threshold = p_low_stock_threshold
      where id = p_batch_id;
  exception when unique_violation then
    raise exception using errcode = '23505', message = 'Batch number already exists for this facility and medicine';
  end;

  insert into public.inventory_batch_changes(
    inventory_batch_id, facility_id, actor_id, before_metadata, after_metadata, notes
  ) values (
    p_batch_id, v_batch.facility_id, v_actor, v_before, v_after, p_notes
  );
  return p_batch_id;
end;
$$;

revoke all on function public.update_inventory_batch(uuid, text, date, integer, text)
  from public, anon, authenticated;
grant execute on function public.update_inventory_batch(uuid, text, date, integer, text)
  to authenticated;

commit;
