// app/(tabs)/index.tsx
import React from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../hooks/AuthContext";
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
  const router = useRouter();
  const { user } = useAuth();
  const {
    products,
    sellerProfiles,
    likedIds,
    savedIds,
    isLikePending,
    isSavePending,
    toggleLike,
    toggleSave,
    loading,
    error,
    reactionError,
  } = useProducts();

  const requireAuth = () => {
    if (user) return true;
    Alert.alert("Sign in required", "Please sign in to like or save products.");
    return false;
  };

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
      {!!reactionError && <Text style={styles.reactionError}>{reactionError}</Text>}
      <FlatList
        data={products}
        keyExtractor={(item) => String(item.id)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
        renderItem={({ item }) => {
          const uri = safeImageUri((item as any).image_url);
          const sellerProfile = item.user_id ? sellerProfiles[item.user_id] : undefined;
          const sellerName = sellerProfile?.display_name?.trim() || item.brand || "Seller";
          const sellerAvatarUri = safeImageUri(sellerProfile?.avatar_url);
          const link = (item as any).url?.trim?.() || "";
          const liked = likedIds.includes(item.id);
          const saved = savedIds.includes(item.id);
          const likePending = isLikePending(item.id);
          const savePending = isSavePending(item.id);

          return (
            <Pressable
              style={styles.card}
              onPress={() => router.push(`/${encodeURIComponent(String(item.id))}`)}
            >
              {/* header */}
              <View style={styles.header}>
                <Pressable
                  style={styles.sellerButton}
                  disabled={!item.user_id}
                  onPress={(event) => {
                    event.stopPropagation();
                    if (!item.user_id) return;
                    router.push(`/seller/${encodeURIComponent(item.user_id)}`);
                  }}
                >
                  {sellerAvatarUri ? (
                    <Image source={{ uri: sellerAvatarUri }} style={styles.avatarImage} />
                  ) : (
                    <View style={styles.avatar} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.brand}>{sellerName}</Text>
                    <Text style={styles.category}>{item.category}</Text>
                  </View>
                </Pressable>
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

                <View style={styles.actionsRow}>
                  <Pressable
                    style={[styles.actionBtn, likePending && styles.actionBtnDisabled]}
                    disabled={likePending}
                    accessibilityRole="button"
                    accessibilityLabel={liked ? "Unlike product" : "Like product"}
                    accessibilityState={{ disabled: likePending, selected: liked }}
                    onPress={async (event) => {
                      event.stopPropagation();
                      if (!requireAuth()) return;
                      const result = await toggleLike(item.id);
                      if (result === "error") {
                        Alert.alert("Like failed", "We couldn't update your like just now.");
                      }
                    }}
                  >
                    <Text style={[styles.actionText, liked && styles.actionTextLiked]}>
                      {liked ? "♥ Liked" : "♡ Like"}
                    </Text>
                  </Pressable>

                  <Pressable
                    style={[styles.actionBtn, savePending && styles.actionBtnDisabled]}
                    disabled={savePending}
                    accessibilityRole="button"
                    accessibilityLabel={saved ? "Remove saved product" : "Save product"}
                    accessibilityState={{ disabled: savePending, selected: saved }}
                    onPress={async (event) => {
                      event.stopPropagation();
                      if (!requireAuth()) return;
                      const result = await toggleSave(item.id);
                      if (result === "error") {
                        Alert.alert("Save failed", "We couldn't update your save just now.");
                      }
                    }}
                  >
                    <Text style={[styles.actionText, saved && styles.actionTextSaved]}>
                      {saved ? "★ Saved" : "☆ Save"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            </Pressable>
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
  sellerButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#ddd",
  },
  avatarImage: {
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
  actionsRow: { flexDirection: "row", gap: 10, marginTop: 8 },
  actionBtn: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  actionBtnDisabled: { opacity: 0.5 },
  actionText: { color: "#666", fontWeight: "700" },
  actionTextLiked: { color: "#e0245e" },
  actionTextSaved: { color: "#111" },
  reactionError: { color: "#b00020", fontSize: 12, marginHorizontal: 14, marginTop: 12 },

  errorTitle: { fontSize: 18, fontWeight: "700", color: "#b00020" },
  errorText: { color: "#b00020", paddingHorizontal: 20, textAlign: "center" },
});
