import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useProducts } from "../hooks/ProductsContext";

export default function BrandScreen() {
  const router = useRouter();
  const { products } = useProducts();
  const params = useLocalSearchParams<{ category?: string }>();
  const category = params.category ?? "shoes";

  // unique brands for this category
  const brands = useMemo(() => {
    const set = new Set<string>();
    products
      .filter((p) => p.category === category)
      .forEach((p) => set.add(p.brand));
    return Array.from(set);
  }, [products, category]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{category.toUpperCase()}</Text>

      {brands.map((brand) => (
        <Pressable
          key={brand}
          style={styles.item}
          onPress={() =>
            router.push(
              `/shoe-products?category=${category}&brand=${encodeURIComponent(
                brand
              )}`
            )
          }
        >
          <Text style={styles.text}>{brand}</Text>
        </Pressable>
      ))}

      {brands.length === 0 && (
        <Text style={{ marginTop: 20, color: "#777" }}>
          No brands yet for this category.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20 },
  title: { fontSize: 22, fontWeight: "bold", marginBottom: 20 },
  item: {
    padding: 16,
    backgroundColor: "#eaeaea",
    borderRadius: 10,
    marginBottom: 10,
  },
    text: { fontSize: 18 },
});
