// lib/supabase.ts
import "react-native-url-polyfill/auto";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const PRODUCT_BUCKET = "product-images";

// Accepts either a full https URL OR a storage path like "userId/file.jpg"
export function getProductImageUrl(imageUrl: string | null | undefined) {
  if (!imageUrl) return null;

  // already a full remote URL (Unsplash / CDN / etc.)
  if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
    return imageUrl;
  }

  // otherwise treat as Supabase Storage path
  const { data } = supabase.storage.from(PRODUCT_BUCKET).getPublicUrl(imageUrl);
  return data.publicUrl ?? null;
}
