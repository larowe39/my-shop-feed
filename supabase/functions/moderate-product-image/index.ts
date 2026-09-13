type ModerationRequest = {
  productId: string;
  imageUrl: string;
  devOutcome?: "approved" | "blurred" | "hidden" | "failed";
};

type ModerationStatus = "approved" | "blurred" | "hidden" | "failed";
type RiskLevel = "low" | "medium" | "high" | null;

interface NormalizedScores {
  sexual_activity: number;
  sexual_display: number;
  erotica: number;
  suggestive: number;
  violence: number;
  gore: number;
  weapon: number;
  self_harm: number;
  offensive: number;
  latency_ms?: number;
}

interface ModerationEvaluation {
  status: ModerationStatus;
  riskLevel: RiskLevel;
  provider: string;
  isBlurred: boolean;
  isHidden: boolean;
  reason: string | null;
  labels: Record<string, unknown>;
}

interface SightengineResponse {
  status?: string;
  error?: {
    message?: string;
    code?: number;
    type?: string;
  };
  nudity?: {
    sexual_activity?: number;
    sexual_display?: number;
    erotica?: number;
    very_suggestive?: number;
    suggestive?: number;
    mildly_suggestive?: number;
    none?: number;
    raw?: number;
    safe?: number;
  };
  weapon?:
    | number
    | {
        prob?: number;
        classes?: Record<string, number>;
      };
  violence?:
    | number
    | {
        prob?: number;
        classes?: Record<string, number>;
      };
  gore?:
    | number
    | {
        prob?: number;
        classes?: Record<string, number>;
      };
  "self-harm"?:
    | number
    | {
        prob?: number;
      };
  self_harm?:
    | number
    | {
        prob?: number;
      };
  offensive?:
    | number
    | {
        prob?: number;
        nazi?: number;
        confederate?: number;
        supremacist?: number;
        terrorist?: number;
        middle_finger?: number;
        classes?: Record<string, number>;
      };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/**
 * Initial PENCHANT moderation policy thresholds.
 * Tuned conservatively to avoid false positives on legitimate retail and lifestyle products.
 * These are initial thresholds to be calibrated with production analytics.
 */
const POLICY_THRESHOLDS = {
  // Severe content - triggers automatic HIDDEN status (high confidence)
  HIDE_SEXUAL_ACTIVITY: 0.8,
  HIDE_SEXUAL_DISPLAY: 0.85,
  HIDE_GORE: 0.85,
  HIDE_VIOLENCE: 0.85,
  HIDE_OFFENSIVE_HATE: 0.85,
  HIDE_SELF_HARM: 0.8,
  // High-confidence weapon occurring alongside violent context
  HIDE_WEAPON_WITH_VIOLENCE: 0.7,

  // Borderline / sensitive content - triggers BLURRED status with sensitive content warning
  BLUR_SUGGESTIVE: 0.6,
  BLUR_EROTICA: 0.5,
  BLUR_SEXUAL_DISPLAY: 0.4,
  BLUR_SEXUAL_ACTIVITY: 0.3,
  BLUR_GORE: 0.5,
  BLUR_VIOLENCE: 0.5,
  BLUR_OFFENSIVE_HATE: 0.5,
  BLUR_SELF_HARM: 0.4,
  // Normal weapon detection flags/blurs rather than hides (supports legitimate tools/sporting gear)
  BLUR_WEAPON: 0.65,
} as const;

/**
 * Helper to safely extract probability scores from Sightengine object or numeric values.
 */
function extractScore(val: unknown): number {
  if (typeof val === "number") {
    return Number.isFinite(val) ? Math.max(0, Math.min(1, val)) : 0;
  }
  if (val && typeof val === "object") {
    const obj = val as Record<string, unknown>;
    if (typeof obj.prob === "number") {
      return Number.isFinite(obj.prob) ? Math.max(0, Math.min(1, obj.prob)) : 0;
    }
    if (obj.classes && typeof obj.classes === "object") {
      const vals = Object.values(obj.classes).filter(
        (v): v is number => typeof v === "number",
      );
      if (vals.length > 0) {
        return Math.max(0, Math.min(1, Math.max(...vals)));
      }
    }
  }
  return 0;
}

/**
 * Normalizes Sightengine response into standardized PENCHANT score dictionary.
 */
function normalizeScores(
  data: SightengineResponse,
  latencyMs: number,
): NormalizedScores {
  const nudity = data.nudity || {};
  const sexualActivity =
    typeof nudity.sexual_activity === "number" ? nudity.sexual_activity : 0;
  const sexualDisplay =
    typeof nudity.sexual_display === "number" ? nudity.sexual_display : 0;
  const erotica = typeof nudity.erotica === "number" ? nudity.erotica : 0;

  const suggestive = Math.max(
    typeof nudity.suggestive === "number" ? nudity.suggestive : 0,
    typeof nudity.very_suggestive === "number" ? nudity.very_suggestive : 0,
    typeof nudity.mildly_suggestive === "number"
      ? nudity.mildly_suggestive * 0.5
      : 0,
  );

  const weapon = extractScore(data.weapon);
  const violence = extractScore(data.violence);
  const gore = extractScore(data.gore);
  const selfHarm = extractScore(data["self-harm"] ?? data.self_harm);
  const offensive = extractScore(data.offensive);

  return {
    sexual_activity: Number(sexualActivity.toFixed(4)),
    sexual_display: Number(sexualDisplay.toFixed(4)),
    erotica: Number(erotica.toFixed(4)),
    suggestive: Number(suggestive.toFixed(4)),
    violence: Number(violence.toFixed(4)),
    gore: Number(gore.toFixed(4)),
    weapon: Number(weapon.toFixed(4)),
    self_harm: Number(selfHarm.toFixed(4)),
    offensive: Number(offensive.toFixed(4)),
    latency_ms: latencyMs,
  };
}

/**
 * Centralized PENCHANT Moderation Policy Evaluation.
 * Evaluates normalized AI scores against PENCHANT safety thresholds.
 */
function evaluateModerationPolicy(
  scores: NormalizedScores,
): ModerationEvaluation {
  // 1. Check HIGH-CONFIDENCE severe violations -> HIDDEN
  if (scores.sexual_activity >= POLICY_THRESHOLDS.HIDE_SEXUAL_ACTIVITY) {
    return {
      status: "hidden",
      riskLevel: "high",
      provider: "sightengine",
      isBlurred: false,
      isHidden: true,
      reason: "Explicit sexual activity detected",
      labels: scores,
    };
  }

  if (scores.sexual_display >= POLICY_THRESHOLDS.HIDE_SEXUAL_DISPLAY) {
    return {
      status: "hidden",
      riskLevel: "high",
      provider: "sightengine",
      isBlurred: false,
      isHidden: true,
      reason: "Explicit sexual display detected",
      labels: scores,
    };
  }

  if (scores.gore >= POLICY_THRESHOLDS.HIDE_GORE) {
    return {
      status: "hidden",
      riskLevel: "high",
      provider: "sightengine",
      isBlurred: false,
      isHidden: true,
      reason: "Severe graphic gore detected",
      labels: scores,
    };
  }

  if (scores.violence >= POLICY_THRESHOLDS.HIDE_VIOLENCE) {
    return {
      status: "hidden",
      riskLevel: "high",
      provider: "sightengine",
      isBlurred: false,
      isHidden: true,
      reason: "Severe physical violence detected",
      labels: scores,
    };
  }

  if (scores.offensive >= POLICY_THRESHOLDS.HIDE_OFFENSIVE_HATE) {
    return {
      status: "hidden",
      riskLevel: "high",
      provider: "sightengine",
      isBlurred: false,
      isHidden: true,
      reason: "High-confidence hate speech or offensive imagery detected",
      labels: scores,
    };
  }

  if (scores.self_harm >= POLICY_THRESHOLDS.HIDE_SELF_HARM) {
    return {
      status: "hidden",
      riskLevel: "high",
      provider: "sightengine",
      isBlurred: false,
      isHidden: true,
      reason: "High-confidence self-harm content detected",
      labels: scores,
    };
  }

  // Threatening weapon context (severe weapon + violent context) -> HIDDEN
  if (
    scores.weapon >= POLICY_THRESHOLDS.HIDE_WEAPON_WITH_VIOLENCE &&
    scores.violence >= POLICY_THRESHOLDS.HIDE_WEAPON_WITH_VIOLENCE
  ) {
    return {
      status: "hidden",
      riskLevel: "high",
      provider: "sightengine",
      isBlurred: false,
      isHidden: true,
      reason: "Severe weapon with violent context detected",
      labels: scores,
    };
  }

  // 2. Check BORDERLINE / SENSITIVE content -> BLURRED
  if (scores.sexual_activity >= POLICY_THRESHOLDS.BLUR_SEXUAL_ACTIVITY) {
    return {
      status: "blurred",
      riskLevel: "medium",
      provider: "sightengine",
      isBlurred: true,
      isHidden: false,
      reason: "Sexual activity detected",
      labels: scores,
    };
  }

  if (scores.sexual_display >= POLICY_THRESHOLDS.BLUR_SEXUAL_DISPLAY) {
    return {
      status: "blurred",
      riskLevel: "medium",
      provider: "sightengine",
      isBlurred: true,
      isHidden: false,
      reason: "Sensitive sexual display detected",
      labels: scores,
    };
  }

  if (scores.erotica >= POLICY_THRESHOLDS.BLUR_EROTICA) {
    return {
      status: "blurred",
      riskLevel: "medium",
      provider: "sightengine",
      isBlurred: true,
      isHidden: false,
      reason: "Suggestive erotica detected",
      labels: scores,
    };
  }

  if (scores.suggestive >= POLICY_THRESHOLDS.BLUR_SUGGESTIVE) {
    return {
      status: "blurred",
      riskLevel: "medium",
      provider: "sightengine",
      isBlurred: true,
      isHidden: false,
      reason: "Suggestive imagery detected",
      labels: scores,
    };
  }

  if (scores.gore >= POLICY_THRESHOLDS.BLUR_GORE) {
    return {
      status: "blurred",
      riskLevel: "medium",
      provider: "sightengine",
      isBlurred: true,
      isHidden: false,
      reason: "Disturbing or gore imagery detected",
      labels: scores,
    };
  }

  if (scores.violence >= POLICY_THRESHOLDS.BLUR_VIOLENCE) {
    return {
      status: "blurred",
      riskLevel: "medium",
      provider: "sightengine",
      isBlurred: true,
      isHidden: false,
      reason: "Potentially violent content detected",
      labels: scores,
    };
  }

  if (scores.offensive >= POLICY_THRESHOLDS.BLUR_OFFENSIVE_HATE) {
    return {
      status: "blurred",
      riskLevel: "medium",
      provider: "sightengine",
      isBlurred: true,
      isHidden: false,
      reason: "Potentially offensive imagery detected",
      labels: scores,
    };
  }

  if (scores.self_harm >= POLICY_THRESHOLDS.BLUR_SELF_HARM) {
    return {
      status: "blurred",
      riskLevel: "medium",
      provider: "sightengine",
      isBlurred: true,
      isHidden: false,
      reason: "Sensitive self-harm content detected",
      labels: scores,
    };
  }

  // Weapon detection flags/blurs rather than hides (accommodates sporting/kitchen/tool items)
  if (scores.weapon >= POLICY_THRESHOLDS.BLUR_WEAPON) {
    return {
      status: "blurred",
      riskLevel: "medium",
      provider: "sightengine",
      isBlurred: true,
      isHidden: false,
      reason: "Weapon detected in image",
      labels: scores,
    };
  }

  // 3. Normal retail / lifestyle image -> APPROVED
  return {
    status: "approved",
    riskLevel: "low",
    provider: "sightengine",
    isBlurred: false,
    isHidden: false,
    reason: null,
    labels: scores,
  };
}

/**
 * Creates fail-open evaluation result when provider fails.
 */
function createFailOpenResult(
  reason: string,
  latencyMs?: number,
): ModerationEvaluation {
  return {
    status: "failed",
    riskLevel: null,
    provider: "sightengine",
    isBlurred: false,
    isHidden: false,
    reason,
    labels: {
      error: reason,
      ...(typeof latencyMs === "number" ? { latency_ms: latencyMs } : {}),
    },
  };
}

/**
 * Calls Sightengine Image Moderation API using native fetch.
 */
async function callSightengineModeration(
  imageUrl: string,
  apiUser: string,
  apiSecret: string,
): Promise<ModerationEvaluation> {
  const startTime = Date.now();

  try {
    const sightengineUrl = new URL("https://api.sightengine.com/1.0/check.json");
    sightengineUrl.searchParams.set(
      "models",
      "nudity-2.1,weapon,violence,gore,self-harm,offensive",
    );
    sightengineUrl.searchParams.set("url", imageUrl);
    sightengineUrl.searchParams.set("api_user", apiUser);
    sightengineUrl.searchParams.set("api_secret", apiSecret);

    const response = await fetch(sightengineUrl.toString(), {
      method: "GET",
      signal: AbortSignal.timeout(10000),
    });

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `Sightengine API HTTP ${response.status}:`,
        errorText.slice(0, 200),
      );
      return createFailOpenResult(
        `Sightengine HTTP error: ${response.status}`,
        latencyMs,
      );
    }

    const data = (await response.json()) as SightengineResponse;

    if (data.status !== "success") {
      const errorMsg =
        data.error?.message || "Provider returned non-success status";
      console.error("Sightengine API reported failure:", errorMsg);
      return createFailOpenResult(`Sightengine error: ${errorMsg}`, latencyMs);
    }

    const normalizedScores = normalizeScores(data, latencyMs);
    return evaluateModerationPolicy(normalizedScores);
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.error("Sightengine request failed:", errorMsg);
    return createFailOpenResult(
      `Sightengine network error: ${errorMsg}`,
      latencyMs,
    );
  }
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

    let result: ModerationEvaluation;

    if (devModeEnabled && body.devOutcome) {
      result = {
        status: body.devOutcome,
        riskLevel:
          body.devOutcome === "hidden"
            ? "high"
            : body.devOutcome === "blurred"
              ? "medium"
              : body.devOutcome === "approved"
                ? "low"
                : null,
        provider: "dev_mode",
        isBlurred: body.devOutcome === "blurred",
        isHidden: body.devOutcome === "hidden",
        reason: "Development test outcome",
        labels: {
          dev_mode: true,
          dev_outcome: body.devOutcome,
        },
      };
    } else {
      const apiUser = Deno.env.get("SIGHTENGINE_API_USER");
      const apiSecret = Deno.env.get("SIGHTENGINE_API_SECRET");

      if (!apiUser || !apiSecret) {
        console.error(
          "Missing Sightengine API credentials (SIGHTENGINE_API_USER / SIGHTENGINE_API_SECRET)",
        );
        result = createFailOpenResult("Missing Sightengine API credentials");
      } else {
        result = await callSightengineModeration(
          body.imageUrl,
          apiUser,
          apiSecret,
        );
      }
    }

    const moderationUpdate = {
      status: result.status,
      risk_level: result.riskLevel,
      provider: result.provider,
      labels: result.labels,
      is_blurred: result.isBlurred,
      is_hidden: result.isHidden,
      review_reason: result.reason,
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