-- Add or reuse an exact formulation and create its first batch atomically.
-- Client table writes remain disabled; this RPC owns both catalogue and stock writes.
begin;

create function public.create_inventory_batch_with_medicine(
  p_facility_id uuid,
  p_medicine_name text,
  p_generic_name text,
  p_brand_name text,
  p_active_ingredient text,
  p_strength text,
  p_dosage_form text,
  p_unit_of_measure text,
  p_batch_number text,
  p_quantity integer,
  p_expiry_date date,
  p_low_stock_threshold integer
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid;
  v_medicine uuid;
  v_batch uuid;
  v_matches integer;
  v_brand text := nullif(trim(p_brand_name), '');
begin
  v_actor := public.require_facility_role(p_facility_id, array['FACILITY_ADMIN','INVENTORY_MANAGER']);

  if p_medicine_name is null or length(trim(p_medicine_name)) = 0
     or p_generic_name is null or length(trim(p_generic_name)) = 0
     or p_active_ingredient is null or length(trim(p_active_ingredient)) = 0
     or p_strength is null or length(trim(p_strength)) = 0
     or p_dosage_form is null or length(trim(p_dosage_form)) = 0
     or p_unit_of_measure is null or length(trim(p_unit_of_measure)) = 0
     or length(trim(p_medicine_name)) > 200
     or length(trim(p_generic_name)) > 200
     or (v_brand is not null and length(trim(v_brand)) > 200)
     or length(trim(p_active_ingredient)) > 200
     or length(trim(p_strength)) > 200
     or length(trim(p_dosage_form)) > 200
     or length(trim(p_unit_of_measure)) > 200
     or p_batch_number is null or length(trim(p_batch_number)) = 0 or length(trim(p_batch_number)) > 100
     or p_quantity is null or p_quantity < 0
     or p_low_stock_threshold is null or p_low_stock_threshold < 0
     or p_expiry_date is null then
    raise exception using errcode = '22023', message = 'Invalid medicine or batch details';
  end if;

  -- Serialise concurrent attempts for the same normalized formulation. The database
  -- still compares every supplied formulation field before reuse; this is not clinical matching.
  perform pg_advisory_xact_lock(hashtextextended(
    lower(trim(p_medicine_name)) || chr(31) || lower(trim(p_generic_name)) || chr(31) ||
    coalesce(lower(trim(v_brand)), '') || chr(31) || lower(trim(p_active_ingredient)) || chr(31) ||
    lower(trim(p_strength)) || chr(31) || lower(trim(p_dosage_form)) || chr(31) || lower(trim(p_unit_of_measure)),
    713992
  ));

  select count(*)::integer into v_matches
  from public.medicines m
  where lower(trim(m.name)) = lower(trim(p_medicine_name))
    and lower(trim(m.generic_name)) = lower(trim(p_generic_name))
    and coalesce(lower(trim(m.brand_name)), '') = coalesce(lower(trim(v_brand)), '')
    and lower(trim(m.active_ingredient)) = lower(trim(p_active_ingredient))
    and lower(trim(m.strength)) = lower(trim(p_strength))
    and lower(trim(m.dosage_form)) = lower(trim(p_dosage_form))
    and lower(trim(m.unit_of_measure)) = lower(trim(p_unit_of_measure));

  if v_matches > 1 then
    raise exception using errcode = 'P0001', message = 'Multiple exact catalogue entries match this formulation';
  elsif v_matches = 1 then
    select m.id into v_medicine
    from public.medicines m
    where lower(trim(m.name)) = lower(trim(p_medicine_name))
      and lower(trim(m.generic_name)) = lower(trim(p_generic_name))
      and coalesce(lower(trim(m.brand_name)), '') = coalesce(lower(trim(v_brand)), '')
      and lower(trim(m.active_ingredient)) = lower(trim(p_active_ingredient))
      and lower(trim(m.strength)) = lower(trim(p_strength))
      and lower(trim(m.dosage_form)) = lower(trim(p_dosage_form))
      and lower(trim(m.unit_of_measure)) = lower(trim(p_unit_of_measure));
  else
    insert into public.medicines(name, generic_name, brand_name, active_ingredient, strength, dosage_form, unit_of_measure)
    values (trim(p_medicine_name), trim(p_generic_name), v_brand, trim(p_active_ingredient), trim(p_strength), trim(p_dosage_form), trim(p_unit_of_measure))
    returning id into v_medicine;
  end if;

  insert into public.inventory_batches(facility_id, medicine_id, batch_number, quantity_on_hand, expiry_date, low_stock_threshold)
  values (p_facility_id, v_medicine, trim(p_batch_number), p_quantity, p_expiry_date, p_low_stock_threshold)
  returning id into v_batch;

  if p_quantity > 0 then
    insert into public.stock_movements(facility_id, inventory_batch_id, medicine_id, movement_type, quantity, performed_by)
    values (p_facility_id, v_batch, v_medicine, 'INITIAL_STOCK', p_quantity, v_actor);
  end if;
  return v_batch;
end;
$$;

revoke all on function public.create_inventory_batch_with_medicine(uuid,text,text,text,text,text,text,text,text,integer,date,integer) from public, anon;
grant execute on function public.create_inventory_batch_with_medicine(uuid,text,text,text,text,text,text,text,text,integer,date,integer) to authenticated;

commit;
