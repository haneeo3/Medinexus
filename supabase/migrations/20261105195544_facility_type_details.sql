-- Optional public, type-specific facility profile text. Existing RPCs and records
-- remain compatible; the new wrappers make core edits and details atomic.
begin;

alter table public.facilities
  add column facility_type_details text,
  add constraint facilities_type_details_valid check (
    facility_type_details is null or (
      length(facility_type_details) <= 1000
      and facility_type in ('PHARMACY', 'CLINIC', 'HOSPITAL')
    )
  );

create or replace function public.facility_profile_snapshot(p_facility_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('name',f.name,'facility_type',f.facility_type,
    'address',f.address,'latitude',f.latitude,'longitude',f.longitude,
    'image_url',f.image_url,'verification_status',f.verification_status,
    'verification_valid_until',f.verification_valid_until,
    'operational_status',f.operational_status,
    'facility_type_details',f.facility_type_details)
  from public.facilities f where f.id=p_facility_id;
$$;
revoke all on function public.facility_profile_snapshot(uuid) from public, anon, authenticated;

-- Keep every existing directory column in its original position and append the
-- public description. Licence records remain absent from the directory.
create or replace view public.facility_directory with (security_invoker = true) as
select f.id, f.name, f.facility_type, f.address, f.latitude, f.longitude, f.image_url,
  case when f.verification_status='VERIFIED'
         and f.verification_valid_until >= current_date then 'VERIFIED'
       when f.verification_status='REJECTED' then 'REJECTED'
       else 'UNVERIFIED' end as verification_status,
  f.verification_valid_until, f.operational_status, f.created_at, f.updated_at,
  f.facility_type_details
from public.facilities f;
revoke all on public.facility_directory from public, anon;
grant select on public.facility_directory to authenticated;

create function public.register_facility_with_details(
  p_full_name text,
  p_name text,
  p_facility_type text,
  p_address text,
  p_image_url text,
  p_license_number text,
  p_license_authority text,
  p_license_expiry_date date,
  p_facility_type_details text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_facility uuid;
  v_actor uuid := auth.uid();
  v_details text := nullif(pg_catalog.btrim(p_facility_type_details), '');
begin
  v_facility := public.register_facility(
    p_full_name,p_name,p_facility_type,p_address,p_image_url,
    p_license_number,p_license_authority,p_license_expiry_date);
  if p_facility_type_details is not null
    and (pg_catalog.length(p_facility_type_details) > 1000
      or p_facility_type not in ('PHARMACY','CLINIC','HOSPITAL')) then
    raise exception using errcode='22023', message='Invalid facility type details';
  end if;
  update public.facilities f set facility_type_details=v_details where f.id=v_facility;
  update public.facility_history h set after_profile=pg_catalog.jsonb_set(
      h.after_profile,'{facility_type_details}',coalesce(pg_catalog.to_jsonb(v_details),'null'::jsonb),true)
    where h.id=(select h2.id from public.facility_history h2
      where h2.facility_id=v_facility and h2.actor_id=v_actor
        and h2.action='OWNER_SUBMISSION'
      order by h2.created_at desc limit 1);
  if not found then
    raise exception using errcode='P0001', message='Facility registration audit record missing';
  end if;
  return v_facility;
end;
$$;

create function public.submit_facility_profile_with_details(
  p_name text,
  p_facility_type text,
  p_address text,
  p_latitude double precision,
  p_longitude double precision,
  p_image_url text,
  p_license_number text,
  p_license_authority text,
  p_license_expiry_date date,
  p_facility_type_details text
) returns table (facility_id uuid, verification_status text, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_facility uuid;
  v_details text := nullif(pg_catalog.btrim(p_facility_type_details), '');
  v_prior_history_ids uuid[] := array[]::uuid[];
  v_result record;
  v_history_id uuid;
begin
  if v_actor is null then
    raise exception using errcode='42501', message='Authentication required';
  end if;
  if not exists (select 1 from public.profiles p where p.id=v_actor
    and p.account_status='ACTIVE' and p.role='FACILITY_ADMIN') then
    raise exception using errcode='42501', message='Facility administrator access required';
  end if;
  select p.facility_id into v_facility from public.profiles p where p.id=v_actor;
  if v_facility is not null then
    perform 1 from public.facilities f where f.id=v_facility for update;
    select coalesce(pg_catalog.array_agg(h.id),array[]::uuid[]) into v_prior_history_ids
      from public.facility_history h where h.facility_id=v_facility;
  end if;
  select * into v_result from public.submit_facility_profile(
    p_name,p_facility_type,p_address,p_latitude,p_longitude,p_image_url,
    p_license_number,p_license_authority,p_license_expiry_date);
  if p_facility_type_details is not null
    and (pg_catalog.length(p_facility_type_details) > 1000
      or p_facility_type not in ('PHARMACY','CLINIC','HOSPITAL')) then
    raise exception using errcode='22023', message='Invalid facility type details';
  end if;
  update public.facilities f set facility_type_details=v_details where f.id=v_facility;
  select h.id into v_history_id from public.facility_history h
    where h.facility_id=v_facility and h.actor_id=v_actor
      and h.action='OWNER_SUBMISSION'
      and not (h.id = any(v_prior_history_ids))
    order by h.created_at desc limit 1;
  if v_history_id is null then
    raise exception using errcode='P0001', message='Facility profile audit record missing';
  end if;
  update public.facility_history h set after_profile=pg_catalog.jsonb_set(
      h.after_profile,'{facility_type_details}',coalesce(pg_catalog.to_jsonb(v_details),'null'::jsonb),true)
    where h.id=v_history_id;
  facility_id := v_result.facility_id;
  verification_status := v_result.verification_status;
  select f.updated_at into updated_at from public.facilities f where f.id=v_facility;
  return next;
end;
$$;

create function public.platform_admin_save_facility_with_details(
  p_facility_id uuid,
  p_name text,
  p_facility_type text,
  p_address text,
  p_latitude double precision,
  p_longitude double precision,
  p_image_url text,
  p_operational_status text,
  p_facility_type_details text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_facility uuid;
  v_details text := nullif(pg_catalog.btrim(p_facility_type_details), '');
  v_prior_history_ids uuid[] := array[]::uuid[];
  v_history_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception using errcode='42501', message='Platform administrator access required';
  end if;
  if p_facility_id is not null then
    perform 1 from public.facilities f where f.id=p_facility_id for update;
    select coalesce(pg_catalog.array_agg(h.id),array[]::uuid[]) into v_prior_history_ids
      from public.facility_history h where h.facility_id=p_facility_id;
  end if;
  v_facility := public.platform_admin_save_facility(
    p_facility_id,p_name,p_facility_type,p_address,p_latitude,p_longitude,
    p_image_url,p_operational_status);
  if p_facility_type_details is not null
    and (pg_catalog.length(p_facility_type_details) > 1000
      or p_facility_type not in ('PHARMACY','CLINIC','HOSPITAL')) then
    raise exception using errcode='22023', message='Invalid facility type details';
  end if;
  update public.facilities f set facility_type_details=v_details where f.id=v_facility;
  select h.id into v_history_id from public.facility_history h
    where h.facility_id=v_facility and h.actor_id=v_actor
      and not (h.id = any(v_prior_history_ids))
    order by h.created_at desc limit 1;
  if v_history_id is null then
    raise exception using errcode='P0001', message='Facility profile audit record missing';
  end if;
  update public.facility_history h set after_profile=pg_catalog.jsonb_set(
      h.after_profile,'{facility_type_details}',coalesce(pg_catalog.to_jsonb(v_details),'null'::jsonb),true)
    where h.id=v_history_id;
  return v_facility;
end;
$$;

revoke all on function public.register_facility_with_details(text,text,text,text,text,text,text,date,text),
  public.submit_facility_profile_with_details(text,text,text,double precision,double precision,text,text,text,date,text),
  public.platform_admin_save_facility_with_details(uuid,text,text,text,double precision,double precision,text,text,text)
  from public, anon, authenticated;
grant execute on function public.register_facility_with_details(text,text,text,text,text,text,text,date,text),
  public.submit_facility_profile_with_details(text,text,text,double precision,double precision,text,text,text,date,text),
  public.platform_admin_save_facility_with_details(uuid,text,text,text,double precision,double precision,text,text,text)
  to authenticated;

commit;
