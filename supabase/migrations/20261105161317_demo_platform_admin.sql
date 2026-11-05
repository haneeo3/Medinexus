-- Demo-only account: bound to the selected Auth user ID and email; no password is stored here.
begin;
insert into public.profiles (id, facility_id, full_name, role, account_status)
select u.id, null, 'MediNexus Demo Admin', 'PLATFORM_ADMIN', 'ACTIVE'
from auth.users u
where u.id = '38b0f92e-e23c-4639-a03d-5354e705a32a'::uuid
  and lower(u.email) = 'admin@medinexus.example'
  and u.email_confirmed_at is not null
on conflict (id) do nothing;
commit;
