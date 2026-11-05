-- DEMO PROJECT ONLY: requires two manually created, confirmed Auth users.
-- Do not apply this fixture to a real facility or production environment.
begin;
do $$
declare
  v_clinic_user uuid;
  v_supplier_user uuid;
  v_clinic uuid := '7da05698-b748-4e79-b99e-3abcbdcb1001';
  v_supplier uuid := '7da05698-b748-4e79-b99e-3abcbdcb1002';
begin
  select id into v_clinic_user from auth.users where lower(email) = 'clinic@medinexus.example' and email_confirmed_at is not null;
  select id into v_supplier_user from auth.users where lower(email) = 'supplier@medinexus.example' and email_confirmed_at is not null;
  if v_clinic_user is null or v_supplier_user is null then
    raise exception 'Create and confirm both demo Auth users before applying this demo fixture';
  end if;
  if exists (select 1 from public.profiles where id in (v_clinic_user, v_supplier_user))
     or exists (select 1 from public.facilities where id in (v_clinic, v_supplier)) then
    raise exception 'Demo profile or facility already exists; refusing to overwrite';
  end if;
  insert into public.facilities (id, name, facility_type, address, verification_status) values
    (v_clinic, 'MediNexus Demo Clinic', 'CLINIC', 'Fictional Demo Road, Abeokuta', 'UNVERIFIED'),
    (v_supplier, 'MediNexus Demo Pharmacy', 'PHARMACY', 'Fictional Sample Street, Abeokuta', 'UNVERIFIED');
  -- Each demo account is a facility admin so the end-to-end demo can manage inventory and requests.
  insert into public.profiles (id, facility_id, full_name, role) values
    (v_clinic_user, v_clinic, 'Demo Clinic Admin', 'FACILITY_ADMIN'),
    (v_supplier_user, v_supplier, 'Demo Pharmacy Admin', 'FACILITY_ADMIN');
end;
$$;
commit;
