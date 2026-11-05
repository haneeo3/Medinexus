-- DEMO ONLY: illustrative coordinates for fictional facilities; not real addresses.
begin;
do $$
declare changed integer;
begin
  update public.facilities set latitude=7.1500, longitude=3.3500
  where id='7da05698-b748-4e79-b99e-3abcbdcb1001' and name='MediNexus Demo Clinic' and latitude is null and longitude is null;
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'Demo clinic missing or location already set'; end if;
  update public.facilities set latitude=7.1700, longitude=3.3800
  where id='7da05698-b748-4e79-b99e-3abcbdcb1002' and name='MediNexus Demo Pharmacy' and latitude is null and longitude is null;
  get diagnostics changed = row_count;
  if changed <> 1 then raise exception 'Demo pharmacy missing or location already set'; end if;
end;
$$;
commit;
