// lib/analytics.ts
//
// Reusable behavioral event tracking helper. This is the ONLY place that
// should insert into public.user_events — never scatter raw supabase.from
// ("user_events") calls across screens/components.
//
// Authenticated users only: RLS on user_events requires auth.uid() = user_id,
// so signed-out visitors are silently skipped rather than adding a wide-open
// anonymous insert policy that would expose the table to abuse.
import { supabase } from "./supabase";

export type EventType =
  | "product_impression"
  | "product_open"
  | "product_like"
  | "product_unlike"
  | "product_save"
  | "product_unsave"
  | "shop_click"
  | "seller_open"
  | "seller_follow"
  | "seller_unfollow"
  | "product_dwell"
  | "product_report"
  | "sensitive_content_reveal"
  | "search_query"
  | "search_result_open"
  | "catalog_match_attempt"
  | "catalog_match_high_confidence"
  | "catalog_match_suggested"
  | "catalog_match_accepted"
  | "catalog_match_rejected"
  | "catalog_match_none"
  | "catalog_variant_matched";

// Where the interaction happened, stored in metadata.source rather than as
// dedicated columns to keep the schema small.
export type EventSource =
  | "for_you"
  | "following"
  | "category"
  | "saved"
  | "seller_profile"
  | "product_detail"
  | "search";

export type TrackEventInput = {
  eventType: EventType;
  productId?: string | null;
  sellerId?: string | null;
  category?: string | null;
  metadata?: Record<string, unknown>;
};

// One id per app session (module load), useful later for grouping a user's
// browsing session without needing a dedicated auth concept.
const SESSION_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export async function trackEvent({
  eventType,
  productId = null,
  sellerId = null,
  category = null,
  metadata = {},
}: TrackEventInput): Promise<void> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData.session?.user?.id;

    // Signed-out visitors are not tracked yet — see module doc comment.
    if (!userId) return;

    const { error } = await supabase.from("user_events").insert({
      user_id: userId,
      session_id: SESSION_ID,
      event_type: eventType,
      product_id: productId,
      seller_id: sellerId,
      category,
      metadata,
    });

    if (error && __DEV__) {
      console.log(`[analytics] failed to record "${eventType}"`, error);
    }
  } catch (err) {
    // Analytics must never break the UI: swallow and log in dev only.
    if (__DEV__) {
      console.log(`[analytics] unexpected error recording "${eventType}"`, err);
    }
  }
}

// Dedupe repeated impressions for the same product within one mounted
// screen/list so re-renders and scroll re-layouts don't spam the database.
// Usage: const tracker = useRef(createImpressionTracker()).current;
export function createImpressionTracker() {
  const seen = new Set<string>();
  return function trackImpressionOnce(key: string, fire: () => void) {
    if (seen.has(key)) return;
    seen.add(key);
    fire();
  };
}
