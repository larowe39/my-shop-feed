// scripts/seed-demo-products.js
/**
 * PENCHANT Realistic Demo Product Catalog Seeder
 *
 * Populates the Supabase database with realistic demo products across 10 categories
 * associated with the authenticated user ID.
 *
 * Usage:
 *   node scripts/seed-demo-products.js
 *   node scripts/seed-demo-products.js --clean (removes seeded demo products)
 *   node scripts/seed-demo-products.js --status (checks counts of demo vs total products)
 */

const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY in .env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Marker used in deterministic identifiers to keep seeding idempotent and safe to remove
const DEMO_SEED_KEY = "PENCHANT_DEMO_v1";

const DEMO_CATALOG = [
  // --- 1. FASHION ---
  {
    title: "Ami de Cœur Heavyweight Cotton Hoodie",
    brand: "Ami Paris",
    category: "fashion",
    price: "380",
    url: "https://www.amiparis.com",
    image_url: "https://images.unsplash.com/photo-1556905055-8f358a7a47b2?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_fashion_1`,
  },
  {
    title: "1996 Straight-Leg Vintage Tint Denim",
    brand: "Acne Studios",
    category: "fashion",
    price: "340",
    url: "https://www.acnestudios.com",
    image_url: "https://images.unsplash.com/photo-1541099649105-f69ad21f3246?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_fashion_2`,
  },
  {
    title: "Basic Pigment Dyed Longsleeve Tee",
    brand: "Stüssy",
    category: "fashion",
    price: "55",
    url: "https://www.stussy.com",
    image_url: "https://images.unsplash.com/photo-1521572267360-ee0c2909d518?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_fashion_3`,
  },
  {
    title: "Classic Beaufort Waxed Cotton Jacket",
    brand: "Barbour",
    category: "fashion",
    price: "425",
    url: "https://www.barbour.com",
    image_url: "https://images.unsplash.com/photo-1544441893-675973e31985?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_fashion_4`,
  },

  // --- 2. SHOES ---
  {
    title: "990v6 Made in USA Core Grey",
    brand: "New Balance",
    category: "shoes",
    price: "200",
    url: "https://www.newbalance.com",
    image_url: "https://images.unsplash.com/photo-1539185441755-769473a23570?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_shoes_1`,
  },
  {
    title: "XT-6 Advanced Trail Runners",
    brand: "Salomon",
    category: "shoes",
    price: "220",
    url: "https://www.salomon.com",
    image_url: "https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_shoes_2`,
  },
  {
    title: "Iron Ranger 8085 Amber Harness Boot",
    brand: "Red Wing",
    category: "shoes",
    price: "350",
    url: "https://www.redwingshoes.com",
    image_url: "https://images.unsplash.com/photo-1520639888713-7851133b1ed0?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_shoes_3`,
  },
  {
    title: "Boston Soft Footbed Suede Clogs",
    brand: "Birkenstock",
    category: "shoes",
    price: "160",
    url: "https://www.birkenstock.com",
    image_url: "https://images.unsplash.com/photo-1560769629-975ec94e6a86?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_shoes_4`,
  },

  // --- 3. WATCHES ---
  {
    title: "Black Bay 58 Automatic Diver 39mm",
    brand: "Tudor",
    category: "watches",
    price: "3950",
    url: "https://www.tudorwatch.com",
    image_url: "https://images.unsplash.com/photo-1522335789203-aabd1fc54bc9?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_watches_1`,
  },
  {
    title: "Prospex Speedtimer Solar Chronograph",
    brand: "Seiko",
    category: "watches",
    price: "675",
    url: "https://www.seikowatches.com",
    image_url: "https://images.unsplash.com/photo-1524805444758-089113d48a6d?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_watches_2`,
  },
  {
    title: "Speedmaster Professional Moonwatch",
    brand: "Omega",
    category: "watches",
    price: "7000",
    url: "https://www.omegawatches.com",
    image_url: "https://images.unsplash.com/photo-1547996160-71dfabb1a7cf?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_watches_3`,
  },
  {
    title: "Khaki Field Mechanical 38mm",
    brand: "Hamilton",
    category: "watches",
    price: "575",
    url: "https://www.hamiltonwatch.com",
    image_url: "https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_watches_4`,
  },

  // --- 4. AUTOMOTIVE ---
  {
    title: "911 Chrono Precision Air Gauge & Tool Kit",
    brand: "Porsche Design",
    category: "automotive",
    price: "295",
    url: "https://www.porsche-design.com",
    image_url: "https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_auto_1`,
  },
  {
    title: "GT Gran Turismo 6-Piston Big Brake Kit",
    brand: "Brembo",
    category: "automotive",
    price: "3450",
    url: "https://www.brembo.com",
    image_url: "https://images.unsplash.com/photo-1486006920555-c77dce18193b?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_auto_2`,
  },
  {
    title: "Boost HD GB70 2000A UltraSafe Jump Starter",
    brand: "NOCO",
    category: "automotive",
    price: "199",
    url: "https://no.co",
    image_url: "https://images.unsplash.com/photo-1580273916550-e323be2ae537?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_auto_3`,
  },
  {
    title: "Motion XT Rooftop Cargo Box",
    brand: "Thule",
    category: "automotive",
    price: "899",
    url: "https://www.thule.com",
    image_url: "https://images.unsplash.com/photo-1541899481282-d53bffe3c35d?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_auto_4`,
  },

  // --- 5. HOME ---
  {
    title: "Eames Lounge Chair and Ottoman in Walnut",
    brand: "Herman Miller",
    category: "home",
    price: "5495",
    url: "https://www.hermanmiller.com",
    image_url: "https://images.unsplash.com/photo-1567538096630-e0c55bd6374c?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_home_1`,
  },
  {
    title: "Stagg EKG Electric Pour-Over Kettle",
    brand: "Fellow",
    category: "home",
    price: "165",
    url: "https://fellowproducts.com",
    image_url: "https://images.unsplash.com/photo-1517256064527-09c73fc73e38?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_home_2`,
  },
  {
    title: "Brass Oil Burner Aromatique Home Diffuser",
    brand: "Aesop",
    category: "home",
    price: "210",
    url: "https://www.aesop.com",
    image_url: "https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_home_3`,
  },
  {
    title: "Purifier Hot+Cool Formaldehyde HP09",
    brand: "Dyson",
    category: "home",
    price: "749",
    url: "https://www.dyson.com",
    image_url: "https://images.unsplash.com/photo-1585771724684-38269d6639fd?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_home_4`,
  },

  // --- 6. ELECTRONICS ---
  {
    title: "WH-1000XM5 Wireless Noise Cancelling Headphones",
    brand: "Sony",
    category: "electronics",
    price: "399",
    url: "https://www.sony.com",
    image_url: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_elec_1`,
  },
  {
    title: "AirPods Max Space Gray",
    brand: "Apple",
    category: "electronics",
    price: "549",
    url: "https://www.apple.com",
    image_url: "https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_elec_2`,
  },
  {
    title: "Q1 Pro Wireless Custom Mechanical Keyboard",
    brand: "Keychron",
    category: "electronics",
    price: "199",
    url: "https://www.keychron.com",
    image_url: "https://images.unsplash.com/photo-1587829741301-dc798b83add3?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_elec_3`,
  },
  {
    title: "X100VI Digital Rangefinder Camera",
    brand: "Fujifilm",
    category: "electronics",
    price: "1599",
    url: "https://www.fujifilm.com",
    image_url: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_elec_4`,
  },

  // --- 7. OUTDOORS ---
  {
    title: "Black Hole Duffel Bag 55L",
    brand: "Patagonia",
    category: "outdoors",
    price: "169",
    url: "https://www.patagonia.com",
    image_url: "https://images.unsplash.com/photo-1501555088652-021faa106b9b?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_out_1`,
  },
  {
    title: "Alpha SV Alpine Gore-Tex Pro Jacket",
    brand: "Arc'teryx",
    category: "outdoors",
    price: "900",
    url: "https://arcteryx.com",
    image_url: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_out_2`,
  },
  {
    title: "Titanium Trek 900 Ultra-Light Cookset",
    brand: "Snow Peak",
    category: "outdoors",
    price: "65",
    url: "https://www.snowpeak.com",
    image_url: "https://images.unsplash.com/photo-1510312305653-8ed496efae75?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_out_3`,
  },
  {
    title: "Tundra 45 Hard Cooler Desert Tan",
    brand: "Yeti",
    category: "outdoors",
    price: "325",
    url: "https://www.yeti.com",
    image_url: "https://images.unsplash.com/photo-1517824806704-9040b037703b?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_out_4`,
  },

  // --- 8. BEAUTY ---
  {
    title: "Santal 33 Eau de Parfum 100ml",
    brand: "Le Labo",
    category: "beauty",
    price: "320",
    url: "https://www.lelabofragrances.com",
    image_url: "https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_beauty_1`,
  },
  {
    title: "Resurrection Aromatique Hand Balm",
    brand: "Aesop",
    category: "beauty",
    price: "35",
    url: "https://www.aesop.com",
    image_url: "https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_beauty_2`,
  },
  {
    title: "Gypsy Water Eau de Parfum",
    brand: "Byredo",
    category: "beauty",
    price: "290",
    url: "https://www.byredo.com",
    image_url: "https://images.unsplash.com/photo-1616949755610-8c9bbc08f138?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_beauty_3`,
  },
  {
    title: "Protini Polypeptide Firming Moisturizer",
    brand: "Drunk Elephant",
    category: "beauty",
    price: "68",
    url: "https://www.drunkelephant.com",
    image_url: "https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_beauty_4`,
  },

  // --- 9. FITNESS ---
  {
    title: "Pace Breaker 7 Inch Linerless Short",
    brand: "Lululemon",
    category: "fitness",
    price: "68",
    url: "https://shop.lululemon.com",
    image_url: "https://images.unsplash.com/photo-1517838277536-f5f99be501cd?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_fit_1`,
  },
  {
    title: "Cloudmonster Hyper Maximalist Runners",
    brand: "On Running",
    category: "fitness",
    price: "220",
    url: "https://www.on.com",
    image_url: "https://images.unsplash.com/photo-1584735935682-2f2b69dff9d2?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_fit_2`,
  },
  {
    title: "PRO Plus Percussive Therapy Device",
    brand: "Theragun",
    category: "fitness",
    price: "599",
    url: "https://www.therabody.com",
    image_url: "https://images.unsplash.com/photo-1574680096145-d05b474e2155?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_fit_3`,
  },
  {
    title: "Cast Iron Kettlebell 24kg",
    brand: "Rogue Fitness",
    category: "fitness",
    price: "85",
    url: "https://www.roguefitness.com",
    image_url: "https://images.unsplash.com/photo-1583454110551-21f2fa2afe61?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_fit_4`,
  },

  // --- 10. ACCESSORIES ---
  {
    title: "Tanker 2-Way Boston Travel Bag",
    brand: "Porter-Yoshida",
    category: "accessories",
    price: "410",
    url: "https://www.yoshidakaban.com",
    image_url: "https://images.unsplash.com/photo-1548036328-c9fa89d128fa?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_acc_1`,
  },
  {
    title: "Dealan Titanium & Acetate Sunglasses",
    brand: "Jacques Marie Mage",
    category: "accessories",
    price: "790",
    url: "https://jacquesmariemage.com",
    image_url: "https://images.unsplash.com/photo-1511499767150-a48a237f0083?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_acc_2`,
  },
  {
    title: "Hide & Seek Premium Leather Wallet",
    brand: "Bellroy",
    category: "accessories",
    price: "89",
    url: "https://bellroy.com",
    image_url: "https://images.unsplash.com/photo-1627123424574-724758594e93?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_acc_3`,
  },
  {
    title: "Rugged Twill Rugged Briefcase",
    brand: "Filson",
    category: "accessories",
    price: "495",
    url: "https://www.filson.com",
    image_url: "https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=1000&q=80",
    seed_tag: `${DEMO_SEED_KEY}_acc_4`,
  },
];

async function resolveTargetUserId() {
  if (process.env.SEED_USER_ID) {
    return process.env.SEED_USER_ID.trim();
  }

  // 1. Check existing user_profiles
  try {
    const { data: profiles, error: profileErr } = await supabase
      .from("user_profiles")
      .select("user_id, display_name")
      .limit(5);

    if (!profileErr && profiles && profiles.length > 0) {
      console.log(`Resolved target user from user_profiles: ${profiles[0].display_name} (${profiles[0].user_id})`);
      return profiles[0].user_id;
    }
  } catch (err) {
    console.warn("user_profiles query error, falling back:", err?.message);
  }

  // 2. Check existing products with a user_id
  try {
    const { data: prods, error: prodErr } = await supabase
      .from("products")
      .select("user_id")
      .not("user_id", "is", null)
      .limit(1);

    if (!prodErr && prods && prods.length > 0 && prods[0].user_id) {
      console.log(`Resolved target user from existing products: ${prods[0].user_id}`);
      return prods[0].user_id;
    }
  } catch (err) {
    console.warn("products fallback query error:", err?.message);
  }

  throw new Error(
    "Could not automatically resolve target authenticated user_id. Please provide SEED_USER_ID=<uuid> in environment."
  );
}

async function run() {
  const args = process.argv.slice(2);
  const isClean = args.includes("--clean");
  const isStatus = args.includes("--status");

  console.log("=== PENCHANT DEMO SEED UTILITY ===");

  const userId = await resolveTargetUserId();
  console.log(`Target User ID: ${userId}`);

  // Fetch current products from DB
  const { data: existingProducts, error: fetchErr } = await supabase
    .from("products")
    .select("id, title, brand, category, user_id");

  if (fetchErr) {
    console.error("Error fetching existing products:", fetchErr);
    process.exit(1);
  }

  const existingTitles = new Set((existingProducts || []).map((p) => (p.title || "").trim().toLowerCase()));
  const demoTitles = new Set(DEMO_CATALOG.map((p) => p.title.trim().toLowerCase()));

  const currentDemoProducts = (existingProducts || []).filter((p) =>
    demoTitles.has((p.title || "").trim().toLowerCase())
  );

  console.log(`Total products in database: ${existingProducts?.length ?? 0}`);
  console.log(`Current demo products in database: ${currentDemoProducts.length}`);

  if (isStatus) {
    console.log("\nCategories breakdown:");
    const catCounts = {};
    for (const p of existingProducts || []) {
      const cat = p.category || "uncategorized";
      catCounts[cat] = (catCounts[cat] || 0) + 1;
    }
    console.table(catCounts);
    return;
  }

  if (isClean) {
    console.log(`\nCleaning ${currentDemoProducts.length} demo products...`);
    if (currentDemoProducts.length === 0) {
      console.log("No demo products found to clean.");
      return;
    }

    const idsToDelete = currentDemoProducts.map((p) => p.id);
    const { error: delErr } = await supabase
      .from("products")
      .delete()
      .in("id", idsToDelete);

    if (delErr) {
      console.error("Error cleaning demo products:", delErr);
      process.exit(1);
    }

    console.log(`Successfully removed ${idsToDelete.length} demo products.`);
    return;
  }

  // Insert missing demo products (Idempotent: skips if title already exists)
  const toInsert = DEMO_CATALOG.filter(
    (item) => !existingTitles.has(item.title.trim().toLowerCase())
  ).map((item) => ({
    title: item.title,
    brand: item.brand,
    category: item.category,
    price: item.price,
    url: item.url,
    image_url: item.image_url,
    user_id: userId,
  }));

  if (toInsert.length === 0) {
    console.log("All demo products are already seeded. Database is up to date.");
    return;
  }

  console.log(`\nSeeding ${toInsert.length} new demo products under user ${userId}...`);

  const { data: inserted, error: insertErr } = await supabase
    .from("products")
    .insert(toInsert)
    .select();

  if (insertErr) {
    console.error("Error inserting demo products:", insertErr);
    process.exit(1);
  }

  console.log(`Successfully seeded ${inserted ? inserted.length : toInsert.length} demo products!`);

  // Final summary
  const { data: allProds } = await supabase.from("products").select("category, brand");
  console.log(`\nNew total product count: ${allProds?.length ?? 0}`);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
