-- Behavioral event tracking foundation for a future recommendation engine.
-- Authenticated users only for now: the client (anon) key has no safe way to
-- prove session identity for anonymous rows, so we only accept inserts tied
-- to auth.uid() and skip tracking entirely when signed out (see lib/analytics.ts).

create table if not exists public.user_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  session_id text,
  event_type text not null,
  product_id uuid references public.products (id) on delete cascade,
  seller_id uuid references auth.users (id) on delete cascade,
  category text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists user_events_user_id_idx
  on public.user_events (user_id);

create index if not exists user_events_event_type_idx
  on public.user_events (event_type);

create index if not exists user_events_product_id_idx
  on public.user_events (product_id);

create index if not exists user_events_seller_id_idx
  on public.user_events (seller_id);

create index if not exists user_events_created_at_idx
  on public.user_events (created_at);

alter table public.user_events enable row level security;

-- Insert-only: users may record their own events but cannot read, edit, or
-- delete historical events through the client. No select/update/delete
-- policies exist, so those actions are denied by default under RLS.
create policy "Users can record their own events"
  on public.user_events
  for insert
  to authenticated
  with check (auth.uid() = user_id);
