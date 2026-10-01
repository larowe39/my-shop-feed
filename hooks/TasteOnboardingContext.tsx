// hooks/TasteOnboardingContext.tsx
//
// Client state for PENCHANT's Taste Onboarding (PR #35).
//
// Loads the durable eligibility marker (user_profiles.taste_onboarding_version)
// and the authoritative onboarding state row (public.user_taste_onboarding)
// for the signed-in user and exposes the resolved OnboardingStatus consumed
// by the centralized gate in app/_layout.tsx.
//
// Race safety with profile creation: AuthContext.ensureUserProfile creates a
// brand-new profile WITH the onboarding version marker, but the insert lands
// asynchronously after sign-up. If the profile row is not visible yet, this
// provider retries (bounded) instead of deciding prematurely. If the profile
// is still missing after retries — which can only happen for a historical
// account that predates profiles and whose ensure-insert is failing — the
// user is treated as ELIGIBLE (synthetic marker) rather than grandfathered,
// so a new account can never be permanently skipped past required onboarding
// by a creation/navigation race.
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { supabase } from "../lib/supabase";
import { useAuth } from "./AuthContext";
import {
  ONBOARDING_VERSION,
  resolveOnboardingStatus,
  validateOnboardingCompletion,
} from "../lib/tasteOnboarding";
import type { OnboardingStatus } from "../lib/tasteOnboarding";

export type TasteOnboardingStateRow = {
  user_id: string;
  version: number;
  status: string;
  selected_categories: string[];
  selected_product_ids: string[];
  started_at: string | null;
  completed_at: string | null;
};

type CompleteResult = { ok: true } | { ok: false; error: string };

type TasteOnboardingContextType = {
  status: OnboardingStatus;
  state: TasteOnboardingStateRow | null;
  // Re-read profile + onboarding state (e.g. after completion).
  refresh: () => Promise<void>;
  // Persist in-progress selections to the state row (no taste events).
  saveProgress: (categories: string[], productIds: string[]) => Promise<void>;
  // Atomically validate + persist completion via the RPC (state + events).
  completeOnboarding: (args: {
    categories: string[];
    productIds: string[];
    availableProductCount: number;
  }) => Promise<CompleteResult>;
};

const TasteOnboardingContext = createContext<TasteOnboardingContextType | undefined>(
  undefined
);

const PROFILE_RETRY_LIMIT = 5;
const PROFILE_RETRY_DELAY_MS = 500;

export function TasteOnboardingProvider({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [profile, setProfile] = useState<{ taste_onboarding_version: number | null } | null | undefined>(undefined);
  const [state, setState] = useState<TasteOnboardingStateRow | null | undefined>(undefined);
  const loadSeqRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeqRef.current;
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    if (!user) {
      setProfile(undefined);
      setState(undefined);
      return;
    }

    const fetchOnce = async () => {
      const [profileResult, stateResult] = await Promise.all([
        supabase
          .from("user_profiles")
          .select("taste_onboarding_version")
          .eq("user_id", user.id)
          .maybeSingle(),
        supabase
          .from("user_taste_onboarding")
          .select(
            "user_id, version, status, selected_categories, selected_product_ids, started_at, completed_at"
          )
          .eq("user_id", user.id)
          .maybeSingle(),
      ]);
      return { profileResult, stateResult };
    };

    let attempts = 0;
    let profileRow: { taste_onboarding_version: number | null } | null = null;
    let stateRow: TasteOnboardingStateRow | null = null;

    for (;;) {
      attempts += 1;
      const { profileResult, stateResult } = await fetchOnce();
      if (seq !== loadSeqRef.current) return; // superseded by a newer load

      stateRow = (stateResult.data as TasteOnboardingStateRow | null) ?? null;
      if (stateResult.error && __DEV__) {
        console.log("[onboarding] failed to load onboarding state", stateResult.error);
      }

      if (profileResult.data) {
        profileRow = profileResult.data as { taste_onboarding_version: number | null };
        break;
      }
      // Profile row missing: AuthContext.ensureUserProfile creates it
      // asynchronously for brand-new accounts — retry briefly before deciding.
      if (attempts >= PROFILE_RETRY_LIMIT) break;
      await new Promise((resolve) => {
        retryTimerRef.current = setTimeout(resolve, PROFILE_RETRY_DELAY_MS);
      });
      if (seq !== loadSeqRef.current) return;
    }

    if (seq !== loadSeqRef.current) return;

    // Definitively missing after retries: treat as eligible (never as
    // grandfathered) so new accounts can never slip past required onboarding.
    setProfile(profileRow ?? { taste_onboarding_version: ONBOARDING_VERSION });
    setState(stateRow);
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    load();
    return () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, [authLoading, load]);

  const status = useMemo<OnboardingStatus>(
    () =>
      resolveOnboardingStatus({
        userId: user?.id ?? null,
        profile,
        state,
      }),
    [user?.id, profile, state]
  );

  const saveProgress = useCallback(
    async (categories: string[], productIds: string[]) => {
      if (!user) return;
      if (status !== "required") return; // never demote a completed row
      const { error } = await supabase.from("user_taste_onboarding").upsert(
        {
          user_id: user.id,
          version: ONBOARDING_VERSION,
          status: "in_progress",
          selected_categories: categories,
          selected_product_ids: productIds,
        },
        { onConflict: "user_id" }
      );
      if (error && __DEV__) {
        console.log("[onboarding] failed to save progress", error);
      }
    },
    [user, status]
  );

  const completeOnboarding = useCallback(
    async (args: {
      categories: string[];
      productIds: string[];
      availableProductCount: number;
    }): Promise<CompleteResult> => {
      if (!user) return { ok: false, error: "Not signed in." };

      const validation = validateOnboardingCompletion({
        categoryIds: args.categories,
        productIds: args.productIds,
        availableProductCount: args.availableProductCount,
      });
      if (!validation.ok) return { ok: false, error: validation.error };

      // Atomic server-side completion: validates, persists the state row,
      // and emits/dedupes the explicit onboarding user_events in ONE
      // transaction. Intentional narrow exception to the
      // lib/analytics.ts-only client insert path (see docs/taste-onboarding.md).
      const { error } = await supabase.rpc("complete_taste_onboarding", {
        p_user_id: user.id,
        p_categories: validation.categories,
        p_product_ids: validation.productIds,
      });
      if (error) {
        return { ok: false, error: error.message ?? "Could not finish onboarding." };
      }

      await load();
      return { ok: true };
    },
    [user, load]
  );

  const value = useMemo(
    () => ({
      status,
      state: state ?? null,
      refresh: load,
      saveProgress,
      completeOnboarding,
    }),
    [status, state, load, saveProgress, completeOnboarding]
  );

  return (
    <TasteOnboardingContext.Provider value={value}>
      {children}
    </TasteOnboardingContext.Provider>
  );
}

export function useTasteOnboarding() {
  const ctx = useContext(TasteOnboardingContext);
  if (!ctx) {
    throw new Error("useTasteOnboarding must be used inside TasteOnboardingProvider");
  }
  return ctx;
}
