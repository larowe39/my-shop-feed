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

type ProductReaction = "like" | "save";

type ProductsContextType = {
  products: Product[];
  likedIds: string[];
  savedIds: string[];
  isLikePending: (id: string) => boolean;
  isSavePending: (id: string) => boolean;
  toggleLike: (id: string) => Promise<boolean>;
  toggleSave: (id: string) => Promise<boolean>;
  addProduct: (input: Omit<Product, "id" | "created_at">) => Promise<void>;
  loading: boolean;
  error: string | null;
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

export function ProductsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const pendingKeysRef = useRef<Set<string>>(new Set());
  const likedIdsRef = useRef<string[]>([]);
  const savedIdsRef = useRef<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

      const nextLikedIds = ((likesData as ProductReactionRow[] | null) ?? []).map(
        (row) => row.product_id
      );
      const nextSavedIds = ((savesData as ProductReactionRow[] | null) ?? []).map(
        (row) => row.product_id
      );

      likedIdsRef.current = nextLikedIds;
      savedIdsRef.current = nextSavedIds;
      setLikedIds(nextLikedIds);
      setSavedIds(nextSavedIds);
    },
    []
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const rows = await loadProducts();
      setProducts(rows);

      if (user?.id) {
        try {
          await loadUserReactions(user.id);
        } catch (reactionsError) {
          console.log("Error loading product reactions", reactionsError);
          likedIdsRef.current = [];
          savedIdsRef.current = [];
          setLikedIds([]);
          setSavedIds([]);
        }
      } else {
        likedIdsRef.current = [];
        savedIdsRef.current = [];
        setLikedIds([]);
        setSavedIds([]);
      }
    } catch (refreshError: any) {
      console.log("Error loading products", refreshError);
      setError(refreshError?.message ?? "Failed to load products.");
      setProducts([DEMO]);
      setLikedIds([]);
      setSavedIds([]);
    } finally {
      setLoading(false);
    }
  }, [loadProducts, loadUserReactions, user?.id]);

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

  const setPending = useCallback((key: string, pending: boolean) => {
    if (pending) {
      pendingKeysRef.current.add(key);
    } else {
      pendingKeysRef.current.delete(key);
    }

    setPendingKeys((prev) => {
      const next = new Set(prev);
      if (pending) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });
  }, []);

  const toggleReaction = useCallback(
    async (
      productId: string,
      reaction: ProductReaction
    ) => {
      if (!user?.id) {
        return false;
      }

      const key = `${reaction}:${productId}`;
      if (pendingKeysRef.current.has(key)) {
        return true;
      }

      const table = reaction === "like" ? "product_likes" : "product_saves";
      const idsRef = reaction === "like" ? likedIdsRef : savedIdsRef;
      const wasActive = idsRef.current.includes(productId);

      setPending(key, true);
      updateReactionIds(reaction, (prev) =>
        wasActive ? prev.filter((id) => id !== productId) : [...prev, productId]
      );

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

        return true;
      } catch (mutationError) {
        console.log(`Error toggling ${reaction}`, mutationError);
        updateReactionIds(reaction, (prev) =>
          wasActive ? [...prev, productId] : prev.filter((id) => id !== productId)
        );
        return false;
      } finally {
        setPending(key, false);
      }
    },
    [setPending, updateReactionIds, user?.id]
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

  const value = useMemo(
    () => ({
      products,
      likedIds,
      savedIds,
      isLikePending: (id: string) => pendingKeys.has(`like:${id}`),
      isSavePending: (id: string) => pendingKeys.has(`save:${id}`),
      toggleLike,
      toggleSave,
      addProduct,
      loading,
      error,
      refresh,
    }),
    [products, likedIds, savedIds, pendingKeys, toggleLike, toggleSave, loading, error, refresh]
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
