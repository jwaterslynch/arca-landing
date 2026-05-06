-- Arca Product Access Schema v1
-- Date: 2026-05-06
-- Scope: product access requests, invite redemption, memberships, and download audit.
--
-- Apply after the base Arca sync schema. This is intentionally product-general
-- so the same pattern can later serve Fieldwork, JIA, Founder Compact, and Diwan.

begin;

create extension if not exists pgcrypto;

create table if not exists public.product_access_requests (
  id uuid primary key default gen_random_uuid(),
  product text not null,
  email text not null,
  name text,
  organization text,
  message text,
  access_type text,
  status text not null default 'new'
    check (status in ('new', 'approved', 'invited', 'converted', 'rejected', 'spam', 'archived')),
  source_url text,
  page_path text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_invites (
  id uuid primary key default gen_random_uuid(),
  product text not null,
  email text,
  code_hash text not null,
  label text,
  tier text not null default 'alpha'
    check (tier in ('alpha', 'beta', 'founder', 'internal', 'free', 'paid')),
  role text not null default 'tester'
    check (role in ('owner', 'admin', 'tester', 'viewer')),
  status text not null default 'active'
    check (status in ('active', 'redeemed', 'revoked', 'expired')),
  max_redemptions integer not null default 1 check (max_redemptions > 0),
  redemption_count integer not null default 0 check (redemption_count >= 0),
  expires_at timestamptz,
  last_redeemed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product, code_hash)
);

create table if not exists public.product_memberships (
  id uuid primary key default gen_random_uuid(),
  product text not null,
  user_id uuid references auth.users(id) on delete set null,
  email text not null,
  tier text not null default 'alpha'
    check (tier in ('alpha', 'beta', 'founder', 'internal', 'free', 'paid')),
  role text not null default 'tester'
    check (role in ('owner', 'admin', 'tester', 'viewer')),
  status text not null default 'active'
    check (status in ('active', 'revoked', 'expired')),
  source text not null default 'manual',
  invite_id uuid references public.product_invites(id) on delete set null,
  invite_code_hash text,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product, email)
);

create unique index if not exists product_memberships_product_user_unique
  on public.product_memberships(product, user_id)
  where user_id is not null;

create table if not exists public.product_download_events (
  id uuid primary key default gen_random_uuid(),
  product text not null,
  user_id uuid references auth.users(id) on delete set null,
  email text not null,
  membership_id uuid references public.product_memberships(id) on delete set null,
  invite_id uuid references public.product_invites(id) on delete set null,
  invite_code_hash text,
  artifact_name text,
  artifact_version text,
  source_url text,
  page_path text,
  user_agent text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists product_access_requests_product_created_idx
  on public.product_access_requests(product, created_at desc);

create index if not exists product_access_requests_email_idx
  on public.product_access_requests(lower(email));

create index if not exists product_invites_product_status_idx
  on public.product_invites(product, status);

create index if not exists product_memberships_user_idx
  on public.product_memberships(user_id);

create index if not exists product_memberships_email_idx
  on public.product_memberships(lower(email));

create index if not exists product_download_events_product_created_idx
  on public.product_download_events(product, created_at desc);

create or replace function public.arca_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_product_access_requests_set_updated_at on public.product_access_requests;
create trigger trg_product_access_requests_set_updated_at
before update on public.product_access_requests
for each row execute function public.arca_set_updated_at();

drop trigger if exists trg_product_invites_set_updated_at on public.product_invites;
create trigger trg_product_invites_set_updated_at
before update on public.product_invites
for each row execute function public.arca_set_updated_at();

drop trigger if exists trg_product_memberships_set_updated_at on public.product_memberships;
create trigger trg_product_memberships_set_updated_at
before update on public.product_memberships
for each row execute function public.arca_set_updated_at();

alter table public.product_access_requests enable row level security;
alter table public.product_invites enable row level security;
alter table public.product_memberships enable row level security;
alter table public.product_download_events enable row level security;

create or replace function public.arca_current_email()
returns text
language sql
stable
as $$
  select lower(nullif(coalesce(auth.jwt() ->> 'email', ''), ''));
$$;

drop policy if exists product_access_requests_select_own_email on public.product_access_requests;
create policy product_access_requests_select_own_email
on public.product_access_requests
for select
to authenticated
using (lower(email) = public.arca_current_email());

drop policy if exists product_memberships_select_own on public.product_memberships;
create policy product_memberships_select_own
on public.product_memberships
for select
to authenticated
using (
  user_id = auth.uid()
  or lower(email) = public.arca_current_email()
);

drop policy if exists product_download_events_select_own on public.product_download_events;
create policy product_download_events_select_own
on public.product_download_events
for select
to authenticated
using (
  user_id = auth.uid()
  or lower(email) = public.arca_current_email()
);

create or replace function public.claim_product_membership(
  p_product text default 'arca'
)
returns table (
  product text,
  tier text,
  role text,
  status text,
  expires_at timestamptz,
  granted_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_product text := lower(trim(coalesce(p_product, 'arca')));
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select lower(nullif(coalesce(u.email, auth.jwt() ->> 'email', ''), ''))
  into v_email
  from auth.users u
  where u.id = auth.uid();

  if v_email is null then
    return;
  end if;

  update public.product_memberships m
  set user_id = auth.uid(),
      updated_at = now()
  where m.product = v_product
    and lower(m.email) = v_email
    and (m.user_id is null or m.user_id = auth.uid())
    and m.status = 'active'
    and (m.expires_at is null or m.expires_at > now());

  return query
  select
    m.product,
    m.tier,
    m.role,
    m.status,
    m.expires_at,
    m.granted_at
  from public.product_memberships m
  where m.product = v_product
    and (m.user_id = auth.uid() or lower(m.email) = v_email)
    and m.status = 'active'
    and (m.expires_at is null or m.expires_at > now())
  order by m.granted_at desc
  limit 1;
end;
$$;

create or replace function public.current_user_product_access(
  p_product text default 'arca'
)
returns table (
  product text,
  tier text,
  role text,
  status text,
  expires_at timestamptz,
  granted_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select *
  from public.claim_product_membership(p_product);
$$;

grant usage on schema public to anon, authenticated, service_role;

grant select on table public.product_access_requests to authenticated;
grant select on table public.product_memberships to authenticated;
grant select on table public.product_download_events to authenticated;

grant all on table public.product_access_requests to service_role;
grant all on table public.product_invites to service_role;
grant all on table public.product_memberships to service_role;
grant all on table public.product_download_events to service_role;

grant execute on function public.claim_product_membership(text) to authenticated;
grant execute on function public.current_user_product_access(text) to authenticated;

commit;
