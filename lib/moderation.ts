import { supabase } from "./supabase";

export type ModerationStatus =
  | "pending"
  | "approved"
  | "blurred"
  | "hidden"
  | "failed";

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
  const { error } = await supabase
    .from("product_moderation")
    .upsert(
      {
        product_id: productId,
        status: "pending",
        is_blurred: false,
        is_hidden: false,
      },
      {
        onConflict: "product_id",
      },
    );

  if (error) {
    console.error("Failed to create pending moderation row:", error);
    throw error;
  }

  if (__DEV__) {
    console.log("Created pending moderation row for:", productId);
  }
}

/**
 * Calls the server-side moderation Edge Function.
 * Moderation failure must never prevent a product from publishing.
 */
export async function moderateProductImage({
  productId,
  imageUrl,
}: {
  productId: string;
  imageUrl: string;
}) {
  try {
    if (__DEV__) {
      console.log("Invoking moderation function:", {
        productId,
        imageUrl,
      });
    }

    const { data, error } = await supabase.functions.invoke(
      "moderate-product-image",
      {
        body: {
          productId,
          imageUrl,
        },
      },
    );

    if (error) {
      console.error("Moderation Edge Function returned an error:", error);

      const context = (error as any)?.context;

      if (context) {
        console.error("Moderation error context:", context);

        try {
          if (typeof context.text === "function") {
            console.error(
              "Moderation response body:",
              await context.text(),
            );
          }
        } catch (responseError) {
          console.error(
            "Could not read moderation error response:",
            responseError,
          );
        }
      }

      return {
        ok: false,
        error,
      };
    }

    if (__DEV__) {
      console.log("Moderation Edge Function succeeded:", data);
    }

    return {
      ok: true,
      data,
    };
  } catch (error) {
    console.error("Unexpected moderation invocation failure:", error);

    return {
      ok: false,
      error,
    };
  }
}