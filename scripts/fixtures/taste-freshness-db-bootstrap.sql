-- Minimal local Supabase substrate; real repository migrations follow.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth, public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.products (
  id uuid primary key, title text, brand text, category text,
  user_id uuid references auth.users(id), catalog_product_id uuid
);
alter table public.products enable row level security;
create policy "Products are readable" on public.products for select to anon, authenticated using (true);
