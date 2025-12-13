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
  price: string;
  url: string;
  category: string;
  image_url?: string;
  created_at?: string;
};

type ProductsContextType = {
  products: Product[];
  likedIds: string[];
  toggleLike: (id: string) => void;
  addProduct: (
    input: Omit<Product, "id" | "created_at">
  ) => Promise<void>;
  loading: boolean;
  error: string | null;
};

const ProductsContext = createContext<ProductsContextType | undefined>(
  undefined
);

export function ProductsProvider({ children }: { children: ReactNode }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 🔹 Load products from Supabase on app start
  useEffect(() => {
    async function loadProducts() {
      setLoading(true);
      setError(null);

      const { data, error } = await supabase
        .from("products")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.log("Error loading products", error);
        setError(error.message);
      } else if (data) {
        setProducts(data as Product[]);
      }

      setLoading(false);
    }

    loadProducts();
  }, []);

  const toggleLike = (id: string) => {
    setLikedIds((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : [...prev, id]
    );
  };

  // 🔹 Add a new product to Supabase + local state
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
  if (!ctx) {
    throw new Error("useProducts must be used inside ProductsProvider");
  }
  return ctx;
}
