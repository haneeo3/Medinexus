-- Facility profiles, private licensing data, platform review and immutable history.
begin;

alter table public.facilities add column image_url text;
alter table public.facilities add column verification_valid_until date;
create function public.facility_image_url_valid(p_url text) returns boolean
language sql immutable set search_path = '' as $$
  select p_url is null or (length(p_url) <= 2048
    and p_url ~* '^https://[A-Za-z0-9.-]+(:[0-9]+)?([/?#][^[:space:]]*)?$');
$$;
alter table public.facilities add constraint facilities_image_url_https
  check (public.facility_image_url_valid(image_url));

create table public.facility_licenses (
  facility_id uuid primary key references public.facilities(id) on delete restrict,
  license_number text not null check (length(trim(license_number)) between 1 and 200),
  license_authority text not null check (length(trim(license_authority)) between 1 and 200),
  license_expiry_date date not null,
  submitted_by uuid not null references public.profiles(id) on delete restrict,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table public.facility_history (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  action text not null check (action in ('OWNER_SUBMISSION','PLATFORM_ADMIN_CREATE','PLATFORM_ADMIN_EDIT','DEACTIVATED','REACTIVATED','VERIFICATION_REVIEW')),
  before_profile jsonb, after_profile jsonb not null, notes text,
  created_at timestamptz not null default now()
);
create table public.facility_license_history (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete restrict,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  before_license jsonb, after_license jsonb not null,
  created_at timestamptz not null default now()
);
create table public.facility_verification_reviews (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete restrict,
  reviewer_id uuid not null references public.profiles(id) on delete restrict,
  decision text not null check (decision in ('VERIFIED','REJECTED')),
  notes text not null check (length(trim(notes)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index facility_history_facility_idx on public.facility_history(facility_id, created_at desc);
create index facility_license_history_facility_idx on public.facility_license_history(facility_id, created_at desc);
create index facility_reviews_facility_idx on public.facility_verification_reviews(facility_id, created_at desc);

alter table public.facility_licenses enable row level security;
alter table public.facility_history enable row level security;
alter table public.facility_license_history enable row level security;
alter table public.facility_verification_reviews enable row level security;
create policy facility_licenses_read on public.facility_licenses for select to authenticated
using (public.is_platform_admin() or exists (select 1 from public.profiles p
  where p.id=auth.uid() and p.account_status='ACTIVE' and p.role='FACILITY_ADMIN'
  and p.facility_id=facility_licenses.facility_id));
create policy facility_history_read on public.facility_history for select to authenticated
using (public.is_platform_admin() or exists (select 1 from public.profiles p
  where p.id=auth.uid() and p.account_status='ACTIVE' and p.role='FACILITY_ADMIN'
  and p.facility_id=facility_history.facility_id));
create policy facility_license_history_read on public.facility_license_history for select to authenticated
using (public.is_platform_admin() or exists (select 1 from public.profiles p
  where p.id=auth.uid() and p.account_status='ACTIVE' and p.role='FACILITY_ADMIN'
  and p.facility_id=facility_license_history.facility_id));
create policy facility_reviews_read on public.facility_verification_reviews for select to authenticated
using (public.is_platform_admin() or exists (select 1 from public.profiles p
  where p.id=auth.uid() and p.account_status='ACTIVE' and p.role='FACILITY_ADMIN'
  and p.facility_id=facility_verification_reviews.facility_id));
revoke all on public.facility_licenses, public.facility_history,
  public.facility_license_history, public.facility_verification_reviews
  from public, anon, authenticated;
grant select on public.facility_licenses, public.facility_history,
  public.facility_license_history, public.facility_verification_reviews to authenticated;

create function public.facility_profile_snapshot(p_facility_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('name',f.name,'facility_type',f.facility_type,
    'address',f.address,'latitude',f.latitude,'longitude',f.longitude,
    'image_url',f.image_url,'verification_status',f.verification_status,
    'verification_valid_until',f.verification_valid_until,
    'operational_status',f.operational_status)
  from public.facilities f where f.id=p_facility_id;
$$;
revoke all on function public.facility_profile_snapshot(uuid) from public,anon,authenticated;
create view public.facility_directory with (security_invoker = true) as
select f.id, f.name, f.facility_type, f.address, f.latitude, f.longitude, f.image_url,
  case when f.verification_status='VERIFIED'
         and f.verification_valid_until >= current_date then 'VERIFIED'
       when f.verification_status='REJECTED' then 'REJECTED'
       else 'UNVERIFIED' end as verification_status,
  f.verification_valid_until, f.operational_status, f.created_at, f.updated_at
from public.facilities f;
revoke all on public.facility_directory from public, anon;
grant select on public.facility_directory to authenticated;


create function public.submit_facility_profile(
  p_name text, p_facility_type text, p_address text,
  p_latitude double precision, p_longitude double precision, p_image_url text,
  p_license_number text, p_license_authority text, p_license_expiry_date date
) returns table (facility_id uuid, verification_status text, updated_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid(); v_facility uuid; v_before jsonb; v_after jsonb;
  v_before_license jsonb; v_after_license jsonb;
begin
  if v_actor is null then raise exception using errcode='42501', message='Authentication required'; end if;
  select p.facility_id into v_facility from public.profiles p
    where p.id=v_actor and p.account_status='ACTIVE' and p.role='FACILITY_ADMIN';
  if v_facility is null then raise exception using errcode='42501', message='Facility administrator access required'; end if;
  perform 1 from public.facilities f where f.id=v_facility for update;
  if not found then raise exception using errcode='P0002', message='Facility not found'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 200
    or p_facility_type is null or p_facility_type not in ('CLINIC','PHARMACY','HOSPITAL')
    or p_address is null or length(trim(p_address)) not between 1 and 1000
    or (p_latitude is null) <> (p_longitude is null)
    or (p_latitude is not null and (p_latitude < -90 or p_latitude > 90))
    or (p_longitude is not null and (p_longitude < -180 or p_longitude > 180))
    or not public.facility_image_url_valid(p_image_url)
    or p_license_number is null or length(trim(p_license_number)) not between 1 and 200
    or p_license_authority is null or length(trim(p_license_authority)) not between 1 and 200
    or p_license_expiry_date is null then
    raise exception using errcode='22023', message='Invalid facility profile or licence details';
  end if;
  v_before := public.facility_profile_snapshot(v_facility);
  select jsonb_build_object('license_number',l.license_number,'license_authority',l.license_authority,
    'license_expiry_date',l.license_expiry_date) into v_before_license
    from public.facility_licenses l where l.facility_id=v_facility;
  update public.facilities f set name=trim(p_name),facility_type=p_facility_type,
    address=trim(p_address),latitude=p_latitude,longitude=p_longitude,
    image_url=p_image_url,verification_status='UNVERIFIED',verification_valid_until=null
    where f.id=v_facility;
  insert into public.facility_licenses(facility_id,license_number,license_authority,
    license_expiry_date,submitted_by) values(v_facility,trim(p_license_number),
    trim(p_license_authority),p_license_expiry_date,v_actor)
  on conflict on constraint facility_licenses_pkey do update set license_number=excluded.license_number,
    license_authority=excluded.license_authority,license_expiry_date=excluded.license_expiry_date,
    submitted_by=excluded.submitted_by,submitted_at=now(),updated_at=now();
  v_after := public.facility_profile_snapshot(v_facility);
  select jsonb_build_object('license_number',l.license_number,'license_authority',l.license_authority,
    'license_expiry_date',l.license_expiry_date) into v_after_license
    from public.facility_licenses l where l.facility_id=v_facility;
  insert into public.facility_history(facility_id,actor_id,action,before_profile,after_profile)
    values(v_facility,v_actor,'OWNER_SUBMISSION',v_before,v_after);
  insert into public.facility_license_history(facility_id,actor_id,before_license,after_license)
    values(v_facility,v_actor,v_before_license,v_after_license);
  facility_id := v_facility; verification_status := 'UNVERIFIED';
  select f.updated_at into updated_at from public.facilities f where f.id=v_facility;
  return next;
end;
$$;

create function public.platform_admin_save_facility(
  p_facility_id uuid,p_name text,p_facility_type text,p_address text,
  p_latitude double precision,p_longitude double precision,p_image_url text,
  p_operational_status text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=auth.uid(); v_id uuid:=p_facility_id;
  v_before jsonb; v_after jsonb; v_action text;
begin
  if not public.is_platform_admin() then
    raise exception using errcode='42501',message='Platform administrator access required';
  end if;
  if p_name is null or length(trim(p_name)) not between 1 and 200
    or p_facility_type is null or p_facility_type not in ('CLINIC','PHARMACY','HOSPITAL')
    or p_address is null or length(trim(p_address)) not between 1 and 1000
    or (p_latitude is null) <> (p_longitude is null)
    or (p_latitude is not null and (p_latitude < -90 or p_latitude > 90))
    or (p_longitude is not null and (p_longitude < -180 or p_longitude > 180))
    or not public.facility_image_url_valid(p_image_url)
    or p_operational_status is null or p_operational_status not in ('ACTIVE','INACTIVE') then
    raise exception using errcode='22023',message='Invalid facility profile';
  end if;
  if v_id is null then
    insert into public.facilities(name,facility_type,address,latitude,longitude,image_url,operational_status)
      values(trim(p_name),p_facility_type,trim(p_address),p_latitude,p_longitude,p_image_url,p_operational_status)
      returning id into v_id;
    v_action:='PLATFORM_ADMIN_CREATE';
  else
    perform 1 from public.facilities f where f.id=v_id for update;
    if not found then raise exception using errcode='P0002',message='Facility not found'; end if;
    v_before:=public.facility_profile_snapshot(v_id);
    if p_operational_status='INACTIVE' and v_before->>'operational_status'='ACTIVE'
      and exists (select 1 from public.supply_requests r where
        (r.requesting_facility_id=v_id or r.supplying_facility_id=v_id)
        and r.status in ('PENDING','APPROVED')) then
      raise exception using errcode='22023',message='Cannot deactivate a facility with pending or approved supply requests';
    end if;
    update public.facilities f set name=trim(p_name),facility_type=p_facility_type,
      address=trim(p_address),latitude=p_latitude,longitude=p_longitude,image_url=p_image_url,
      operational_status=p_operational_status,
      verification_status=case when (f.name,f.facility_type,f.address,f.latitude,f.longitude)
        is distinct from (trim(p_name),p_facility_type,trim(p_address),p_latitude,p_longitude)
        then 'UNVERIFIED' else f.verification_status end,
      verification_valid_until=case when (f.name,f.facility_type,f.address,f.latitude,f.longitude)
        is distinct from (trim(p_name),p_facility_type,trim(p_address),p_latitude,p_longitude)
        then null else f.verification_valid_until end
      where f.id=v_id;
    v_action:=case when (v_before->>'operational_status') is distinct from p_operational_status
      and p_operational_status='INACTIVE' then 'DEACTIVATED'
      when (v_before->>'operational_status') is distinct from p_operational_status
      and p_operational_status='ACTIVE' then 'REACTIVATED'
      else 'PLATFORM_ADMIN_EDIT' end;
  end if;
  v_after:=public.facility_profile_snapshot(v_id);
  insert into public.facility_history(facility_id,actor_id,action,before_profile,after_profile)
    values(v_id,v_actor,v_action,v_before,v_after);
  return v_id;
end;
$$;

create function public.review_facility_verification(
  p_facility_id uuid,p_decision text,p_notes text
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid:=auth.uid(); v_before jsonb; v_after jsonb; v_current_status text;
  v_license_expiry date; v_submitted_by uuid;
begin
  if not public.is_platform_admin() then
    raise exception using errcode='42501',message='Platform administrator access required';
  end if;
  if p_facility_id is null or p_decision not in ('VERIFIED','REJECTED')
    or p_notes is null or length(trim(p_notes)) not between 1 and 2000 then
    raise exception using errcode='22023',message='Decision and manual review note are required';
  end if;
  perform 1 from public.facilities f where f.id=p_facility_id for update;
  if not found then raise exception using errcode='P0002',message='Facility not found'; end if;
  select f.verification_status into v_current_status from public.facilities f where f.id=p_facility_id;
  if v_current_status<>'UNVERIFIED' then
    raise exception using errcode='22023',message='Facility must be resubmitted before another review';
  end if;
  select l.license_expiry_date,l.submitted_by into v_license_expiry,v_submitted_by
    from public.facility_licenses l where l.facility_id=p_facility_id;
  if v_submitted_by=v_actor then
    raise exception using errcode='42501',message='Submitter cannot review their own licence';
  end if;
  if p_decision='VERIFIED' and (v_license_expiry is null or v_license_expiry<current_date) then
    raise exception using errcode='22023',message='A current unexpired licence submission is required to verify';
  end if;
  v_before:=public.facility_profile_snapshot(p_facility_id);
  update public.facilities f set verification_status=p_decision,
    verification_valid_until=case when p_decision='VERIFIED' then v_license_expiry else null end
    where f.id=p_facility_id;
  v_after:=public.facility_profile_snapshot(p_facility_id);
  insert into public.facility_verification_reviews(facility_id,reviewer_id,decision,notes)
    values(p_facility_id,v_actor,p_decision,trim(p_notes));
  insert into public.facility_history(facility_id,actor_id,action,before_profile,after_profile,notes)
    values(p_facility_id,v_actor,'VERIFICATION_REVIEW',v_before,v_after,trim(p_notes));
  return p_facility_id;
end;
$$;

revoke all on function public.submit_facility_profile(text,text,text,double precision,double precision,text,text,text,date),
  public.platform_admin_save_facility(uuid,text,text,text,double precision,double precision,text,text),
  public.review_facility_verification(uuid,text,text) from public,anon,authenticated;
grant execute on function public.submit_facility_profile(text,text,text,double precision,double precision,text,text,text,date),
  public.platform_admin_save_facility(uuid,text,text,text,double precision,double precision,text,text),
  public.review_facility_verification(uuid,text,text) to authenticated;
revoke all on function public.facility_image_url_valid(text) from public,anon,authenticated;
-- Preserve the existing matching function, changing only its effective verification status.
do $update_matching$
declare
  original text := pg_get_functiondef('public.find_medicine_matches(uuid,uuid,integer)'::regprocedure);
  needle text := 'f.verification_status, f.latitude, f.longitude,';
  replacement text := $sql$case when f.verification_status='VERIFIED' and f.verification_valid_until >= current_date then 'VERIFIED' when f.verification_status='REJECTED' then 'REJECTED' else 'UNVERIFIED' end as verification_status, f.latitude, f.longitude,$sql$;
begin
  if length(original) - length(replace(original, needle, '')) <> length(needle) then
    raise exception 'Matching function does not have the expected verification field';
  end if;
  execute replace(original, needle, replacement);
end;
$update_matching$;

revoke all on function public.find_medicine_matches(uuid,uuid,integer) from public,anon;
grant execute on function public.find_medicine_matches(uuid,uuid,integer) to authenticated;

commit;
