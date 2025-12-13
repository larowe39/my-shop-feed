import React, { useMemo } from "react";
import {
  FlatList,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useProducts } from "../hooks/ProductsContext";

export default function FeedScreen() {
  const { products, likedIds, toggleLike } = useProducts();

  const sortedProducts = useMemo(() => {
    return [...products].sort((a, b) => {
      const aLiked = likedIds.includes(a.id);
      const bLiked = likedIds.includes(b.id);
      if (aLiked === bLiked) return 0;
      return aLiked ? -1 : 1;
    });
  }, [products, likedIds]);

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.header}>PENCHANT</Text>
      <Text style={styles.subheader}>For You · Based on your likes</Text>

      <FlatList
        data={sortedProducts}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          const liked = likedIds.includes(item.id);

          return (
            <Pressable
              onPress={() => item.url && Linking.openURL(item.url)}
              style={styles.card}
            >
              <View style={styles.imagePlaceholder}>
                <Text style={styles.imageText}>IMG</Text>
              </View>

              <View style={styles.cardText}>
                <Text style={styles.brand}>{item.brand}</Text>
                <Text style={styles.title}>{item.title}</Text>
                <Text style={styles.price}>{item.price}</Text>
              </View>

              <Pressable
                style={styles.likeButton}
                onPress={(e) => {
                  e.stopPropagation();
                  toggleLike(item.id);
                }}
              >
                <Text
                  style={[
                    styles.likeText,
                    liked && styles.likeTextLiked,
                  ]}
                >
                  {liked ? "♥" : "♡"}
                </Text>
              </Pressable>
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f5f5" },
  header: {
    fontSize: 24,
    fontWeight: "bold",
    letterSpacing: 2,
    textAlign: "center",
    marginTop: 16,
  },
  subheader: { textAlign: "center", color: "#666", marginBottom: 12 },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  card: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    flexDirection: "row",
    alignItems: "center",
    elevation: 2,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  imagePlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 8,
    backgroundColor: "#ddd",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  imageText: { fontWeight: "bold", color: "#555" },
  cardText: { flex: 1 },
  brand: { fontSize: 12, textTransform: "uppercase", color: "#999" },
  title: { fontSize: 16, fontWeight: "600", marginTop: 2 },
  price: { marginTop: 4, fontWeight: "bold", color: "#111" },
  likeButton: { paddingHorizontal: 8, paddingVertical: 4 },
  likeText: { fontSize: 20, color: "#999" },
  likeTextLiked: { color: "#e0245e" },
});
