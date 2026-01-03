// app/(tabs)/index.tsx
import React from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useProducts } from "../../hooks/ProductsContext";

function safeImageUri(uri?: string | null) {
  const u = (uri ?? "").trim();
  if (!u) return null;

  // If the URL contains characters RN chokes on (spaces, etc), encode it safely.
  // encodeURI keeps : / ? & = intact.
  try {
    return encodeURI(u);
  } catch {
    return u;
  }
}

export default function FeedScreen() {
  const { products, loading, error } = useProducts();

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Loading feed…</Text>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.errorTitle}>Feed Error</Text>
        <Text style={styles.errorText}>{error}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={products}
        keyExtractor={(item) => String(item.id)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => {
          const uri = safeImageUri((item as any).image_url);
          const link = (item as any).url?.trim?.() || "";

          return (
            <View style={styles.card}>
              {/* header */}
              <View style={styles.header}>
                <View style={styles.avatar} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.brand}>{item.brand || "PENCHANT"}</Text>
                  <Text style={styles.category}>{item.category}</Text>
                </View>
              </View>

              {/* image */}
              <View style={styles.imageWrap}>
                {!!uri ? (
                  <Image
                    source={{ uri }}
                    style={styles.image}
                    resizeMode="cover"
                    onError={(e) => {
                      console.log("Image failed:", {
                        id: String(item.id),
                        uri,
                        error: (e as any)?.nativeEvent,
                      });
                    }}
                  />
                ) : (
                  <View style={[styles.image, styles.imagePlaceholder]}>
                    <Text style={styles.muted}>No image</Text>
                  </View>
                )}
              </View>

              {/* caption */}
              <View style={styles.caption}>
                <Text style={styles.title}>{item.title}</Text>
                {!!item.price && <Text style={styles.price}>${item.price}</Text>}

                {!!link ? (
                  <Pressable
                    onPress={async () => {
                      try {
                        const ok = await Linking.canOpenURL(link);
                        if (ok) await Linking.openURL(link);
                      } catch (err) {
                        console.log("Open url failed:", err);
                      }
                    }}
                  >
                    <Text style={styles.url}>{link}</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          );
        }}
        ListEmptyComponent={
          <View style={styles.center}>
            <Text style={styles.muted}>No posts yet.</Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  muted: { color: "#666" },

  card: { paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: "#eee" },

  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 10,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#ddd",
  },
  brand: { fontWeight: "700", fontSize: 14, color: "#111" },
  category: { fontSize: 12, color: "#777", marginTop: 2 },

  imageWrap: { backgroundColor: "#f6f6f6" },
  image: { width: "100%", height: 420 },
  imagePlaceholder: { alignItems: "center", justifyContent: "center" },

  caption: { paddingHorizontal: 14, paddingTop: 10, gap: 4 },
  title: { fontSize: 14, color: "#111" },
  price: { fontSize: 13, color: "#111", fontWeight: "600" },
  url: { fontSize: 12, color: "#0a66c2" },

  errorTitle: { fontSize: 18, fontWeight: "700", color: "#b00020" },
  errorText: { color: "#b00020", paddingHorizontal: 20, textAlign: "center" },
});
