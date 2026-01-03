// hooks/ProductsContext.tsx
import React, {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { supabase } from "../lib/supabase";

export type Product = {
  id: string;
  title: string;
  brand: string;
  price: string | null;
  url: string | null;
  category: string;
  image_url?: string | null;
  created_at?: string;
};

type ProductsContextType = {
  products: Product[];
  likedIds: string[];
  toggleLike: (id: string) => void;
  addProduct: (input: Omit<Product, "id" | "created_at">) => Promise<void>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

const ProductsContext = createContext<ProductsContextType | undefined>(undefined);

const DEMO: Product = {
  id: "demo-1",
  title: "Black hoodie, heavy-weight fit",
  brand: "PENCHANT",
  price: "98",
  url: "https://example.com",
  category: "hoodies",
  image_url:
    "https://images.unsplash.com/photo-1520975682031-a3be94a0c177?auto=format&fit=crop&w=1200&q=80",
  created_at: new Date().toISOString(),
};

export function ProductsProvider({ children }: { children: ReactNode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);

    const { data, error } = await supabase
      .from("products")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.log("Error loading products", error);
      setError(error.message);
      setProducts([DEMO]); // still show something
      setLoading(false);
      return;
    }

    const rows = (data as Product[]) || [];
    console.log("Loaded products:", rows.length);

    setProducts(rows.length ? rows : [DEMO]);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const toggleLike = (id: string) => {
    setLikedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const addProduct = async (
    input: Omit<Product, "id" | "created_at">
  ): Promise<void> => {
    const { data, error } = await supabase
      .from("products")
      .insert({
        title: input.title,
        brand: input.brand,
        price: input.price,
        url: input.url,
        category: input.category,
        image_url: input.image_url ?? null,
      })
      .select()
      .single();

    if (error) {
      console.log("Error adding product", error);
      throw error;
    }

    if (data) {
      setProducts((prev) => [data as Product, ...prev]);
    }
  };

  const value = useMemo(
    () => ({
      products,
      likedIds,
      toggleLike,
      addProduct,
      loading,
      error,
      refresh,
    }),
    [products, likedIds, loading, error]
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
