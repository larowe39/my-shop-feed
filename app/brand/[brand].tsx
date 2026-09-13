import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo } from "react";
import { Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { ProductGrid } from "../../components/ProductGrid";
import { type Product, useProducts } from "../../hooks/ProductsContext";
import { trackEvent } from "../../lib/analytics";

export default function BrandProductsScreen() {
  const router = useRouter();
  const { brand } = useLocalSearchParams<{ brand?: string }>();
  const { products } = useProducts();
  const brandName = useMemo(() => decodeURIComponent(String(brand ?? "")).trim(), [brand]);
  const brandProducts = useMemo(() => products.filter((product) => product.brand.trim().toLowerCase() === brandName.toLowerCase()), [products, brandName]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Pressable style={styles.back} onPress={() => router.back()}><Ionicons name="chevron-back" size={21} color="#111" /><Text style={styles.backText}>Back</Text></Pressable>
        <Text style={styles.eyebrow}>BRAND EDIT</Text>
        <Text style={styles.title}>{brandName || "Brand"}</Text>
        <Text style={styles.count}>{brandProducts.length} {brandProducts.length === 1 ? "product" : "products"}</Text>
        <View style={styles.grid}>
          <ProductGrid products={brandProducts} onPressProduct={(product: Product) => { trackEvent({ eventType: "product_open", productId: product.id, sellerId: product.user_id ?? null, category: product.category, metadata: { source: "brand" } }); router.push(`/${encodeURIComponent(product.id)}`); }} onImpression={(product) => trackEvent({ eventType: "product_impression", productId: product.id, sellerId: product.user_id ?? null, category: product.category, metadata: { source: "brand" } })} emptyTitle="No products from this brand" emptyDescription="Explore another brand or browse the full catalog." />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 22, paddingBottom: 40 },
  back: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 30 },
  backText: { color: "#111", fontSize: 14 },
  eyebrow: { color: "#777", fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: "#111", fontSize: 32, fontWeight: "800", marginTop: 8 },
  count: { color: "#777", fontSize: 14, marginTop: 8 },
  grid: { marginTop: 22 },
});