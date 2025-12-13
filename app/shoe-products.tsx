import * as Linking from "expo-linking";
import { useLocalSearchParams } from "expo-router";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useProducts } from "../hooks/ProductsContext";

export default function ProductsScreen() {
  const { products } = useProducts();
  const { category, brand } =
    useLocalSearchParams<{ category?: string; brand?: string }>();

  const filtered = useMemo(
    () =>
      products.filter(
        (p) =>
          (!category || p.category === category) &&
          (!brand || p.brand === brand)
      ),
    [products, category, brand]
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>
        {brand ? brand : "Products"}{" "}
        {category ? `· ${String(category).toUpperCase()}` : ""}
      </Text>

      {filtered.map((p) => (
        <Pressable
          key={p.id}
          style={styles.card}
          onPress={() => p.url && Linking.openURL(p.url)}
        >
          <View style={styles.imagePlaceholder}>
            <Text style={styles.imageText}>IMG</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.productBrand}>{p.brand}</Text>
            <Text style={styles.productName}>{p.title}</Text>
            <Text style={styles.productPrice}>{p.price}</Text>
          </View>
        </Pressable>
      ))}

      {filtered.length === 0 && (
        <Text style={{ marginTop: 20, color: "#777" }}>
          No products yet for this brand in this category.
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20 },
  title: { fontSize: 20, fontWeight: "bold", marginBottom: 16 },
  card: {
    marginBottom: 16,
    borderRadius: 10,
    backgroundColor: "#fff",
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    elevation: 2,
  },
  imagePlaceholder: {
    width: 60,
    height: 60,
    borderRadius: 8,
    backgroundColor: "#ddd",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  imageText: { fontWeight: "bold", color: "#555" },
  productBrand: { fontSize: 12, color: "#999" },
  productName: { fontSize: 16, fontWeight: "600" },
  productPrice: { marginTop: 4, fontWeight: "bold" },
});
