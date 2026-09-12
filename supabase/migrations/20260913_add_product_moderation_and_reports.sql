create table if not exists public.product_moderation (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null unique references public.products(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'blurred', 'hidden', 'failed')),
  risk_level text check (risk_level is null or risk_level in ('low', 'medium', 'high')),
  provider text,
  labels jsonb not null default '{}'::jsonb,
  is_blurred boolean not null default false,
  is_hidden boolean not null default false,
  review_reason text,
  moderated_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists product_moderation_status_idx on public.product_moderation(status);
create index if not exists product_moderation_hidden_idx on public.product_moderation(is_hidden);

create table if not exists public.product_reports (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  reporter_id uuid not null references auth.users(id) on delete cascade,
  reason text not null check (reason in ('nudity', 'violence', 'hate', 'scam', 'illegal', 'spam', 'other')),
  details text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (product_id, reporter_id, reason)
);

create index if not exists product_reports_product_idx on public.product_reports(product_id);
create index if not exists product_reports_reporter_idx on public.product_reports(reporter_id);

alter table public.product_moderation enable row level security;
alter table public.product_reports enable row level security;

create policy "Authenticated users can read moderation display state"
  on public.product_moderation for select to authenticated
  using (true);

create policy "Owners can create product moderation rows"
  on public.product_moderation for insert to authenticated
  with check (exists (select 1 from public.products p where p.id = product_id and p.user_id = auth.uid()));

create policy "Authenticated users can report products"
  on public.product_reports for insert to authenticated
  with check (reporter_id = auth.uid());

create or replace function public.escalate_product_reports()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  unique_reporters integer;
begin
  select count(distinct reporter_id) into unique_reporters
  from public.product_reports
  where product_id = new.product_id;

  if unique_reporters >= 3 then
    insert into public.product_moderation (product_id, status, is_blurred, review_reason)
    values (new.product_id, 'blurred', true, 'Three or more unique user reports')
    on conflict (product_id) do update
      set is_blurred = true,
          status = case when product_moderation.status = 'hidden' then 'hidden' else 'blurred' end,
          review_reason = 'Three or more unique user reports',
          updated_at = timezone('utc', now());
  end if;
  return new;
end;
$$;

drop trigger if exists product_reports_escalation on public.product_reports;
create trigger product_reports_escalation
  after insert on public.product_reports
  for each row execute function public.escalate_product_reports();

create or replace function public.set_product_moderation_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists product_moderation_updated_at on public.product_moderation;
create trigger product_moderation_updated_at
  before update on public.product_moderation
  for each row execute function public.set_product_moderation_updated_at();