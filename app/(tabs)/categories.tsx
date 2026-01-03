// app/(tabs)/categories.tsx
import { useRouter } from "expo-router";
import React, { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useProducts } from "../../hooks/ProductsContext";

export default function CategoriesScreen() {
  const router = useRouter();
  const { products } = useProducts();

  const categories = useMemo(() => {
    const set = new Set<string>();

    for (const p of products) {
      const raw = (p as any)?.category;
      const cat = typeof raw === "string" ? raw.trim() : "";
      if (cat) set.add(cat);
    }

    // fallback so screen never looks empty
    if (set.size === 0) set.add("all");

    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [products]);

  return (
    <View style={styles.container}>
      {categories.map((cat) => (
        <Pressable
          key={cat}
          style={styles.item}
          onPress={() =>
            router.push(`/shoe-brands?category=${encodeURIComponent(cat)}`)
          }
        >
          <Text style={styles.text}>{cat.toUpperCase()}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, backgroundColor: "#fff", flex: 1 },
  item: {
    padding: 16,
    backgroundColor: "#f2f2f2",
    borderRadius: 10,
    marginBottom: 10,
  },
  text: { fontSize: 18, fontWeight: "700", color: "#111" },
});
