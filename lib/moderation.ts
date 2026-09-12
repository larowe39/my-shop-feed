import { supabase } from "./supabase";

export type ModerationStatus = "pending" | "approved" | "blurred" | "hidden" | "failed";

export type ProductModeration = {
  id?: string;
  product_id: string;
  status: ModerationStatus;
  risk_level?: "low" | "medium" | "high" | null;
  provider?: string | null;
  labels?: Record<string, unknown>;
  is_blurred: boolean;
  is_hidden: boolean;
  review_reason?: string | null;
  moderated_at?: string | null;
};

export async function createPendingModeration(productId: string) {
  const { error } = await supabase.from("product_moderation").upsert(
    { product_id: productId, status: "pending" },
    { onConflict: "product_id" }
  );
  if (error) throw error;
}

/** Fire-and-forget client boundary. Provider credentials stay in the Edge Function. */
export function moderateProductImage({ productId, imageUrl }: { productId: string; imageUrl: string }) {
  void supabase.functions
    .invoke("moderate-product-image", { body: { productId, imageUrl } })
    .catch((error) => {
      if (__DEV__) console.log("Moderation invocation failed", error);
    });
}
