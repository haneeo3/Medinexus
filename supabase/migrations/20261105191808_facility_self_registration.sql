-- Atomically provision a signed-in user as the administrator of a new unverified facility.
begin;

create function public.can_register_facility()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and not exists (
      select 1
      from public.profiles p
      where p.id = auth.uid()
    );
$$;

revoke all on function public.can_register_facility() from public, anon, authenticated;
grant execute on function public.can_register_facility() to authenticated;

create function public.register_facility(
  p_full_name text,
  p_name text,
  p_facility_type text,
  p_address text,
  p_image_url text,
  p_license_number text,
  p_license_authority text,
  p_license_expiry_date date
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_facility uuid;
  v_after_profile jsonb;
  v_after_license jsonb;
begin
  if v_actor is null then
    raise exception using errcode = '42501', message = 'Authentication required';
  end if;

  -- Serialize submissions for this auth user; the profiles primary key remains
  -- the final uniqueness guarantee if another writer bypasses this RPC.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_actor::text, 0)
  );

  if exists (select 1 from public.profiles p where p.id = v_actor) then
    raise exception using errcode = '42501', message = 'Facility registration unavailable for this account';
  end if;

  if p_full_name is null or pg_catalog.length(pg_catalog.btrim(p_full_name)) not between 1 and 200
    or p_name is null or pg_catalog.length(pg_catalog.btrim(p_name)) not between 1 and 200
    or p_facility_type is null or p_facility_type not in ('PHARMACY', 'CLINIC', 'HOSPITAL', 'OTHER')
    or p_address is null or pg_catalog.length(pg_catalog.btrim(p_address)) not between 1 and 1000
    or not public.facility_image_url_valid(p_image_url)
    or p_license_number is null or pg_catalog.length(pg_catalog.btrim(p_license_number)) not between 1 and 200
    or p_license_authority is null or pg_catalog.length(pg_catalog.btrim(p_license_authority)) not between 1 and 200
    or p_license_expiry_date is null then
    raise exception using errcode = '22023', message = 'Invalid facility registration details';
  end if;

  insert into public.facilities(
    name, facility_type, address, latitude, longitude, image_url,
    verification_status, operational_status
  ) values (
    pg_catalog.btrim(p_name), p_facility_type, pg_catalog.btrim(p_address),
    null, null, p_image_url, 'UNVERIFIED', 'ACTIVE'
  ) returning id into v_facility;

  insert into public.profiles(id, facility_id, full_name, role, account_status)
  values (v_actor, v_facility, pg_catalog.btrim(p_full_name), 'FACILITY_ADMIN', 'ACTIVE');

  insert into public.facility_licenses(
    facility_id, license_number, license_authority, license_expiry_date, submitted_by
  ) values (
    v_facility, pg_catalog.btrim(p_license_number), pg_catalog.btrim(p_license_authority),
    p_license_expiry_date, v_actor
  );

  v_after_profile := public.facility_profile_snapshot(v_facility);
  insert into public.facility_history(facility_id, actor_id, action, before_profile, after_profile)
  values (v_facility, v_actor, 'OWNER_SUBMISSION', null, v_after_profile);

  select pg_catalog.jsonb_build_object(
    'license_number', l.license_number,
    'license_authority', l.license_authority,
    'license_expiry_date', l.license_expiry_date
  ) into v_after_license
  from public.facility_licenses l
  where l.facility_id = v_facility;

  insert into public.facility_license_history(facility_id, actor_id, before_license, after_license)
  values (v_facility, v_actor, null, v_after_license);

  return v_facility;
end;
$$;

revoke all on function public.register_facility(text, text, text, text, text, text, text, date)
  from public, anon, authenticated;
grant execute on function public.register_facility(text, text, text, text, text, text, text, date)
  to authenticated;

commit;
