-- Secure mutations. Each RPC is a single PostgreSQL transaction.
-- Expiry dates are inclusive; receipt at the requesting facility is a separate operation.
begin;

create function public.require_facility_role(p_facility_id uuid, p_roles text[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := auth.uid();
begin
  if v_actor is null or not exists (
    select 1 from public.profiles p join public.facilities f on f.id = p.facility_id
    where p.id = v_actor and p.facility_id = p_facility_id
      and p.account_status = 'ACTIVE' and p.role = any(p_roles)
      and f.operational_status = 'ACTIVE'
  ) then
    raise exception using errcode = '42501', message = 'Not authorised for this facility or action';
  end if;
  return v_actor;
end;
$$;
revoke all on function public.require_facility_role(uuid, text[]) from public, anon, authenticated;

create function public.create_inventory_batch(
  p_facility_id uuid, p_medicine_id uuid, p_batch_number text,
  p_quantity integer, p_expiry_date date, p_low_stock_threshold integer
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_batch uuid;
begin
  v_actor := public.require_facility_role(p_facility_id, array['FACILITY_ADMIN','INVENTORY_MANAGER']);
  if p_quantity is null or p_quantity < 0 or p_low_stock_threshold is null or p_low_stock_threshold < 0
     or p_expiry_date is null or p_batch_number is null or length(trim(p_batch_number)) = 0 then
    raise exception using errcode = '22023', message = 'Invalid batch details';
  end if;
  if not exists (select 1 from public.medicines where id = p_medicine_id) then
    raise exception using errcode = '22023', message = 'Medicine not found';
  end if;
  insert into public.inventory_batches(facility_id, medicine_id, batch_number, quantity_on_hand, expiry_date, low_stock_threshold)
    values (p_facility_id, p_medicine_id, trim(p_batch_number), p_quantity, p_expiry_date, p_low_stock_threshold)
    returning id into v_batch;
  if p_quantity > 0 then
    insert into public.stock_movements(facility_id, inventory_batch_id, medicine_id, movement_type, quantity, performed_by)
      values (p_facility_id, v_batch, p_medicine_id, 'INITIAL_STOCK', p_quantity, v_actor);
  end if;
  return v_batch;
end;
$$;

create function public.adjust_inventory(p_batch_id uuid, p_delta integer, p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_batch public.inventory_batches%rowtype; v_actor uuid; v_new bigint;
begin
  if p_delta is null or p_delta = 0 then
    raise exception using errcode = '22023', message = 'Adjustment must be non-zero';
  end if;
  select * into v_batch from public.inventory_batches where id = p_batch_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Batch not found'; end if;
  v_actor := public.require_facility_role(v_batch.facility_id, array['FACILITY_ADMIN','INVENTORY_MANAGER']);
  v_new := v_batch.quantity_on_hand::bigint + p_delta::bigint;
  if v_new < v_batch.quantity_reserved or v_new > 2147483647 then
    raise exception using errcode = '22023', message = 'Adjustment would violate available or reserved stock';
  end if;
  update public.inventory_batches set quantity_on_hand = v_new::integer, last_updated_at = now() where id = p_batch_id;
  insert into public.stock_movements(facility_id, inventory_batch_id, medicine_id, movement_type, quantity, performed_by, notes)
    values (v_batch.facility_id, p_batch_id, v_batch.medicine_id,
      case when p_delta > 0 then 'ADJUSTMENT_IN' else 'ADJUSTMENT_OUT' end, abs(p_delta::bigint)::integer, v_actor, p_notes);
  return p_batch_id;
end;
$$;

create function public.create_supply_request(
  p_requesting_facility_id uuid, p_supplying_facility_id uuid, p_medicine_id uuid,
  p_quantity integer, p_notes text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare v_actor uuid; v_id uuid;
begin
  v_actor := public.require_facility_role(p_requesting_facility_id, array['FACILITY_ADMIN','REQUESTING_STAFF']);
  if p_quantity is null or p_quantity <= 0 or p_supplying_facility_id is null
     or p_supplying_facility_id = p_requesting_facility_id then
    raise exception using errcode = '22023', message = 'Invalid supply request';
  end if;
  if not exists (select 1 from public.facilities where id = p_supplying_facility_id and operational_status = 'ACTIVE')
     or not exists (select 1 from public.medicines where id = p_medicine_id) then
    raise exception using errcode = '22023', message = 'Supplier or medicine is unavailable';
  end if;
  insert into public.supply_requests(requesting_facility_id, supplying_facility_id, medicine_id, requested_quantity, created_by, request_notes)
    values (p_requesting_facility_id, p_supplying_facility_id, p_medicine_id, p_quantity, v_actor, p_notes) returning id into v_id;
  insert into public.request_events(supply_request_id,event_type,actor_id,new_status,notes)
    values (v_id,'CREATED',v_actor,'PENDING',p_notes);
  return v_id;
end;
$$;

create function public.approve_supply_request(p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_req public.supply_requests%rowtype; v_batch record; v_actor uuid; v_remaining integer; v_take integer;
begin
  select * into v_req from public.supply_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Request not found'; end if;
  v_actor := public.require_facility_role(v_req.supplying_facility_id, array['FACILITY_ADMIN','SUPPLIER_STAFF']);
  if v_req.status <> 'PENDING' then raise exception using errcode = '22023', message = 'Only pending requests can be approved'; end if;
  if not exists (select 1 from public.facilities where id = v_req.requesting_facility_id and operational_status = 'ACTIVE') then
    raise exception using errcode = '22023', message = 'Requesting facility is inactive';
  end if;
  v_remaining := v_req.requested_quantity;
  -- A consistent expiry/id order is used when taking batch locks for every request.
  for v_batch in
    select id, quantity_on_hand, quantity_reserved from public.inventory_batches
    where facility_id = v_req.supplying_facility_id and medicine_id = v_req.medicine_id
      and expiry_date >= current_date and quantity_on_hand > quantity_reserved
    order by expiry_date, id for update
  loop
    v_take := least(v_remaining, v_batch.quantity_on_hand - v_batch.quantity_reserved);
    if v_take > 0 then
      update public.inventory_batches set quantity_reserved = quantity_reserved + v_take where id = v_batch.id;
      insert into public.request_reservations(supply_request_id,inventory_batch_id,supplying_facility_id,medicine_id,quantity)
        values (v_req.id, v_batch.id, v_req.supplying_facility_id, v_req.medicine_id, v_take);
      v_remaining := v_remaining - v_take;
    end if;
    exit when v_remaining = 0;
  end loop;
  if v_remaining <> 0 then
    raise exception using errcode = '22023', message = 'Insufficient eligible available stock';
  end if;
  update public.supply_requests set status = 'APPROVED', approved_quantity = requested_quantity, reviewed_by = v_actor where id = v_req.id;
  insert into public.request_events(supply_request_id,event_type,actor_id,previous_status,new_status,metadata)
    values (v_req.id,'APPROVED',v_actor,'PENDING','APPROVED',jsonb_build_object('reserved_quantity', v_req.requested_quantity, 'batches', (select coalesce(jsonb_agg(jsonb_build_object('batch_id', inventory_batch_id, 'quantity', quantity) order by inventory_batch_id), '[]'::jsonb) from public.request_reservations where supply_request_id = v_req.id)));
  return v_req.id;
end;
$$;

create function public.reject_supply_request(p_request_id uuid, p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_req public.supply_requests%rowtype; v_actor uuid;
begin
  select * into v_req from public.supply_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Request not found'; end if;
  v_actor := public.require_facility_role(v_req.supplying_facility_id, array['FACILITY_ADMIN','SUPPLIER_STAFF']);
  if v_req.status <> 'PENDING' then raise exception using errcode = '22023', message = 'Only pending requests can be rejected'; end if;
  update public.supply_requests set status = 'REJECTED', reviewed_by = v_actor where id = v_req.id;
  insert into public.request_events(supply_request_id,event_type,actor_id,previous_status,new_status,notes)
    values (v_req.id,'REJECTED',v_actor,'PENDING','REJECTED',p_notes);
  return v_req.id;
end;
$$;

create function public.cancel_supply_request(p_request_id uuid, p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_req public.supply_requests%rowtype; v_row record; v_actor uuid; v_facility uuid;
begin
  select * into v_req from public.supply_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Request not found'; end if;
  select facility_id into v_facility from public.profiles where id = auth.uid();
  if v_facility = v_req.requesting_facility_id then
    v_actor := public.require_facility_role(v_facility, array['FACILITY_ADMIN','REQUESTING_STAFF']);
  elsif v_facility = v_req.supplying_facility_id then
    v_actor := public.require_facility_role(v_facility, array['FACILITY_ADMIN','SUPPLIER_STAFF']);
  else
    raise exception using errcode = '42501', message = 'Not authorised for this request';
  end if;
  if v_req.status not in ('PENDING','APPROVED') then
    raise exception using errcode = '22023', message = 'Only pending or approved requests can be cancelled';
  end if;
  if v_req.status = 'APPROVED' then
    if v_req.approved_quantity is null or (select coalesce(sum(quantity), 0) from public.request_reservations where supply_request_id = v_req.id) <> v_req.approved_quantity then
      raise exception using errcode = '22023', message = 'Reservation totals are inconsistent';
    end if;
    for v_row in
      select b.id, b.quantity_reserved, r.quantity from public.inventory_batches b
      join public.request_reservations r on r.inventory_batch_id = b.id
      where r.supply_request_id = v_req.id order by b.expiry_date, b.id for update of b
    loop
      if v_row.quantity_reserved < v_row.quantity then
        raise exception using errcode = '22023', message = 'Reservation totals are inconsistent';
      end if;
      update public.inventory_batches set quantity_reserved = quantity_reserved - v_row.quantity where id = v_row.id;
    end loop;
    delete from public.request_reservations where supply_request_id = v_req.id;
  end if;
  update public.supply_requests set status = 'CANCELLED' where id = v_req.id;
  insert into public.request_events(supply_request_id,event_type,actor_id,previous_status,new_status,notes)
    values (v_req.id,'CANCELLED',v_actor,v_req.status,'CANCELLED',p_notes);
  return v_req.id;
end;
$$;

create function public.fulfil_supply_request(p_request_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_req public.supply_requests%rowtype; v_row record; v_actor uuid;
begin
  select * into v_req from public.supply_requests where id = p_request_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'Request not found'; end if;
  v_actor := public.require_facility_role(v_req.supplying_facility_id, array['FACILITY_ADMIN','SUPPLIER_STAFF']);
  if v_req.status <> 'APPROVED' then raise exception using errcode = '22023', message = 'Only approved requests can be fulfilled'; end if;
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
  delete from public.request_reservations where supply_request_id = v_req.id;
  update public.supply_requests set status = 'FULFILLED', fulfilled_quantity = approved_quantity where id = v_req.id;
  insert into public.request_events(supply_request_id,event_type,actor_id,previous_status,new_status,metadata)
    values (v_req.id,'FULFILLED',v_actor,'APPROVED','FULFILLED',jsonb_build_object('fulfilled_quantity',v_req.approved_quantity));
  return v_req.id;
end;
$$;

revoke all on function public.create_inventory_batch(uuid,uuid,text,integer,date,integer), public.adjust_inventory(uuid,integer,text), public.create_supply_request(uuid,uuid,uuid,integer,text), public.approve_supply_request(uuid), public.reject_supply_request(uuid,text), public.cancel_supply_request(uuid,text), public.fulfil_supply_request(uuid) from public, anon;
grant execute on function public.create_inventory_batch(uuid,uuid,text,integer,date,integer), public.adjust_inventory(uuid,integer,text), public.create_supply_request(uuid,uuid,uuid,integer,text), public.approve_supply_request(uuid), public.reject_supply_request(uuid,text), public.cancel_supply_request(uuid,text), public.fulfil_supply_request(uuid) to authenticated;
commit;
