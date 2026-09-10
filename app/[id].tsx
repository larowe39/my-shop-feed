// app/[id].tsx
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo } from "react";
import {
  Alert,
  Image,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAuth } from "../hooks/AuthContext";
import { useProducts } from "../hooks/ProductsContext";

export default function ProductDetailsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const {
    products,
    likedIds,
    savedIds,
    isLikePending,
    isSavePending,
    toggleLike,
    toggleSave,
  } = useProducts();

  const product = useMemo(() => {
    return products.find((p: any) => String(p.id) === String(id));
  }, [products, id]);

  if (!product) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.header}>Not found</Text>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>Go back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const liked = likedIds.includes(product.id);
  const saved = savedIds.includes(product.id);
  const isOwner = String(product.user_id ?? "") === String(user?.id ?? "");
  const likePending = isLikePending(product.id);
  const savePending = isSavePending(product.id);

  const requireAuth = () => {
    if (user) return true;
    Alert.alert("Sign in required", "Please sign in to like or save products.");
    return false;
  };

  return (
    <SafeAreaView style={styles.container}>
      <Pressable style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backText}>← Back</Text>
      </Pressable>

      <View style={styles.imageWrap}>
        {product.image_url ? (
          <Image source={{ uri: product.image_url }} style={styles.image} />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Text style={styles.imagePlaceholderText}>No Image</Text>
          </View>
        )}
      </View>

      <View style={styles.content}>
        <Text style={styles.brand}>{product.brand}</Text>
        <Text style={styles.title}>{product.title}</Text>

        {!!product.category && (
          <Text style={styles.meta}>Category: {product.category}</Text>
        )}

        {!!product.price && (
          <Text style={styles.price}>
            {String(product.price)}
          </Text>
        )}

        {isOwner ? (
          <Pressable
            style={styles.editBtn}
            onPress={() => router.push(`/edit/${encodeURIComponent(String(product.id))}`)}
          >
            <Text style={styles.editBtnText}>Edit Product</Text>
          </Pressable>
        ) : null}

        <View style={styles.row}>
          <Pressable
            style={[styles.btn, !product.url && styles.btnDisabled]}
            disabled={!product.url}
            onPress={() => product.url && Linking.openURL(product.url)}
          >
            <Text style={styles.btnText}>
              {product.url ? "Open Link" : "No Link"}
            </Text>
          </Pressable>

          <Pressable
            style={[styles.reactionBtn, likePending && styles.btnDisabled]}
            disabled={likePending}
            onPress={async () => {
              if (!requireAuth()) return;
              const result = await toggleLike(product.id);
              if (result === "error") {
                Alert.alert("Like failed", "We couldn't update your like just now.");
              }
            }}
          >
            <Text style={[styles.reactionText, liked && styles.likeTextLiked]}>
              {liked ? "♥ Liked" : "♡ Like"}
            </Text>
          </Pressable>

          <Pressable
            style={[styles.reactionBtn, savePending && styles.btnDisabled]}
            disabled={savePending}
            onPress={async () => {
              if (!requireAuth()) return;
              const result = await toggleSave(product.id);
              if (result === "error") {
                Alert.alert("Save failed", "We couldn't update your save just now.");
              }
            }}
          >
            <Text style={[styles.reactionText, saved && styles.saveTextActive]}>
              {saved ? "★ Saved" : "☆ Save"}
            </Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: { fontSize: 18, fontWeight: "700", marginTop: 16, textAlign: "center" },

  backBtn: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10 },
  backText: { fontSize: 16, color: "#111", fontWeight: "600" },

  imageWrap: {
    width: "100%",
    aspectRatio: 4 / 3,
    backgroundColor: "#eee",
  },
  image: { width: "100%", height: "100%" },
  imagePlaceholder: { flex: 1, alignItems: "center", justifyContent: "center" },
  imagePlaceholderText: { color: "#777", fontWeight: "600" },

  content: { paddingHorizontal: 16, paddingTop: 14 },
  brand: { fontSize: 12, textTransform: "uppercase", color: "#777" },
  title: { fontSize: 26, fontWeight: "800", marginTop: 6, color: "#111" },
  meta: { marginTop: 10, color: "#444", fontSize: 16 },
  price: { marginTop: 10, fontSize: 18, fontWeight: "800", color: "#111" },
  editBtn: {
    marginTop: 14,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  editBtnText: { color: "#111", fontWeight: "700" },

  row: { flexDirection: "row", alignItems: "center", marginTop: 16, gap: 12 },

  btn: {
    flex: 1,
    backgroundColor: "#111",
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: "#fff", fontWeight: "700" },

  reactionBtn: {
    minWidth: 92,
    height: 44,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#ddd",
    paddingHorizontal: 14,
  },
  reactionText: { fontSize: 16, color: "#999", fontWeight: "700" },
  likeTextLiked: { color: "#e0245e" },
  saveTextActive: { color: "#111" },
});
