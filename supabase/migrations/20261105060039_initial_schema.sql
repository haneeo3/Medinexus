-- MediNexus foundation. Apply only to a Supabase project, not a generic PostgreSQL instance.
-- This migration intentionally grants no client writes. Transactional operations follow later.
begin;

create table public.facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  facility_type text not null check (facility_type in ('PHARMACY', 'CLINIC', 'HOSPITAL', 'OTHER')),
  address text not null check (length(trim(address)) > 0),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  verification_status text not null default 'UNVERIFIED' check (verification_status in ('UNVERIFIED', 'VERIFIED', 'REJECTED')),
  operational_status text not null default 'ACTIVE' check (operational_status in ('ACTIVE', 'INACTIVE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((latitude is null) = (longitude is null))
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  facility_id uuid references public.facilities(id) on delete restrict,
  full_name text not null check (length(trim(full_name)) > 0),
  role text not null check (role in ('PLATFORM_ADMIN', 'FACILITY_ADMIN', 'INVENTORY_MANAGER', 'REQUESTING_STAFF', 'SUPPLIER_STAFF')),
  account_status text not null default 'ACTIVE' check (account_status in ('ACTIVE', 'INACTIVE')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((role = 'PLATFORM_ADMIN' and facility_id is null) or (role <> 'PLATFORM_ADMIN' and facility_id is not null))
);

create table public.medicines (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  generic_name text,
  brand_name text,
  active_ingredient text,
  strength text not null check (length(trim(strength)) > 0),
  dosage_form text not null check (length(trim(dosage_form)) > 0),
  unit_of_measure text not null check (length(trim(unit_of_measure)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.inventory_batches (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete restrict,
  medicine_id uuid not null references public.medicines(id) on delete restrict,
  batch_number text not null check (length(trim(batch_number)) > 0),
  quantity_on_hand integer not null default 0 check (quantity_on_hand >= 0),
  quantity_reserved integer not null default 0 check (quantity_reserved >= 0 and quantity_reserved <= quantity_on_hand),
  low_stock_threshold integer not null default 0 check (low_stock_threshold >= 0),
  expiry_date date not null,
  last_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (facility_id, medicine_id, batch_number),
  unique (id, facility_id, medicine_id)
);

create table public.supply_requests (
  id uuid primary key default gen_random_uuid(),
  requesting_facility_id uuid not null references public.facilities(id) on delete restrict,
  supplying_facility_id uuid not null references public.facilities(id) on delete restrict,
  medicine_id uuid not null references public.medicines(id) on delete restrict,
  requested_quantity integer not null check (requested_quantity > 0),
  approved_quantity integer check (approved_quantity > 0 and approved_quantity <= requested_quantity),
  fulfilled_quantity integer not null default 0 check (fulfilled_quantity >= 0 and fulfilled_quantity <= coalesce(approved_quantity, 0)),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED')),
  request_notes text,
  created_by uuid not null references public.profiles(id) on delete restrict,
  reviewed_by uuid references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requesting_facility_id <> supplying_facility_id),
  unique (id, supplying_facility_id, medicine_id)
);

-- Composite foreign keys prevent reserving a different supplier's stock or a different medicine.
create table public.request_reservations (
  id uuid primary key default gen_random_uuid(),
  supply_request_id uuid not null,
  inventory_batch_id uuid not null,
  supplying_facility_id uuid not null,
  medicine_id uuid not null,
  quantity integer not null check (quantity > 0),
  created_at timestamptz not null default now(),
  foreign key (supply_request_id, supplying_facility_id, medicine_id) references public.supply_requests(id, supplying_facility_id, medicine_id) on delete restrict,
  foreign key (inventory_batch_id, supplying_facility_id, medicine_id) references public.inventory_batches(id, facility_id, medicine_id) on delete restrict,
  unique (supply_request_id, inventory_batch_id)
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null,
  inventory_batch_id uuid not null,
  medicine_id uuid not null,
  movement_type text not null check (movement_type in ('INITIAL_STOCK', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'FULFILMENT_OUT')),
  quantity integer not null check (quantity > 0),
  supply_request_id uuid references public.supply_requests(id) on delete restrict,
  performed_by uuid not null references public.profiles(id) on delete restrict,
  notes text,
  created_at timestamptz not null default now(),
  foreign key (inventory_batch_id, facility_id, medicine_id) references public.inventory_batches(id, facility_id, medicine_id) on delete restrict,
  check (movement_type <> 'FULFILMENT_OUT' or supply_request_id is not null)
);

create table public.request_events (
  id uuid primary key default gen_random_uuid(),
  supply_request_id uuid not null references public.supply_requests(id) on delete restrict,
  event_type text not null check (event_type in ('CREATED', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED')),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  previous_status text check (previous_status in ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED')),
  new_status text not null check (new_status in ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED')),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index profiles_facility_idx on public.profiles(facility_id);
create index inventory_discovery_idx on public.inventory_batches(medicine_id, facility_id, expiry_date);
create index requests_incoming_idx on public.supply_requests(supplying_facility_id, status, created_at desc);
create index requests_outgoing_idx on public.supply_requests(requesting_facility_id, status, created_at desc);
create index reservations_batch_idx on public.request_reservations(inventory_batch_id);
create index movements_batch_idx on public.stock_movements(inventory_batch_id, created_at desc);
create index events_request_idx on public.request_events(supply_request_id, created_at);

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger facilities_updated before update on public.facilities for each row execute function public.set_updated_at();
create trigger profiles_updated before update on public.profiles for each row execute function public.set_updated_at();
create trigger medicines_updated before update on public.medicines for each row execute function public.set_updated_at();
create trigger batches_updated before update on public.inventory_batches for each row execute function public.set_updated_at();
create trigger requests_updated before update on public.supply_requests for each row execute function public.set_updated_at();

-- Helpers derive identity from Supabase Auth and avoid recursive RLS checks.
create function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_status = 'ACTIVE' and p.role = 'PLATFORM_ADMIN');
$$;
create function public.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_status = 'ACTIVE' and (p.role = 'PLATFORM_ADMIN' or exists (select 1 from public.facilities f where f.id = p.facility_id and f.operational_status = 'ACTIVE')));
$$;
create function public.can_access_facility(target_facility uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_platform_admin() or exists (select 1 from public.profiles p join public.facilities f on f.id = p.facility_id where p.id = auth.uid() and p.account_status = 'ACTIVE' and p.facility_id = target_facility and f.operational_status = 'ACTIVE');
$$;
create function public.is_facility_admin(target_facility uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p join public.facilities f on f.id = p.facility_id where p.id = auth.uid() and p.account_status = 'ACTIVE' and p.role = 'FACILITY_ADMIN' and p.facility_id = target_facility and f.operational_status = 'ACTIVE');
$$;
create function public.can_view_request(target_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.supply_requests r where r.id = target_request and (public.can_access_facility(r.requesting_facility_id) or public.can_access_facility(r.supplying_facility_id)));
$$;

alter table public.facilities enable row level security;
alter table public.profiles enable row level security;
alter table public.medicines enable row level security;
alter table public.inventory_batches enable row level security;
alter table public.supply_requests enable row level security;
alter table public.request_reservations enable row level security;
alter table public.stock_movements enable row level security;
alter table public.request_events enable row level security;

create policy facilities_read on public.facilities for select to authenticated using (public.is_platform_admin() or (public.is_active_user() and operational_status = 'ACTIVE'));
create policy profiles_read on public.profiles for select to authenticated using (public.is_platform_admin() or (id = auth.uid() and public.is_active_user()) or public.is_facility_admin(facility_id));
create policy medicines_read on public.medicines for select to authenticated using (public.is_active_user());
create policy inventory_read on public.inventory_batches for select to authenticated using (public.can_access_facility(facility_id));
create policy requests_read on public.supply_requests for select to authenticated using (public.can_access_facility(requesting_facility_id) or public.can_access_facility(supplying_facility_id));
create policy reservations_read on public.request_reservations for select to authenticated using (public.can_view_request(supply_request_id));
create policy movements_read on public.stock_movements for select to authenticated using (public.can_access_facility(facility_id));
create policy events_read on public.request_events for select to authenticated using (public.can_view_request(supply_request_id));

revoke all on public.facilities, public.profiles, public.medicines, public.inventory_batches, public.supply_requests, public.request_reservations, public.stock_movements, public.request_events from anon, authenticated;
grant select on public.facilities, public.profiles, public.medicines, public.inventory_batches, public.supply_requests, public.request_reservations, public.stock_movements, public.request_events to authenticated;
revoke all on function public.is_platform_admin(), public.is_active_user(), public.can_access_facility(uuid), public.is_facility_admin(uuid), public.can_view_request(uuid) from public, anon;
grant execute on function public.is_platform_admin(), public.is_active_user(), public.can_access_facility(uuid), public.is_facility_admin(uuid), public.can_view_request(uuid) to authenticated;
commit;
