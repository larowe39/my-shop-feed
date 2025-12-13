import { useRouter } from "expo-router";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useProducts } from "../hooks/ProductsContext";

export default function CategoriesScreen() {
  const router = useRouter();
  const { products } = useProducts();

  // build a unique list of categories from existing products
  const categories = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => set.add(p.category));
    return Array.from(set);
  }, [products]);

  return (
    <View style={styles.container}>
      {categories.map((cat) => (
        <Pressable
          key={cat}
          style={styles.item}
          onPress={() => router.push(`/shoe-brands?category=${cat}`)}
        >
          <Text style={styles.text}>{cat.toUpperCase()}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20 },
  item: {
    padding: 16,
    backgroundColor: "#f2f2f2",
    borderRadius: 10,
    marginBottom: 10,
  },
  text: { fontSize: 18 },
});
