-- Public facility profile photos; only active facility administrators for the
-- matching facility and active platform administrators may upload them.
begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('facility-photos', 'facility-photos', true, 5242880,
  array['image/jpeg', 'image/png', 'image/webp']::text[])
on conflict (id) do update set
  name = excluded.name,
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

grant usage on schema storage to authenticated;
grant select, insert on storage.objects to authenticated;

create function public.is_valid_facility_photo_object_path(p_object_path text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_object_path ~
    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.](jpg|png|webp)$', false);
$$;

create function public.can_manage_facility_photo_object(p_object_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(public.is_valid_facility_photo_object_path(p_object_path) and exists (
    select 1
    from public.facilities f
    where f.id = case when public.is_valid_facility_photo_object_path(p_object_path)
      then split_part(p_object_path, '/', 1)::uuid else null end
      and (
        public.is_platform_admin()
        or exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
            and p.account_status = 'ACTIVE'
            and p.role = 'FACILITY_ADMIN'
            and p.facility_id = f.id
            and f.operational_status = 'ACTIVE'
        )
      )
  ), false);
$$;

revoke all on function public.is_valid_facility_photo_object_path(text),
  public.can_manage_facility_photo_object(text) from public, anon;
grant execute on function public.is_valid_facility_photo_object_path(text),
  public.can_manage_facility_photo_object(text) to authenticated;

-- A public bucket makes image URLs readable without authentication. This
-- authenticated SELECT policy permits authorized upload responses/management
-- queries, while limiting Storage API object-listing to authorized admins.
create policy facility_photos_authorized_read on storage.objects
  for select to authenticated
  using (bucket_id = 'facility-photos' and public.can_manage_facility_photo_object(name));

create policy facility_photos_authorized_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'facility-photos' and public.can_manage_facility_photo_object(name));

-- No UPDATE or DELETE policy: uploads cannot overwrite existing paths, and
-- uploaded photos cannot be removed while facility-profile references may exist.
commit;
