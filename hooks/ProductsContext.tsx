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
import { supabase } from "../lib/supabase";

export type Product = {
  id: string;
  title: string;
  brand: string;
  price: string | null;
  url: string | null;
  category: string;
  user_id?: string | null;
  image_url?: string | null;
  created_at?: string;
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
  isLikePending: (id: string) => boolean;
  isSavePending: (id: string) => boolean;
  toggleLike: (id: string) => Promise<ToggleReactionResult>;
  toggleSave: (id: string) => Promise<ToggleReactionResult>;
  addProduct: (input: Omit<Product, "id" | "created_at">) => Promise<void>;
  updateProduct: (
    id: string,
    input: Partial<Omit<Product, "id" | "created_at">>
  ) => Promise<void>;
  loading: boolean;
  error: string | null;
  reactionError: string | null;
  refresh: () => Promise<void>;
};

type ProductReactionRow = {
  product_id: string;
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
  const [pendingReactions, setPendingReactions] = useState<PendingReactionSets>(
    makePendingReactionSets
  );
  // Refs keep rapid toggles and refresh reconciliation in sync with the latest
  // optimistic reaction state before React finishes committing visible updates.
  const pendingReactionsRef = useRef<PendingReactionSets>(makePendingReactionSets());
  const pendingReactionValuesRef = useRef<PendingReactionValues>(
    makePendingReactionValues()
  );
  const reactionLoadRequestIdRef = useRef(0);
  // These refs mirror the rendered liked/saved arrays so async mutations and
  // refreshes can always read the latest intended reaction state.
  const likedIdsRef = useRef<string[]>([]);
  const savedIdsRef = useRef<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reactionError, setReactionError] = useState<string | null>(null);

  const loadProducts = useCallback(async (): Promise<Product[]> => {
    const { data, error: productsError } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });

    if (productsError) {
      throw productsError;
    }

    return ((data as Product[]) || []).length ? (data as Product[]) : [DEMO];
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
          await loadUserReactions(user.id);
        } catch (reactionsError) {
          console.log("Error loading product reactions", reactionsError);
          setReactionError("We couldn't load your likes and saves right now.");
        }
      } else {
        likedIdsRef.current = [];
        savedIdsRef.current = [];
        setLikedIds([]);
        setSavedIds([]);
        setReactionError(null);
      }
    } catch (refreshError: any) {
      console.log("Error loading products", refreshError);
      setError(refreshError?.message ?? "Failed to load products.");
      setProducts([DEMO]);
    } finally {
      setLoading(false);
    }
  }, [loadProducts, loadSellerProfiles, loadUserReactions, user?.id]);

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
    [loadUserReactions, setPending, setReactionActive, user?.id]
  );

  const toggleLike = useCallback(
    (id: string) => toggleReaction(id, "like"),
    [toggleReaction]
  );

  const toggleSave = useCallback(
    (id: string) => toggleReaction(id, "save"),
    [toggleReaction]
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
      isLikePending: (id: string) => pendingReactions.like.has(id),
      isSavePending: (id: string) => pendingReactions.save.has(id),
      toggleLike,
      toggleSave,
      addProduct,
      updateProduct,
      loading,
      error,
      reactionError,
      refresh,
    }),
    [
      products,
      sellerProfiles,
      likedIds,
      savedIds,
      pendingReactions,
      toggleLike,
      toggleSave,
      updateProduct,
      loading,
      error,
      reactionError,
      refresh,
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
