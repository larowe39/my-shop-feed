create table if not exists public.catalog_categories (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.catalog_subcategories (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.catalog_categories(id) on delete cascade,
  parent_subcategory_id uuid references public.catalog_subcategories(id) on delete cascade,
  slug text not null,
  name text not null,
  description text,
  sort_order integer not null default 0,
  created_at timestamptz not null default timezone('utc', now())
);

create unique index if not exists catalog_subcategories_sibling_slug_idx
  on public.catalog_subcategories (category_id, coalesce(parent_subcategory_id, '00000000-0000-0000-0000-000000000000'::uuid), slug);

create table if not exists public.catalog_brands (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  website_url text,
  logo_url text,
  description text,
  created_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.catalog_product_families (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.catalog_brands(id) on delete cascade,
  subcategory_id uuid references public.catalog_subcategories(id) on delete set null,
  slug text not null,
  name text not null,
  description text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (brand_id, slug)
);

create table if not exists public.catalog_products (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references public.catalog_brands(id) on delete restrict,
  family_id uuid references public.catalog_product_families(id) on delete set null,
  subcategory_id uuid references public.catalog_subcategories(id) on delete set null,
  slug text unique not null,
  name text not null,
  model_number text,
  release_year integer,
  description text,
  upc text,
  gtin text,
  mpn text,
  status text not null default 'active' check (status in ('active', 'discontinued', 'upcoming', 'unknown')),
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create table if not exists public.catalog_product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.catalog_products(id) on delete cascade,
  slug text not null,
  name text not null,
  sku text,
  upc text,
  gtin text,
  color text,
  size text,
  attributes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (product_id, slug)
);

create table if not exists public.catalog_aliases (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('brand', 'family', 'product', 'variant', 'subcategory')),
  entity_id uuid not null,
  alias text not null,
  normalized_alias text not null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (entity_type, normalized_alias)
);

comment on table public.catalog_aliases is
  'Normalized matching aliases. entity_id is intentionally polymorphic and is interpreted by entity_type; writes belong in trusted admin tooling.';
comment on column public.products.catalog_product_id is
  'Optional canonical real-world product referenced by this user listing; null means the listing is not yet matched.';
comment on column public.products.catalog_variant_id is
  'Optional canonical variant referenced by this user listing; null means no variant was confirmed.';

create index if not exists catalog_subcategories_category_idx on public.catalog_subcategories(category_id);
create index if not exists catalog_subcategories_parent_idx on public.catalog_subcategories(parent_subcategory_id);
create index if not exists catalog_product_families_brand_idx on public.catalog_product_families(brand_id);
create index if not exists catalog_product_families_subcategory_idx on public.catalog_product_families(subcategory_id);
create index if not exists catalog_products_brand_idx on public.catalog_products(brand_id);
create index if not exists catalog_products_family_idx on public.catalog_products(family_id);
create index if not exists catalog_products_subcategory_idx on public.catalog_products(subcategory_id);
create index if not exists catalog_products_model_number_idx on public.catalog_products(model_number) where model_number is not null;
create index if not exists catalog_products_upc_idx on public.catalog_products(upc) where upc is not null;
create index if not exists catalog_products_gtin_idx on public.catalog_products(gtin) where gtin is not null;
create index if not exists catalog_products_mpn_idx on public.catalog_products(mpn) where mpn is not null;
create index if not exists catalog_products_name_idx on public.catalog_products(name);
create index if not exists catalog_product_variants_product_idx on public.catalog_product_variants(product_id);
create index if not exists catalog_aliases_entity_idx on public.catalog_aliases(entity_type, entity_id);
create index if not exists catalog_aliases_normalized_idx on public.catalog_aliases(normalized_alias);

alter table public.products add column if not exists catalog_product_id uuid references public.catalog_products(id) on delete set null;
alter table public.products add column if not exists catalog_variant_id uuid references public.catalog_product_variants(id) on delete set null;

create index if not exists products_catalog_product_id_idx on public.products(catalog_product_id);
create index if not exists products_catalog_variant_id_idx on public.products(catalog_variant_id);

create or replace function public.set_catalog_product_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists catalog_product_updated_at on public.catalog_products;
create trigger catalog_product_updated_at
  before update on public.catalog_products
  for each row execute function public.set_catalog_product_updated_at();

alter table public.catalog_categories enable row level security;
alter table public.catalog_subcategories enable row level security;
alter table public.catalog_brands enable row level security;
alter table public.catalog_product_families enable row level security;
alter table public.catalog_products enable row level security;
alter table public.catalog_product_variants enable row level security;
alter table public.catalog_aliases enable row level security;

grant select on public.catalog_categories, public.catalog_subcategories, public.catalog_brands,
  public.catalog_product_families, public.catalog_products, public.catalog_product_variants,
  public.catalog_aliases to anon, authenticated;

create policy "Catalog categories are publicly readable" on public.catalog_categories
  for select to anon, authenticated using (true);
create policy "Catalog subcategories are publicly readable" on public.catalog_subcategories
  for select to anon, authenticated using (true);
create policy "Catalog brands are publicly readable" on public.catalog_brands
  for select to anon, authenticated using (true);
create policy "Catalog product families are publicly readable" on public.catalog_product_families
  for select to anon, authenticated using (true);
create policy "Catalog products are publicly readable" on public.catalog_products
  for select to anon, authenticated using (true);
create policy "Catalog variants are publicly readable" on public.catalog_product_variants
  for select to anon, authenticated using (true);
create policy "Catalog aliases are publicly readable" on public.catalog_aliases
  for select to anon, authenticated using (true);

insert into public.catalog_categories (slug, name, description, sort_order) values
  ('electronics', 'Electronics', 'Audio, phones, computers, cameras and gaming.', 10),
  ('fashion', 'Fashion', 'Apparel, streetwear and outerwear.', 20),
  ('shoes', 'Shoes', 'Sneakers, boots and footwear.', 30),
  ('watches', 'Watches', 'Timepieces, luxury and vintage watches.', 40),
  ('automotive', 'Automotive', 'Vehicles, parts, tools and car care.', 50),
  ('home', 'Home', 'Furniture, kitchen and interior goods.', 60),
  ('outdoors', 'Outdoors', 'Trail, camp and adventure gear.', 70),
  ('beauty', 'Beauty', 'Skincare, grooming and fragrance.', 80),
  ('fitness', 'Fitness', 'Activewear, equipment and training.', 90),
  ('accessories', 'Accessories', 'Bags, eyewear, jewelry and everyday carry.', 100)
on conflict (slug) do nothing;

insert into public.catalog_subcategories (category_id, slug, name, sort_order)
select category.id, item.slug, item.name, item.sort_order
from (values
  ('electronics', 'audio', 'Audio', 10),
  ('electronics', 'phones', 'Phones', 20),
  ('electronics', 'computers', 'Computers', 30),
  ('electronics', 'cameras', 'Cameras', 40),
  ('electronics', 'gaming', 'Gaming', 50),
  ('fashion', 'apparel', 'Apparel', 10),
  ('fashion', 'outerwear', 'Outerwear', 20),
  ('shoes', 'sneakers', 'Sneakers', 10),
  ('shoes', 'boots', 'Boots', 20),
  ('watches', 'luxury-watches', 'Luxury Watches', 10),
  ('watches', 'sport-watches', 'Sport Watches', 20),
  ('watches', 'dive-watches', 'Dive Watches', 30),
  ('watches', 'dress-watches', 'Dress Watches', 40),
  ('watches', 'smartwatches', 'Smartwatches', 50),
  ('automotive', 'vehicles', 'Vehicles', 10),
  ('automotive', 'parts', 'Parts', 20),
  ('automotive', 'automotive-accessories', 'Accessories', 30),
  ('automotive', 'tools', 'Tools', 40),
  ('automotive', 'car-care', 'Car Care', 50),
  ('home', 'furniture', 'Furniture', 10),
  ('home', 'kitchen', 'Kitchen', 20),
  ('outdoors', 'camping', 'Camping', 10),
  ('outdoors', 'hiking', 'Hiking', 20),
  ('beauty', 'skincare', 'Skincare', 10),
  ('beauty', 'fragrance', 'Fragrance', 20),
  ('fitness', 'training', 'Training', 10),
  ('fitness', 'recovery', 'Recovery', 20),
  ('accessories', 'bags', 'Bags', 10),
  ('accessories', 'eyewear', 'Eyewear', 20)
) as item(category_slug, parent_slug, slug, name, sort_order)
join public.catalog_categories category on category.slug = item.category_slug
where item.parent_slug is null
on conflict do nothing;

insert into public.catalog_subcategories (category_id, parent_subcategory_id, slug, name, sort_order)
select category.id, parent.id, item.slug, item.name, item.sort_order
from (values
  ('electronics', 'audio', 'portable-speakers', 'Portable Speakers', 11),
  ('electronics', 'audio', 'headphones', 'Headphones', 12),
  ('electronics', 'audio', 'home-audio', 'Home Audio', 13)
) as item(category_slug, parent_slug, slug, name, sort_order)
join public.catalog_categories category on category.slug = item.category_slug
join public.catalog_subcategories parent
  on parent.category_id = category.id and parent.slug = item.parent_slug
on conflict do nothing;

insert into public.catalog_brands (slug, name, website_url) values
  ('jbl', 'JBL', 'https://www.jbl.com'),
  ('tudor', 'Tudor', 'https://www.tudorwatch.com'),
  ('omega', 'Omega', 'https://www.omegawatches.com'),
  ('new-balance', 'New Balance', 'https://www.newbalance.com'),
  ('salomon', 'Salomon', 'https://www.salomon.com'),
  ('patagonia', 'Patagonia', 'https://www.patagonia.com'),
  ('apple', 'Apple', 'https://www.apple.com'),
  ('sony', 'Sony', 'https://www.sony.com'),
  ('herman-miller', 'Herman Miller', 'https://www.hermanmiller.com'),
  ('therabody', 'Therabody', 'https://www.therabody.com'),
  ('nike', 'Nike', 'https://www.nike.com'),
  ('adidas', 'Adidas', 'https://www.adidas.com'),
  ('dyson', 'Dyson', 'https://www.dyson.com'),
  ('canon', 'Canon', 'https://www.usa.canon.com'),
  ('rolex', 'Rolex', 'https://www.rolex.com'),
  ('arcteryx', 'Arc''teryx', 'https://arcteryx.com'),
  ('le-labo', 'Le Labo', 'https://www.lelabofragrances.com'),
  ('lululemon', 'Lululemon', 'https://shop.lululemon.com'),
  ('thule', 'Thule', 'https://www.thule.com'),
  ('seiko', 'Seiko', 'https://www.seikowatches.com')
on conflict (slug) do nothing;

insert into public.catalog_product_families (brand_id, subcategory_id, slug, name)
select brand.id, subcategory.id, item.family_slug, item.family_name
from (values
  ('jbl', 'electronics', 'portable-speakers', 'boombox', 'Boombox'),
  ('jbl', 'electronics', 'portable-speakers', 'charge', 'Charge'),
  ('jbl', 'electronics', 'portable-speakers', 'flip', 'Flip'),
  ('tudor', 'watches', 'dive-watches', 'black-bay', 'Black Bay'),
  ('omega', 'watches', 'dive-watches', 'seamaster', 'Seamaster'),
  ('new-balance', 'shoes', 'sneakers', '990', '990'),
  ('salomon', 'shoes', 'sneakers', 'xt', 'XT'),
  ('patagonia', 'outdoors', 'hiking', 'nano-puff', 'Nano Puff'),
  ('apple', 'electronics', 'phones', 'iphone', 'iPhone'),
  ('sony', 'electronics', 'headphones', 'wh-1000x', 'WH-1000X'),
  ('herman-miller', 'home', 'furniture', 'aeron', 'Aeron'),
  ('therabody', 'fitness', 'recovery', 'theragun', 'Theragun'),
  ('nike', 'shoes', 'sneakers', 'air-max', 'Air Max'),
  ('adidas', 'shoes', 'sneakers', 'samba', 'Samba'),
  ('dyson', 'beauty', 'skincare', 'airwrap', 'Airwrap'),
  ('canon', 'electronics', 'cameras', 'eos-r', 'EOS R'),
  ('rolex', 'watches', 'dive-watches', 'submariner', 'Submariner'),
  ('arcteryx', 'outdoors', 'hiking', 'beta', 'Beta'),
  ('le-labo', 'beauty', 'fragrance', 'santal', 'Santal'),
  ('lululemon', 'fitness', 'training', 'align', 'Align'),
  ('thule', 'automotive', 'automotive-accessories', 'motion', 'Motion'),
  ('seiko', 'watches', 'sport-watches', 'prospex', 'Prospex')
) as item(brand_slug, category_slug, subcategory_slug, family_slug, family_name)
join public.catalog_brands brand on brand.slug = item.brand_slug
join public.catalog_categories category on category.slug = item.category_slug
join public.catalog_subcategories subcategory
  on subcategory.category_id = category.id and subcategory.slug = item.subcategory_slug
on conflict (brand_id, slug) do nothing;

insert into public.catalog_products (brand_id, family_id, subcategory_id, slug, name, model_number, release_year)
select brand.id, family.id, subcategory.id, item.product_slug, item.product_name, item.model_number, item.release_year
from (values
  ('jbl', 'boombox', 'electronics', 'portable-speakers', 'jbl-boombox-3', 'Boombox 3', 'Boombox 3', 2022),
  ('jbl', 'charge', 'electronics', 'portable-speakers', 'jbl-charge-5', 'Charge 5', 'Charge 5', 2021),
  ('jbl', 'flip', 'electronics', 'portable-speakers', 'jbl-flip-6', 'Flip 6', 'Flip 6', 2021),
  ('tudor', 'black-bay', 'watches', 'dive-watches', 'tudor-black-bay-58', 'Black Bay 58', '79030N', 2018),
  ('omega', 'seamaster', 'watches', 'dive-watches', 'omega-seamaster-diver-300m', 'Seamaster Diver 300M', '210.30.42.20.01.001', 2018),
  ('new-balance', '990', 'shoes', 'sneakers', 'new-balance-990v6', '990v6', 'M990GL6', 2022),
  ('salomon', 'xt', 'shoes', 'sneakers', 'salomon-xt-6', 'XT-6', 'L47450600', 2013),
  ('patagonia', 'nano-puff', 'outdoors', 'hiking', 'patagonia-nano-puff-jacket', 'Nano Puff Jacket', '84212', 2009),
  ('apple', 'iphone', 'electronics', 'phones', 'apple-iphone-15-pro', 'iPhone 15 Pro', 'A2848', 2023),
  ('apple', 'iphone', 'electronics', 'phones', 'apple-iphone-16-pro', 'iPhone 16 Pro', 'A3283', 2024),
  ('sony', 'wh-1000x', 'electronics', 'headphones', 'sony-wh-1000xm5', 'WH-1000XM5', 'WH1000XM5/B', 2022),
  ('sony', 'wh-1000x', 'electronics', 'headphones', 'sony-wh-1000xm4', 'WH-1000XM4', 'WH1000XM4/B', 2020),
  ('herman-miller', 'aeron', 'home', 'furniture', 'herman-miller-aeron-chair', 'Aeron Chair', null, 1994),
  ('therabody', 'theragun', 'fitness', 'recovery', 'theragun-prime', 'Theragun Prime', 'TG0003513-3A10', 2020),
  ('nike', 'air-max', 'shoes', 'sneakers', 'nike-air-max-1', 'Air Max 1', 'DZ3307-003', 1987),
  ('adidas', 'samba', 'shoes', 'sneakers', 'adidas-samba-og', 'Samba OG', 'B75806', 1950),
  ('dyson', 'airwrap', 'beauty', 'skincare', 'dyson-airwrap', 'Airwrap Multi-Styler', 'HS05', 2022),
  ('canon', 'eos-r', 'electronics', 'cameras', 'canon-eos-r5', 'EOS R5', '4147C002', 2020),
  ('rolex', 'submariner', 'watches', 'dive-watches', 'rolex-submariner-date', 'Submariner Date', '126610LN', 2020),
  ('arcteryx', 'beta', 'outdoors', 'hiking', 'arcteryx-beta-jacket', 'Beta Jacket', 'X000007584', 2022),
  ('le-labo', 'santal', 'beauty', 'fragrance', 'le-labo-santal-33', 'Santal 33', null, 2011),
  ('lululemon', 'align', 'fitness', 'training', 'lululemon-align-pant', 'Align Pant', 'W26900', 2015),
  ('thule', 'motion', 'automotive', 'automotive-accessories', 'thule-motion-xt-l', 'Motion XT L', '629801', 2017),
  ('seiko', 'prospex', 'watches', 'sport-watches', 'seiko-prospex-speedtimer', 'Prospex Speedtimer', 'SSC813', 2021),
  ('jbl', 'boombox', 'electronics', 'portable-speakers', 'jbl-boombox-2', 'Boombox 2', 'JBLBOOMBOX2BLUAM', 2020),
  ('omega', 'seamaster', 'watches', 'dive-watches', 'omega-seamaster-aqua-terra', 'Seamaster Aqua Terra', '220.10.41.21.03.001', 2017),
  ('new-balance', '990', 'shoes', 'sneakers', 'new-balance-990v5', '990v5', 'M990GL5', 2016),
  ('patagonia', 'nano-puff', 'outdoors', 'hiking', 'patagonia-nano-puff-vest', 'Nano Puff Vest', '84242', 2009),
  ('sony', 'wh-1000x', 'electronics', 'headphones', 'sony-wh-1000xm3', 'WH-1000XM3', 'WH1000XM3/B', 2018),
  ('apple', 'iphone', 'electronics', 'phones', 'apple-iphone-15', 'iPhone 15', 'A2846', 2023)
) as item(brand_slug, family_slug, category_slug, subcategory_slug, product_slug, product_name, model_number, release_year)
join public.catalog_brands brand on brand.slug = item.brand_slug
join public.catalog_product_families family on family.brand_id = brand.id and family.slug = item.family_slug
join public.catalog_categories category on category.slug = item.category_slug
join public.catalog_subcategories subcategory
  on subcategory.category_id = category.id and subcategory.slug = item.subcategory_slug
on conflict (slug) do nothing;

insert into public.catalog_product_variants (product_id, slug, name, color)
select product.id, variant.slug, variant.name, variant.color
from (values
  ('jbl-boombox-3', 'black', 'Black', 'Black'),
  ('jbl-boombox-3', 'squad', 'Squad', 'Squad'),
  ('jbl-boombox-3', 'white', 'White', 'White'),
  ('tudor-black-bay-58', 'black-dial-steel', 'Black Dial / Steel Bracelet', 'Black'),
  ('tudor-black-bay-58', 'navy-dial-steel', 'Navy Dial / Steel Bracelet', 'Navy')
) as variant(product_slug, slug, name, color)
join public.catalog_products product on product.slug = variant.product_slug
on conflict (product_id, slug) do nothing;

insert into public.catalog_aliases (entity_type, entity_id, alias, normalized_alias)
select 'brand', brand.id, alias.alias, alias.normalized_alias
from (values
  ('jbl', 'J.B.L.', 'jbl'),
  ('tudor', 'Tudor Watch', 'tudor watch'),
  ('new-balance', 'NB', 'nb'),
  ('arcteryx', 'Arc''teryx', 'arcteryx'),
  ('therabody', 'Theragun', 'theragun')
) as alias(brand_slug, alias, normalized_alias)
join public.catalog_brands brand on brand.slug = alias.brand_slug
on conflict (entity_type, normalized_alias) do nothing;

insert into public.catalog_aliases (entity_type, entity_id, alias, normalized_alias)
select 'product', product.id, alias.alias, alias.normalized_alias
from (values
  ('jbl-boombox-3', 'Boom Box 3', 'boom box 3'),
  ('jbl-boombox-3', 'Boombox III', 'boombox iii'),
  ('jbl-boombox-3', 'JBL BoomBox3', 'jbl boombox3'),
  ('jbl-charge-5', 'JBL Charge V', 'jbl charge v'),
  ('tudor-black-bay-58', 'Blackbay 58', 'blackbay 58'),
  ('omega-seamaster-diver-300m', 'Seamaster Diver', 'seamaster diver'),
  ('new-balance-990v6', 'NB 990 v6', 'nb 990 v6'),
  ('salomon-xt-6', 'Salomon XT6', 'salomon xt6'),
  ('patagonia-nano-puff-jacket', 'Nano Puff', 'nano puff'),
  ('apple-iphone-15-pro', 'iPhone15 Pro', 'iphone15 pro'),
  ('sony-wh-1000xm5', 'Sony XM5', 'sony xm5'),
  ('herman-miller-aeron-chair', 'Aeron', 'aeron'),
  ('theragun-prime', 'Theragun Prime Massage Gun', 'theragun prime massage gun'),
  ('dyson-airwrap', 'Dyson Air Wrap', 'dyson air wrap'),
  ('rolex-submariner-date', 'Sub Date', 'sub date')
) as alias(product_slug, alias, normalized_alias)
join public.catalog_products product on product.slug = alias.product_slug
on conflict (entity_type, normalized_alias) do nothing;

insert into public.catalog_aliases (entity_type, entity_id, alias, normalized_alias)
select 'variant', variant.id, alias.alias, alias.normalized_alias
from (values
  ('jbl-boombox-3', 'black', 'Boombox 3 Black', 'boombox 3 black'),
  ('tudor-black-bay-58', 'black-dial-steel', 'Black Bay Fifty-Eight Black', 'black bay fifty eight black')
) as alias(product_slug, variant_slug, alias, normalized_alias)
join public.catalog_products product on product.slug = alias.product_slug
join public.catalog_product_variants variant
  on variant.product_id = product.id and variant.slug = alias.variant_slug
on conflict (entity_type, normalized_alias) do nothing;