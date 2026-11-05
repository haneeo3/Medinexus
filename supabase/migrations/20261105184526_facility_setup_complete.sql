-- Report whether the authenticated user's own active facility submitted a licence.
begin;

create function public.facility_setup_complete()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles p
    join public.facilities f on f.id = p.facility_id
    join public.facility_licenses l on l.facility_id = f.id
    where p.id = auth.uid()
      and p.account_status = 'ACTIVE'
      and f.operational_status = 'ACTIVE'
  );
$$;

revoke all on function public.facility_setup_complete() from public, anon, authenticated;
grant execute on function public.facility_setup_complete() to authenticated;

commit;
