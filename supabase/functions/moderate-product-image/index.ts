type ModerationRequest = {
  productId: string;
  imageUrl: string;
  devOutcome?: "approved" | "blurred" | "hidden" | "failed";
};

type ModerationResult = {
  status: "approved" | "blurred" | "hidden" | "failed";
  isBlurred: boolean;
  isHidden: boolean;
  reason: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function classifyImage(
  _imageUrl: string,
  devOutcome?: ModerationRequest["devOutcome"],
): ModerationResult {
  if (devOutcome) {
    return {
      status: devOutcome,
      isBlurred: devOutcome === "blurred",
      isHidden: devOutcome === "hidden",
      reason: "Development test outcome",
    };
  }

  return {
    status: "approved",
    isBlurred: false,
    isHidden: false,
    reason: null,
  };
}

Deno.serve(async (request) => {
  // Required for browser-based Supabase function calls.
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders,
    });
  }

  try {
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: "Method not allowed",
        }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const body = (await request.json()) as ModerationRequest;

    if (!body.productId || !body.imageUrl) {
      return new Response(
        JSON.stringify({
          error: "productId and imageUrl are required",
        }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Missing Supabase environment variables");

      return new Response(
        JSON.stringify({
          error: "Server configuration error",
        }),
        {
          status: 500,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const devModeEnabled =
      Deno.env.get("MODERATION_DEV_MODE") === "true";

    const result = classifyImage(
      body.imageUrl,
      devModeEnabled ? body.devOutcome : undefined,
    );

    const moderationUpdate = {
      status: result.status,
      is_blurred: result.isBlurred,
      is_hidden: result.isHidden,
      review_reason: result.reason,
      provider: "placeholder",
      moderated_at: new Date().toISOString(),
    };

    const updateUrl =
      `${supabaseUrl}/rest/v1/product_moderation?product_id=eq.${encodeURIComponent(
        body.productId,
      )}`;

    const updateResponse = await fetch(updateUrl, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify(moderationUpdate),
    });

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();

      console.error(
        "Failed to update product moderation:",
        updateResponse.status,
        errorText,
      );

      throw new Error(
        `Supabase moderation update failed: ${updateResponse.status}`,
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        status: result.status,
      }),
      {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Moderation function error:", error);

    return new Response(
      JSON.stringify({
        error: "Moderation failed",
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      },
    );
  }
});