// scripts/seed-social-demo.js
/**
 * PENCHANT Demo Social Network Seeder
 *
 * Creates ~10 realistic demo seller accounts (auth users + profiles),
 * distributes the existing seed-demo-products.js catalog among them so
 * each demo seller has 3-8 products, and seeds a small follow graph
 * between them. This lets you browse different sellers, follow/unfollow,
 * and test FOLLOWING/FOR YOU behavior without needing real users.
 *
 * REQUIRES the Supabase SERVICE ROLE key, which can create auth users and
 * bypass RLS. This key must NEVER be used in client code, must NEVER use
 * the EXPO_PUBLIC_ prefix, and must NEVER be committed to git.
 *
 * Setup:
 *   1. Get your service role key from Supabase Dashboard -> Project Settings -> API.
 *   2. Put it in a local, gitignored `.env.local` file (NOT `.env`, which is
 *      committed in this repo):
 *        SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
 *
 * Usage:
 *   npm run seed:social                 seed/update demo sellers, products, follows
 *   npm run seed:social -- --status     report counts of demo data
 *   npm run seed:social -- --clean      remove demo sellers/profiles/follows only
 *   npm run seed:social -- --follow-demo=you@example.com
 *                                        (optional) make an existing real account
 *                                        follow a few demo sellers. Default behavior
 *                                        never touches real accounts' follows.
 *
 * Safe to rerun: demo users are matched by their deterministic @penchant.local
 * email, so re-running never creates duplicate auth users, profiles, or follows.
 *
 * Avatars: stable placeholder portraits from https://i.pravatar.cc, which
 * generates a consistent image per unique `u` query value (not a random image
 * service, so the same seed always resolves to the same avatar).
 */

const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();
// Local-only overrides (gitignored) — this is where SUPABASE_SERVICE_ROLE_KEY lives.
require("dotenv").config({ path: ".env.local", override: true });

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  console.error("Missing EXPO_PUBLIC_SUPABASE_URL in .env");
  process.exit(1);
}

if (!serviceRoleKey) {
  console.error(
    "\nMissing SUPABASE_SERVICE_ROLE_KEY.\n" +
      "This script needs admin access to create demo auth users and must not\n" +
      "run with the anon key. Add it to a local, gitignored `.env.local` file:\n\n" +
      "  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here\n\n" +
      "Find it in Supabase Dashboard -> Project Settings -> API -> service_role.\n" +
      "Never commit this key or use an EXPO_PUBLIC_ prefix for it.\n"
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Deterministic dev-only password for every demo account. Not a real personal password.
const DEMO_PASSWORD = process.env.DEMO_SELLER_PASSWORD || "Penchant-Demo-2026!";
const DEMO_EMAIL_DOMAIN = "@penchant.local";

// Category -> exact product titles from scripts/seed-demo-products.js. Only
// products matching these exact titles are reassigned, so manually uploaded
// products are never touched.
const CATALOG_TITLES_BY_CATEGORY = {
  fashion: [
    "Ami de Cœur Heavyweight Cotton Hoodie",
    "1996 Straight-Leg Vintage Tint Denim",
    "Basic Pigment Dyed Longsleeve Tee",
    "Classic Beaufort Waxed Cotton Jacket",
  ],
  shoes: [
    "990v6 Made in USA Core Grey",
    "XT-6 Advanced Trail Runners",
    "Iron Ranger 8085 Amber Harness Boot",
    "Boston Soft Footbed Suede Clogs",
  ],
  watches: [
    "Black Bay 58 Automatic Diver 39mm",
    "Prospex Speedtimer Solar Chronograph",
    "Speedmaster Professional Moonwatch",
    "Khaki Field Mechanical 38mm",
  ],
  automotive: [
    "911 Chrono Precision Air Gauge & Tool Kit",
    "GT Gran Turismo 6-Piston Big Brake Kit",
    "Boost HD GB70 2000A UltraSafe Jump Starter",
    "Motion XT Rooftop Cargo Box",
  ],
  home: [
    "Eames Lounge Chair and Ottoman in Walnut",
    "Stagg EKG Electric Pour-Over Kettle",
    "Brass Oil Burner Aromatique Home Diffuser",
    "Purifier Hot+Cool Formaldehyde HP09",
  ],
  electronics: [
    "WH-1000XM5 Wireless Noise Cancelling Headphones",
    "AirPods Max Space Gray",
    "Q1 Pro Wireless Custom Mechanical Keyboard",
    "X100VI Digital Rangefinder Camera",
  ],
  outdoors: [
    "Black Hole Duffel Bag 55L",
    "Alpha SV Alpine Gore-Tex Pro Jacket",
    "Titanium Trek 900 Ultra-Light Cookset",
    "Tundra 45 Hard Cooler Desert Tan",
  ],
  beauty: [
    "Santal 33 Eau de Parfum 100ml",
    "Resurrection Aromatique Hand Balm",
    "Gypsy Water Eau de Parfum",
    "Protini Polypeptide Firming Moisturizer",
  ],
  fitness: [
    "Pace Breaker 7 Inch Linerless Short",
    "Cloudmonster Hyper Maximalist Runners",
    "PRO Plus Percussive Therapy Device",
    "Cast Iron Kettlebell 24kg",
  ],
  accessories: [
    "Tanker 2-Way Boston Travel Bag",
    "Dealan Titanium & Acetate Sunglasses",
    "Hide & Seek Premium Leather Wallet",
    "Rugged Twill Rugged Briefcase",
  ],
};

// 10 demo sellers, one per specialization. `key` drives the deterministic
// email (demo.<key>@penchant.local) and avatar seed.
const DEMO_SELLERS = [
  {
    key: "maya",
    displayName: "Maya Chen",
    category: "fashion",
    bio: "Curating minimalist streetwear and quiet-luxury staples.",
  },
  {
    key: "miles",
    displayName: "Miles Carter",
    category: "shoes",
    bio: "Sneakerhead and boot collector sharing footwear worth owning.",
  },
  {
    key: "theo",
    displayName: "Theo Laurent",
    category: "watches",
    bio: "Horology enthusiast spotlighting timepieces old and new.",
  },
  {
    key: "elias",
    displayName: "Elias Stone",
    category: "automotive",
    bio: "Garage-built gearhead sourcing tools and parts worth trusting.",
  },
  {
    key: "nora",
    displayName: "Nora Hayes",
    category: "home",
    bio: "Interior stylist obsessed with warm, considered living spaces.",
  },
  {
    key: "jonah",
    displayName: "Jonah Reed",
    category: "electronics",
    bio: "Gadget reviewer chasing the best-designed tech, not just the newest.",
  },
  {
    key: "avery",
    displayName: "Avery Brooks",
    category: "outdoors",
    bio: "Trail-tested outdoor gear for weekend trips and long expeditions.",
  },
  {
    key: "camille",
    displayName: "Camille Hart",
    category: "beauty",
    bio: "Fragrance and skincare finds worth the shelf space.",
  },
  {
    key: "sofia",
    displayName: "Sofia Bennett",
    category: "fitness",
    bio: "Training gear and recovery tools for people who take movement seriously.",
  },
  {
    key: "luca",
    displayName: "Luca Moretti",
    category: "accessories",
    bio: "Leather goods and everyday carry, built to last decades.",
  },
];

// Small, intentionally asymmetric follow graph (1-3 follows each, no self-follows).
const DEMO_FOLLOW_EDGES = [
  ["maya", "miles"],
  ["maya", "sofia"],
  ["miles", "maya"],
  ["sofia", "maya"],
  ["sofia", "theo"],
  ["theo", "elias"],
  ["nora", "camille"],
  ["nora", "luca"],
  ["luca", "nora"],
  ["avery", "elias"],
  ["avery", "jonah"],
  ["jonah", "avery"],
  ["camille", "nora"],
  ["elias", "theo"],
  ["elias", "avery"],
];

function emailFor(key) {
  return `demo.${key}${DEMO_EMAIL_DOMAIN}`;
}

function avatarFor(key) {
  // Stable per-seed portrait, not a randomly-changing image.
  return `https://i.pravatar.cc/300?u=${encodeURIComponent(emailFor(key))}`;
}

function isDemoEmail(email) {
  return typeof email === "string" && email.toLowerCase().endsWith(DEMO_EMAIL_DOMAIN);
}

async function listAllUsers() {
  const users = [];
  let page = 1;
  const perPage = 200;
  // supabase-js admin.listUsers is paginated; loop until a short page ends it.
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < perPage) break;
    page += 1;
  }
  return users;
}

async function findExistingDemoUsers() {
  const allUsers = await listAllUsers();
  const byEmail = new Map();
  for (const u of allUsers) {
    if (isDemoEmail(u.email)) {
      byEmail.set(u.email.toLowerCase(), u);
    }
  }
  return byEmail;
}

async function ensureDemoUser(seller, existingByEmail) {
  const email = emailFor(seller.key);
  const existing = existingByEmail.get(email.toLowerCase());
  if (existing) {
    return existing.id;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: DEMO_PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: seller.displayName, is_demo_seller: true },
  });

  if (error) throw error;
  console.log(`Created demo auth user: ${seller.displayName} (${email})`);
  return data.user.id;
}

async function upsertDemoProfile(userId, seller) {
  const { error } = await supabase.from("user_profiles").upsert(
    {
      user_id: userId,
      display_name: seller.displayName,
      avatar_url: avatarFor(seller.key),
      bio: seller.bio,
    },
    { onConflict: "user_id" }
  );
  if (error) throw error;
}

async function reassignCatalogProducts(userId, seller) {
  const titles = CATALOG_TITLES_BY_CATEGORY[seller.category] || [];
  if (titles.length === 0) return 0;

  const { data: matching, error: fetchErr } = await supabase
    .from("products")
    .select("id, user_id")
    .eq("category", seller.category)
    .in("title", titles);

  if (fetchErr) throw fetchErr;

  const toReassign = (matching || []).filter((p) => p.user_id !== userId);
  if (toReassign.length === 0) return (matching || []).length;

  const { error: updateErr } = await supabase
    .from("products")
    .update({ user_id: userId })
    .in(
      "id",
      toReassign.map((p) => p.id)
    );

  if (updateErr) throw updateErr;
  return (matching || []).length;
}

async function seedFollows(idsByKey) {
  const rows = DEMO_FOLLOW_EDGES.filter(
    ([followerKey, followingKey]) => followerKey !== followingKey
  )
    .map(([followerKey, followingKey]) => ({
      follower_id: idsByKey.get(followerKey),
      following_id: idsByKey.get(followingKey),
    }))
    .filter((row) => row.follower_id && row.following_id);

  if (rows.length === 0) return 0;

  const { error } = await supabase
    .from("user_follows")
    .upsert(rows, { onConflict: "follower_id,following_id", ignoreDuplicates: true });

  if (error) throw error;
  return rows.length;
}

async function followDemoSellersFromRealAccount(email, idsByKey) {
  const allUsers = await listAllUsers();
  const realUser = allUsers.find(
    (u) => (u.email || "").toLowerCase() === email.toLowerCase()
  );

  if (!realUser) {
    console.warn(`--follow-demo: no auth user found with email ${email}. Skipping.`);
    return;
  }

  // A handful of diverse sellers, not the entire roster.
  const targets = ["maya", "theo", "jonah"]
    .map((key) => idsByKey.get(key))
    .filter((id) => id && id !== realUser.id);

  const rows = targets.map((followingId) => ({
    follower_id: realUser.id,
    following_id: followingId,
  }));

  if (rows.length === 0) return;

  const { error } = await supabase
    .from("user_follows")
    .upsert(rows, { onConflict: "follower_id,following_id", ignoreDuplicates: true });

  if (error) throw error;
  console.log(`${email} now follows ${rows.length} demo seller(s).`);
}

async function printStatus() {
  const existingByEmail = await findExistingDemoUsers();
  const demoIds = Array.from(existingByEmail.values()).map((u) => u.id);

  console.log(`Demo users: ${demoIds.length}`);

  if (demoIds.length === 0) {
    console.log("Demo profiles: 0");
    console.log("Demo products: 0");
    console.log("Demo follows: 0");
    return;
  }

  const [{ data: profiles }, { data: products }, { data: follows }] = await Promise.all([
    supabase.from("user_profiles").select("user_id, display_name").in("user_id", demoIds),
    supabase.from("products").select("id, user_id, category").in("user_id", demoIds),
    supabase
      .from("user_follows")
      .select("follower_id, following_id")
      .in("follower_id", demoIds),
  ]);

  console.log(`Demo profiles: ${profiles?.length ?? 0}`);
  console.log(`Demo products: ${products?.length ?? 0}`);
  console.log(`Demo follows: ${follows?.length ?? 0}`);

  console.log("\nSellers:");
  for (const seller of DEMO_SELLERS) {
    const email = emailFor(seller.key);
    const authUser = existingByEmail.get(email.toLowerCase());
    if (!authUser) {
      console.log(`  - ${seller.displayName}: not created yet`);
      continue;
    }
    const count = (products || []).filter((p) => p.user_id === authUser.id).length;
    console.log(`  - ${seller.displayName} (${seller.category}): ${count} product(s)`);
  }
}

async function cleanDemoData() {
  const existingByEmail = await findExistingDemoUsers();
  const demoIds = Array.from(existingByEmail.values()).map((u) => u.id);

  if (demoIds.length === 0) {
    console.log("No demo users found. Nothing to clean.");
    return;
  }

  console.log(`Cleaning ${demoIds.length} demo seller account(s)...`);

  // Revert catalog products back to unowned rather than deleting them — they
  // belong to scripts/seed-demo-products.js, not this script.
  const allCatalogTitles = Object.values(CATALOG_TITLES_BY_CATEGORY).flat();
  const { error: revertErr } = await supabase
    .from("products")
    .update({ user_id: null })
    .in("user_id", demoIds)
    .in("title", allCatalogTitles);
  if (revertErr) throw revertErr;

  const { error: followsErr } = await supabase
    .from("user_follows")
    .delete()
    .or(
      `follower_id.in.(${demoIds.join(",")}),following_id.in.(${demoIds.join(",")})`
    );
  if (followsErr) throw followsErr;

  const { error: profilesErr } = await supabase
    .from("user_profiles")
    .delete()
    .in("user_id", demoIds);
  if (profilesErr) throw profilesErr;

  for (const id of demoIds) {
    const { error } = await supabase.auth.admin.deleteUser(id);
    if (error) throw error;
  }

  console.log(`Removed ${demoIds.length} demo seller account(s) and related data.`);
}

async function run() {
  const args = process.argv.slice(2);
  const isStatus = args.includes("--status");
  const isClean = args.includes("--clean");
  const followDemoArg = args.find((a) => a.startsWith("--follow-demo="));

  console.log("=== PENCHANT DEMO SOCIAL SEED UTILITY ===");

  if (isStatus) {
    await printStatus();
    return;
  }

  if (isClean) {
    await cleanDemoData();
    return;
  }

  const existingByEmail = await findExistingDemoUsers();
  const idsByKey = new Map();

  for (const seller of DEMO_SELLERS) {
    const userId = await ensureDemoUser(seller, existingByEmail);
    idsByKey.set(seller.key, userId);
    await upsertDemoProfile(userId, seller);
    const total = await reassignCatalogProducts(userId, seller);
    console.log(`${seller.displayName} (${seller.category}): ${total} product(s)`);
  }

  const followCount = await seedFollows(idsByKey);
  console.log(`Seeded ${followCount} demo follow relationship(s).`);

  if (followDemoArg) {
    const email = followDemoArg.split("=")[1];
    if (email) {
      await followDemoSellersFromRealAccount(email, idsByKey);
    }
  }

  console.log("\nDone. Run with --status to see a summary.");
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
