create table if not exists public.product_likes (
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, product_id)
);

create index if not exists product_likes_product_id_idx
  on public.product_likes (product_id);

alter table public.product_likes enable row level security;

create policy "Users can view their own product likes"
  on public.product_likes
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can create their own product likes"
  on public.product_likes
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can delete their own product likes"
  on public.product_likes
  for delete
  to authenticated
  using (auth.uid() = user_id);

create table if not exists public.product_saves (
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, product_id)
);

create index if not exists product_saves_product_id_idx
  on public.product_saves (product_id);

alter table public.product_saves enable row level security;

create policy "Users can view their own product saves"
  on public.product_saves
  for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can create their own product saves"
  on public.product_saves
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can delete their own product saves"
  on public.product_saves
  for delete
  to authenticated
  using (auth.uid() = user_id);
