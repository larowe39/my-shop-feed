import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAuth } from "./AuthContext";
import { trackEvent } from "../lib/analytics";
import { supabase } from "../lib/supabase";
import type { ProductModeration } from "../lib/moderation";

export type Product = {
  id: string;
  title: string;
  brand: string;
  price: string | null;
  url: string | null;
  category: string;
  catalog_product_id?: string | null;
  catalog_variant_id?: string | null;
  user_id?: string | null;
  image_url?: string | null;
  created_at?: string;
  moderation?: ProductModeration | null;
};

export type SellerProfile = {
  user_id: string;
  display_name: string;
  avatar_url?: string | null;
  bio?: string | null;
};

type ProductReaction = "like" | "save";
type ToggleReactionResult = "updated" | "pending" | "auth_required" | "error";
type PendingReactionSets = Record<ProductReaction, Set<string>>;
type PendingReactionValues = Record<ProductReaction, Map<string, boolean>>;

type ProductsContextType = {
  products: Product[];
  sellerProfiles: Record<string, SellerProfile>;
  likedIds: string[];
  savedIds: string[];
  followingIds: string[];
  isLikePending: (id: string) => boolean;
  isSavePending: (id: string) => boolean;
  isFollowPending: (sellerId: string) => boolean;
  toggleLike: (id: string) => Promise<ToggleReactionResult>;
  toggleSave: (id: string) => Promise<ToggleReactionResult>;
  toggleFollow: (sellerId: string) => Promise<ToggleReactionResult>;
  addProduct: (input: Omit<Product, "id" | "created_at">) => Promise<void>;
  updateProduct: (
    id: string,
    input: Partial<Omit<Product, "id" | "created_at">>
  ) => Promise<void>;
  loading: boolean;
  error: string | null;
  reactionError: string | null;
  refresh: () => Promise<void>;
  refreshFollows: () => Promise<void>;
};

type ProductReactionRow = {
  product_id: string;
};

type UserFollowRow = {
  following_id: string;
};

const ProductsContext = createContext<ProductsContextType | undefined>(undefined);

const DEMO: Product = {
  id: "demo-1",
  title: "Black hoodie, heavy-weight fit",
  brand: "PENCHANT",
  price: "98",
  url: "https://example.com",
  category: "hoodies",
  user_id: null,
  image_url:
    "https://images.unsplash.com/photo-1520975682031-a3be94a0c177?auto=format&fit=crop&w=1200&q=80",
  created_at: new Date().toISOString(),
};

function makePendingReactionSets(): PendingReactionSets {
  return { like: new Set<string>(), save: new Set<string>() };
}

function makePendingReactionValues(): PendingReactionValues {
  return { like: new Map<string, boolean>(), save: new Map<string, boolean>() };
}

export function ProductsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [sellerProfiles, setSellerProfiles] = useState<Record<string, SellerProfile>>({});
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [followingIds, setFollowingIds] = useState<string[]>([]);
  const [pendingReactions, setPendingReactions] = useState<PendingReactionSets>(
    makePendingReactionSets
  );
  const [pendingFollows, setPendingFollows] = useState<Set<string>>(new Set<string>());

  // Refs keep rapid toggles and refresh reconciliation in sync with the latest
  // optimistic reaction state before React finishes committing visible updates.
  const pendingReactionsRef = useRef<PendingReactionSets>(makePendingReactionSets());
  const pendingReactionValuesRef = useRef<PendingReactionValues>(
    makePendingReactionValues()
  );
  const pendingFollowsRef = useRef<Set<string>>(new Set<string>());
  const pendingFollowValuesRef = useRef<Map<string, boolean>>(new Map<string, boolean>());

  const reactionLoadRequestIdRef = useRef(0);
  const followLoadRequestIdRef = useRef(0);

  // These refs mirror the rendered arrays so async mutations and
  // refreshes can always read the latest intended reaction state.
  const likedIdsRef = useRef<string[]>([]);
  const savedIdsRef = useRef<string[]>([]);
  const followingIdsRef = useRef<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reactionError, setReactionError] = useState<string | null>(null);

  const loadProducts = useCallback(async (): Promise<Product[]> => {
    const { data, error: productsError } = await supabase
      .from("products")
      .select("*, product_moderation(product_id, status, is_blurred, is_hidden)")
      .order("created_at", { ascending: false });

    if (productsError) {
      throw productsError;
    }

    const rows = ((data as (Product & { product_moderation?: ProductModeration | ProductModeration[] | null })[]) || [])
      .map(({ product_moderation, ...product }) => ({
        ...product,
        moderation: Array.isArray(product_moderation) ? product_moderation[0] ?? null : product_moderation ?? null,
      }))
      .filter((product) => !product.moderation?.is_hidden);
    return rows.length ? rows : [DEMO];
  }, []);

  const loadUserReactions = useCallback(
    async (userId: string) => {
      const requestId = ++reactionLoadRequestIdRef.current;
      const [
        { data: likesData, error: likesError },
        { data: savesData, error: savesError },
      ] = await Promise.all([
        supabase
          .from("product_likes")
          .select("product_id")
          .eq("user_id", userId),
        supabase
          .from("product_saves")
          .select("product_id")
          .eq("user_id", userId),
      ]);

      if (likesError) throw likesError;
      if (savesError) throw savesError;
      if (requestId !== reactionLoadRequestIdRef.current) return;

      const nextLikedIds = ((likesData as ProductReactionRow[] | null) ?? []).map(
        (row) => row.product_id
      );
      const nextSavedIds = ((savesData as ProductReactionRow[] | null) ?? []).map(
        (row) => row.product_id
      );

      for (const reaction of ["like", "save"] as const) {
        const targetIds = reaction === "like" ? nextLikedIds : nextSavedIds;

        for (const [productId, isActive] of pendingReactionValuesRef.current[
          reaction
        ].entries()) {
          const hasProduct = targetIds.includes(productId);

          if (isActive && !hasProduct) {
            targetIds.push(productId);
          }

          if (!isActive && hasProduct) {
            const idx = targetIds.indexOf(productId);
            targetIds.splice(idx, 1);
          }
        }
      }

      likedIdsRef.current = nextLikedIds;
      savedIdsRef.current = nextSavedIds;
      setLikedIds(nextLikedIds);
      setSavedIds(nextSavedIds);
    },
    []
  );

  const loadUserFollows = useCallback(
    async (userId: string) => {
      const requestId = ++followLoadRequestIdRef.current;
      const { data: followsData, error: followsError } = await supabase
        .from("user_follows")
        .select("following_id")
        .eq("follower_id", userId);

      if (followsError) throw followsError;
      if (requestId !== followLoadRequestIdRef.current) return;

      const nextFollowingIds = ((followsData as UserFollowRow[] | null) ?? [])
        .map((row) => row.following_id)
        .filter(Boolean);

      for (const [sellerId, isActive] of pendingFollowValuesRef.current.entries()) {
        const hasFollow = nextFollowingIds.includes(sellerId);
        if (isActive && !hasFollow) {
          nextFollowingIds.push(sellerId);
        }
        if (!isActive && hasFollow) {
          const idx = nextFollowingIds.indexOf(sellerId);
          nextFollowingIds.splice(idx, 1);
        }
      }

      followingIdsRef.current = nextFollowingIds;
      setFollowingIds(nextFollowingIds);
    },
    []
  );

  const loadSellerProfiles = useCallback(async (rows: Product[]) => {
    const userIds = Array.from(
      new Set(
        rows
          .map((row) => (typeof row.user_id === "string" ? row.user_id : null))
          .filter((row): row is string => !!row)
      )
    );

    if (!userIds.length) {
      setSellerProfiles({});
      return;
    }

    const { data, error: profilesError } = await supabase
      .from("user_profiles")
      .select("user_id, display_name, avatar_url, bio")
      .in("user_id", userIds);

    if (profilesError) {
      throw profilesError;
    }

    const nextProfiles: Record<string, SellerProfile> = {};
    for (const row of (data as SellerProfile[] | null) ?? []) {
      if (!row.user_id) continue;
      nextProfiles[row.user_id] = row;
    }

    setSellerProfiles(nextProfiles);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    setReactionError(null);

    try {
      const rows = await loadProducts();
      setProducts(rows);
      try {
        await loadSellerProfiles(rows);
      } catch (profilesError) {
        console.log("Error loading seller profiles", profilesError);
        setSellerProfiles({});
      }

      if (user?.id) {
        try {
          await Promise.all([
            loadUserReactions(user.id),
            loadUserFollows(user.id),
          ]);
        } catch (reactionsError) {
          console.log("Error loading product reactions or follows", reactionsError);
          setReactionError("We couldn't load your likes, saves, or follows right now.");
        }
      } else {
        likedIdsRef.current = [];
        savedIdsRef.current = [];
        followingIdsRef.current = [];
        setLikedIds([]);
        setSavedIds([]);
        setFollowingIds([]);
        setReactionError(null);
      }
    } catch (refreshError: any) {
      console.log("Error loading products", refreshError);
      setError(refreshError?.message ?? "Failed to load products.");
      setProducts([DEMO]);
    } finally {
      setLoading(false);
    }
  }, [loadProducts, loadSellerProfiles, loadUserReactions, loadUserFollows, user?.id]);

  const refreshFollows = useCallback(async () => {
    if (user?.id) {
      try {
        await loadUserFollows(user.id);
      } catch (err) {
        console.log("Error refreshing follows", err);
      }
    }
  }, [loadUserFollows, user?.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateReactionIds = useCallback(
    (
      reaction: ProductReaction,
      updater: (prev: string[]) => string[]
    ) => {
      const ref = reaction === "like" ? likedIdsRef : savedIdsRef;
      const setIds = reaction === "like" ? setLikedIds : setSavedIds;
      const nextIds = updater(ref.current);
      ref.current = nextIds;
      setIds(nextIds);
      return nextIds;
    },
    []
  );

  const setReactionActive = useCallback(
    (reaction: ProductReaction, productId: string, active: boolean) => {
      updateReactionIds(reaction, (prev) => {
        const hasProduct = prev.includes(productId);
        if (active && !hasProduct) {
          return [...prev, productId];
        }
        if (!active && hasProduct) {
          return prev.filter((id) => id !== productId);
        }
        return prev;
      });
    },
    [updateReactionIds]
  );

  // Keep both a ref and state in sync: the ref prevents rapid double-taps from
  // bypassing the pending guard before React commits, while state drives the UI.
  const setPending = useCallback(
    (reaction: ProductReaction, productId: string, pending: boolean) => {
      if (pending) {
        pendingReactionsRef.current[reaction].add(productId);
      } else {
        pendingReactionsRef.current[reaction].delete(productId);
      }

      setPendingReactions((prev) => {
        const next = {
          like: new Set(prev.like),
          save: new Set(prev.save),
        };

        if (pending) {
          next[reaction].add(productId);
        } else {
          next[reaction].delete(productId);
        }

        return next;
      });
    },
    []
  );

  const toggleReaction = useCallback(
    async (
      productId: string,
      reaction: ProductReaction
    ): Promise<ToggleReactionResult> => {
      if (!user?.id) {
        return "auth_required";
      }

      if (pendingReactionsRef.current[reaction].has(productId)) {
        return "pending";
      }

      const table = reaction === "like" ? "product_likes" : "product_saves";
      const idsRef = reaction === "like" ? likedIdsRef : savedIdsRef;
      const wasActive = idsRef.current.includes(productId);
      const nextActive = !wasActive;

      setPending(reaction, productId, true);
      pendingReactionValuesRef.current[reaction].set(productId, nextActive);
      setReactionActive(reaction, productId, nextActive);

      try {
        if (wasActive) {
          const { error: deleteError } = await supabase
            .from(table)
            .delete()
            .eq("user_id", user.id)
            .eq("product_id", productId);

          if (deleteError) throw deleteError;
        } else {
          const { error: insertError } = await supabase.from(table).insert({
            user_id: user.id,
            product_id: productId,
          });

          if (insertError) throw insertError;
        }

        const relatedProduct = products.find((p) => p.id === productId);
        trackEvent({
          eventType:
            reaction === "like"
              ? nextActive
                ? "product_like"
                : "product_unlike"
              : nextActive
              ? "product_save"
              : "product_unsave",
          productId,
          sellerId: relatedProduct?.user_id ?? null,
          category: relatedProduct?.category ?? null,
        });

        return "updated";
      } catch (mutationError) {
        console.log(`Error toggling ${reaction}`, mutationError);
        setReactionActive(reaction, productId, wasActive);
        pendingReactionValuesRef.current[reaction].set(productId, wasActive);
        return "error";
      } finally {
        try {
          await loadUserReactions(user.id);
        } catch (reactionsError) {
          console.log("Error reloading product reactions", reactionsError);
        }
        pendingReactionValuesRef.current[reaction].delete(productId);
        setPending(reaction, productId, false);
      }
    },
    [loadUserReactions, products, setPending, setReactionActive, user?.id]
  );

  const toggleLike = useCallback(
    (id: string) => toggleReaction(id, "like"),
    [toggleReaction]
  );

  const toggleSave = useCallback(
    (id: string) => toggleReaction(id, "save"),
    [toggleReaction]
  );

  const toggleFollow = useCallback(
    async (sellerId: string): Promise<ToggleReactionResult> => {
      if (!user?.id) {
        return "auth_required";
      }

      if (!sellerId || user.id === sellerId) {
        return "error";
      }

      if (pendingFollowsRef.current.has(sellerId)) {
        return "pending";
      }

      const wasFollowing = followingIdsRef.current.includes(sellerId);
      const nextFollowing = !wasFollowing;

      pendingFollowsRef.current.add(sellerId);
      setPendingFollows(new Set(pendingFollowsRef.current));
      pendingFollowValuesRef.current.set(sellerId, nextFollowing);

      const nextFollowingIds = nextFollowing
        ? [...followingIdsRef.current.filter((id) => id !== sellerId), sellerId]
        : followingIdsRef.current.filter((id) => id !== sellerId);

      followingIdsRef.current = nextFollowingIds;
      setFollowingIds(nextFollowingIds);

      try {
        if (wasFollowing) {
          const { error: deleteError } = await supabase
            .from("user_follows")
            .delete()
            .eq("follower_id", user.id)
            .eq("following_id", sellerId);

          if (deleteError) throw deleteError;
        } else {
          const { error: insertError } = await supabase
            .from("user_follows")
            .insert({
              follower_id: user.id,
              following_id: sellerId,
            });

          if (insertError) throw insertError;
        }

        trackEvent({
          eventType: nextFollowing ? "seller_follow" : "seller_unfollow",
          sellerId,
        });

        return "updated";
      } catch (mutationError) {
        console.log("Error toggling follow", mutationError);
        const rollbackIds = wasFollowing
          ? [...followingIdsRef.current.filter((id) => id !== sellerId), sellerId]
          : followingIdsRef.current.filter((id) => id !== sellerId);
        followingIdsRef.current = rollbackIds;
        setFollowingIds(rollbackIds);
        pendingFollowValuesRef.current.set(sellerId, wasFollowing);
        return "error";
      } finally {
        try {
          await loadUserFollows(user.id);
        } catch (followsError) {
          console.log("Error reloading user follows", followsError);
        }
        pendingFollowValuesRef.current.delete(sellerId);
        pendingFollowsRef.current.delete(sellerId);
        setPendingFollows(new Set(pendingFollowsRef.current));
      }
    },
    [loadUserFollows, user?.id]
  );

  const addProduct = async (
    input: Omit<Product, "id" | "created_at">
  ): Promise<void> => {
    const { data, error: insertError } = await supabase
      .from("products")
      .insert({
        title: input.title,
        brand: input.brand,
        price: input.price,
        url: input.url,
        category: input.category,
        image_url: input.image_url ?? null,
        user_id: input.user_id ?? null,
        catalog_product_id: input.catalog_product_id ?? null,
        catalog_variant_id: input.catalog_variant_id ?? null,
      })
      .select()
      .single();

    if (insertError) {
      console.log("Error adding product", insertError);
      throw insertError;
    }

    if (data) {
      setProducts((prev) => [data as Product, ...prev]);
    }
  };

  const updateProduct = async (
    id: string,
    input: Partial<Omit<Product, "id" | "created_at">>
  ): Promise<void> => {
    if (!user?.id) {
      throw new Error("Not signed in");
    }

    const { data, error: updateError } = await supabase
      .from("products")
      .update(input)
      .eq("id", id)
      .eq("user_id", user.id)
      .select()
      .single();

    if (updateError) {
      throw updateError;
    }

    if (data) {
      setProducts((prev) =>
        prev.map((product) =>
          product.id === id ? ({ ...product, ...(data as Product) } as Product) : product
        )
      );
    }
  };

  const value = useMemo(
    () => ({
      products,
      sellerProfiles,
      likedIds,
      savedIds,
      followingIds,
      isLikePending: (id: string) => pendingReactions.like.has(id),
      isSavePending: (id: string) => pendingReactions.save.has(id),
      isFollowPending: (sellerId: string) => pendingFollows.has(sellerId),
      toggleLike,
      toggleSave,
      toggleFollow,
      addProduct,
      updateProduct,
      loading,
      error,
      reactionError,
      refresh,
      refreshFollows,
    }),
    [
      products,
      sellerProfiles,
      likedIds,
      savedIds,
      followingIds,
      pendingReactions,
      pendingFollows,
      toggleLike,
      toggleSave,
      toggleFollow,
      addProduct,
      updateProduct,
      loading,
      error,
      reactionError,
      refresh,
      refreshFollows,
    ]
  );

  return (
    <ProductsContext.Provider value={value}>
      {children}
    </ProductsContext.Provider>
  );
}

export function useProducts() {
  const ctx = useContext(ProductsContext);
  if (!ctx) throw new Error("useProducts must be used inside ProductsProvider");
  return ctx;
}
