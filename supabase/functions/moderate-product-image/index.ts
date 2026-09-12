import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ModerationRequest = { productId: string; imageUrl: string; devOutcome?: "approved" | "blurred" | "hidden" | "failed" };

// Provider adapter boundary: replace this deterministic placeholder with a paid
// provider call using an Edge Function secret when one is selected.
function classifyImage(_imageUrl: string, devOutcome?: ModerationRequest["devOutcome"]) {
  if (devOutcome) return { status: devOutcome, isBlurred: devOutcome === "blurred", isHidden: devOutcome === "hidden", reason: "Development test outcome" };
  return { status: "approved", isBlurred: false, isHidden: false, reason: null };
}

Deno.serve(async (request) => {
  try {
    const body = (await request.json()) as ModerationRequest;
    if (!body.productId || !body.imageUrl) return new Response("productId and imageUrl are required", { status: 400 });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const result = classifyImage(body.imageUrl, Deno.env.get("MODERATION_DEV_MODE") === "true" ? body.devOutcome : undefined);
    const { error } = await admin.from("product_moderation").update({
      status: result.status,
      is_blurred: result.isBlurred,
      is_hidden: result.isHidden,
      review_reason: result.reason,
      provider: "placeholder",
      moderated_at: new Date().toISOString(),
    }).eq("product_id", body.productId);
    if (error) throw error;
    return Response.json({ ok: true, status: result.status });
  } catch (error) {
    console.error(error);
    return new Response("Moderation failed", { status: 500 });
  }
});