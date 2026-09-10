import React from "react";
import { FlatList, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { Product } from "../hooks/ProductsContext";

type ProductGridProps = {
  products: Product[];
  onPressProduct: (product: Product) => void;
  emptyTitle: string;
  emptyDescription: string;
};

function safeImageUri(uri?: string | null) {
  const value = (uri ?? "").trim();
  if (!value) return null;
  try {
    return encodeURI(value);
  } catch {
    return value;
  }
}

export function ProductGrid({
  products,
  onPressProduct,
  emptyTitle,
  emptyDescription,
}: ProductGridProps) {
  if (!products.length) {
    return (
      <View style={styles.emptyCard}>
        <Text style={styles.emptyTitle}>{emptyTitle}</Text>
        <Text style={styles.emptyDescription}>{emptyDescription}</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={products}
      keyExtractor={(item) => item.id}
      numColumns={2}
      scrollEnabled={false}
      columnWrapperStyle={styles.row}
      contentContainerStyle={styles.content}
      renderItem={({ item }) => {
        const imageUri = safeImageUri(item.image_url);
        return (
          <Pressable style={styles.card} onPress={() => onPressProduct(item)}>
            {imageUri ? (
              <Image source={{ uri: imageUri }} style={styles.image} resizeMode="cover" />
            ) : (
              <View style={[styles.image, styles.imagePlaceholder]}>
                <Text style={styles.imagePlaceholderText}>No Image</Text>
              </View>
            )}
            <View style={styles.meta}>
              <Text style={styles.brand} numberOfLines={1}>
                {item.brand || "PENCHANT"}
              </Text>
              <Text style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              {!!item.price && <Text style={styles.price}>${item.price}</Text>}
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 24 },
  row: { gap: 12 },
  card: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#eee",
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#fff",
    marginBottom: 12,
  },
  image: {
    width: "100%",
    aspectRatio: 1,
    backgroundColor: "#f3f3f3",
  },
  imagePlaceholder: {
    alignItems: "center",
    justifyContent: "center",
  },
  imagePlaceholderText: {
    color: "#777",
    fontSize: 12,
    fontWeight: "600",
  },
  meta: {
    padding: 10,
    gap: 4,
  },
  brand: {
    fontSize: 11,
    fontWeight: "700",
    color: "#888",
    textTransform: "uppercase",
  },
  title: {
    fontSize: 13,
    color: "#111",
    fontWeight: "600",
    minHeight: 32,
  },
  price: {
    fontSize: 13,
    color: "#111",
    fontWeight: "800",
  },
  emptyCard: {
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 14,
    padding: 20,
    backgroundColor: "#fafafa",
    alignItems: "center",
    gap: 8,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "800",
    color: "#111",
  },
  emptyDescription: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 20,
  },
});
