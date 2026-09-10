create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_url text,
  bio text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create or replace function public.set_user_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists trg_user_profiles_updated_at on public.user_profiles;
create trigger trg_user_profiles_updated_at
before update on public.user_profiles
for each row
execute function public.set_user_profiles_updated_at();

alter table public.user_profiles enable row level security;

create policy "Profiles are publicly readable"
  on public.user_profiles
  for select
  to anon, authenticated
  using (true);

create policy "Users can create their own profile"
  on public.user_profiles
  for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their own profile"
  on public.user_profiles
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.user_follows (
  follower_id uuid not null references auth.users (id) on delete cascade,
  following_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (follower_id, following_id),
  constraint user_follows_no_self_follow check (follower_id <> following_id)
);

create index if not exists user_follows_follower_id_idx
  on public.user_follows (follower_id);

create index if not exists user_follows_following_id_idx
  on public.user_follows (following_id);

alter table public.user_follows enable row level security;

create policy "Follows are publicly readable"
  on public.user_follows
  for select
  to anon, authenticated
  using (true);

create policy "Users can follow from their own account"
  on public.user_follows
  for insert
  to authenticated
  with check (auth.uid() = follower_id);

create policy "Users can unfollow from their own account"
  on public.user_follows
  for delete
  to authenticated
  using (auth.uid() = follower_id);
