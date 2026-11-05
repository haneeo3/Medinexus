-- Aggregate, explainable medicine discovery. Reported stock is not a reservation or guarantee.
begin;

create table public.medicine_matching_settings (
  singleton boolean primary key default true check (singleton),
  quantity_weight numeric(6,5) not null default 0.50000 check (quantity_weight between 0 and 1),
  distance_weight numeric(6,5) not null default 0.30000 check (distance_weight between 0 and 1),
  freshness_weight numeric(6,5) not null default 0.20000 check (freshness_weight between 0 and 1),
  stale_after_hours numeric(10,2) not null default 168.00 check (stale_after_hours > 0),
  distance_max_km numeric(10,2) not null default 100.00 check (distance_max_km > 0),
  missing_distance_score numeric(5,2) not null default 50.00 check (missing_distance_score between 0 and 100),
  check (quantity_weight + distance_weight + freshness_weight = 1)
);
insert into public.medicine_matching_settings(singleton) values (true);
alter table public.medicine_matching_settings enable row level security;
revoke all on public.medicine_matching_settings from public, anon, authenticated;

comment on table public.medicine_matching_settings is
  'Singleton configuration for medicine discovery scores; change only through trusted SQL administration.';

create function public.find_medicine_matches(
  p_requesting_facility_id uuid,
  p_medicine_id uuid,
  p_requested_quantity integer
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
  v_settings public.medicine_matching_settings%rowtype;
  v_request_facility public.facilities%rowtype;
  v_matches jsonb;
  v_insufficient jsonb;
begin
  if p_requested_quantity is null or p_requested_quantity <= 0 then
    raise exception using errcode = '22023', message = 'Requested quantity must be positive';
  end if;

  -- require_facility_role derives the caller from auth.uid() and enforces an active profile and facility.
  v_actor := public.require_facility_role(
    p_requesting_facility_id,
    array['FACILITY_ADMIN','INVENTORY_MANAGER','REQUESTING_STAFF','SUPPLIER_STAFF']
  );

  if p_medicine_id is null or not exists (
    select 1 from public.medicines m where m.id = p_medicine_id
  ) then
    raise exception using errcode = '22023', message = 'Medicine not found';
  end if;

  select * into v_request_facility
  from public.facilities f
  where f.id = p_requesting_facility_id and f.operational_status = 'ACTIVE';
  if not found then
    raise exception using errcode = '42501', message = 'Requesting facility is not active';
  end if;

  select * into strict v_settings
  from public.medicine_matching_settings s where s.singleton;

  with stock as (
    select b.facility_id,
      sum((b.quantity_on_hand - b.quantity_reserved)::bigint)::bigint as available_quantity,
      min(b.last_updated_at) as last_updated_at
    from public.inventory_batches b
    join public.facilities f on f.id = b.facility_id and f.operational_status = 'ACTIVE'
    where b.medicine_id = p_medicine_id
      and b.facility_id <> p_requesting_facility_id
      and b.expiry_date >= current_date
      and b.quantity_on_hand > b.quantity_reserved
    group by b.facility_id
  ), eligible as (
    select f.id as facility_id, f.name as facility_name, f.facility_type, f.address,
      f.verification_status, f.latitude, f.longitude,
      st.available_quantity, st.last_updated_at,
      case
        when v_request_facility.latitude is null or f.latitude is null then null::double precision
        else 6371.0088 * 2 * asin(sqrt(least(1.0, greatest(0.0,
          power(sin(radians(f.latitude - v_request_facility.latitude) / 2), 2) +
          cos(radians(v_request_facility.latitude)) * cos(radians(f.latitude)) *
          power(sin(radians(f.longitude - v_request_facility.longitude) / 2), 2)
        ))))
      end as distance_km,
      greatest(0::numeric,
        extract(epoch from (statement_timestamp() - st.last_updated_at))::numeric / 3600
      ) as age_hours
    from stock st join public.facilities f on f.id = st.facility_id
  ), scored as (
    select e.*,
      least(100::numeric, 100::numeric * e.available_quantity / p_requested_quantity)::numeric as quantity_score_raw,
      case when e.distance_km is null then v_settings.missing_distance_score
        else greatest(0::numeric, 100::numeric * (1 - e.distance_km::numeric / v_settings.distance_max_km))
      end as distance_score_raw,
      greatest(0::numeric, 100::numeric * (1 - e.age_hours / v_settings.stale_after_hours)) as freshness_score_raw,
      e.age_hours >= v_settings.stale_after_hours as is_stale
    from eligible e
  ), valued as (
    select s.*,
      case when s.available_quantity >= p_requested_quantity then
        round((s.quantity_score_raw * v_settings.quantity_weight +
               s.distance_score_raw * v_settings.distance_weight +
               s.freshness_score_raw * v_settings.freshness_weight)::numeric, 2)
      else null::numeric end as final_match_score
    from scored s
  ), objects as (
    select v.*,
      jsonb_build_object(
        'facility_id', v.facility_id,
        'facility_name', v.facility_name,
        'facility_type', v.facility_type,
        'address', v.address,
        'verification_status', v.verification_status,
        'available_quantity', v.available_quantity,
        'requested_quantity', p_requested_quantity,
        'unit_of_measure', med.unit_of_measure,
        'distance_km', case when v.distance_km is null then null else round(v.distance_km::numeric, 1) end,
        'last_updated_at', v.last_updated_at,
        'quantity_score', round(v.quantity_score_raw, 2),
        'distance_score', round(v.distance_score_raw, 2),
        'freshness_score', round(v.freshness_score_raw, 2),
        'match_score', v.final_match_score,
        'reasons', jsonb_build_array(
          format('Quantity score %s/100 from %s reported eligible %s.', round(v.quantity_score_raw, 2), v.available_quantity, med.unit_of_measure),
          case when v.distance_km is null
            then format('Distance score %s/100 uses the configured missing-distance fallback.', round(v.distance_score_raw, 2))
            else format('Distance score %s/100 uses an estimated %s km straight-line distance.', round(v.distance_score_raw, 2), round(v.distance_km::numeric, 1))
          end,
          format('Freshness score %s/100 uses the oldest timestamp among eligible positive-availability batches (%s hours old).', round(v.freshness_score_raw, 2), round(v.age_hours, 1)),
          case when v.available_quantity >= p_requested_quantity
            then format('Reported eligible stock meets the requested quantity; weighted score uses %s quantity, %s distance, and %s freshness weights.', v_settings.quantity_weight, v_settings.distance_weight, v_settings.freshness_weight)
            else 'Reported eligible stock is below the requested quantity and is not a full match.'
          end
        ),
        'warnings', to_jsonb(array_remove(array[
          'Reported availability requires supplier confirmation; discovery does not reserve stock.'::text,
          case when v.is_stale then 'Stock data is stale under the configured freshness threshold.'::text end,
          case when v.distance_km is null then 'Distance could not be calculated because facility coordinates are missing.'::text end,
          case when v.available_quantity < p_requested_quantity then 'Partial stock only; this facility is not listed as a full match.'::text end
        ], null)),
        'stale', v.is_stale,
        'availability_status', 'REQUIRES_CONFIRMATION'
      ) as item
    from valued v cross join public.medicines med
    where med.id = p_medicine_id
  )
  select
    coalesce(jsonb_agg(item order by final_match_score desc, facility_name asc, facility_id asc)
      filter (where available_quantity >= p_requested_quantity), '[]'::jsonb),
    coalesce(jsonb_agg(item order by available_quantity desc, facility_name asc, facility_id asc)
      filter (where available_quantity < p_requested_quantity), '[]'::jsonb)
  into v_matches, v_insufficient
  from objects;

  return jsonb_build_object(
    'medicine_id', p_medicine_id,
    'requested_quantity', p_requested_quantity,
    'matches', v_matches,
    'insufficient', v_insufficient,
    'scoring', jsonb_build_object(
      'quantity_weight', v_settings.quantity_weight,
      'distance_weight', v_settings.distance_weight,
      'freshness_weight', v_settings.freshness_weight,
      'stale_after_hours', v_settings.stale_after_hours,
      'distance_max_km', v_settings.distance_max_km,
      'missing_distance_score', v_settings.missing_distance_score
    )
  );
end;
$$;

revoke all on function public.find_medicine_matches(uuid, uuid, integer) from public, anon;
grant execute on function public.find_medicine_matches(uuid, uuid, integer) to authenticated;
commit;
