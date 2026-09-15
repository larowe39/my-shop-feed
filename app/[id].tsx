// app/[id].tsx
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useMemo } from "react";
import {
  Alert,
  Linking,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useAuth } from "../hooks/AuthContext";
import { useProducts } from "../hooks/ProductsContext";
import { trackEvent } from "../lib/analytics";
import { ModeratedProductImage } from "../components/ModeratedProductImage";
import { ReportProductModal } from "../components/ReportProductModal";

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
    reactionError,
  } = useProducts();
  const [reportVisible, setReportVisible] = React.useState(false);

  const product = useMemo(() => {
    return products.find((p: any) => String(p.id) === String(id));
  }, [products, id]);

  // Record a single dwell event with elapsed time when leaving this screen,
  // rather than pinging the database on an interval.
  useFocusEffect(
    useCallback(() => {
      const openedAt = Date.now();
      return () => {
        if (!product) return;
        const durationMs = Date.now() - openedAt;
        if (durationMs <= 0) return;
        trackEvent({
          eventType: "product_dwell",
          productId: product.id,
          sellerId: product.user_id ?? null,
          category: product.category ?? null,
          metadata: { duration_ms: durationMs, source: "product_detail" },
        });
      };
    }, [product])
  );

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
          <ModeratedProductImage
            uri={product.image_url}
            style={styles.image}
            moderation={product.moderation}
            productId={product.id}
            sellerId={product.user_id}
          />
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

        {!!product.catalog_product_id && (
          <View style={styles.catalogBadge}>
            <Text style={styles.catalogBadgeText}>✓ Verified product</Text>
          </View>
        )}

        {!!product.price && (
          <Text style={styles.price}>
            {String(product.price)}
          </Text>
        )}

        {!!reactionError && <Text style={styles.reactionError}>{reactionError}</Text>}

        {isOwner && (product.moderation?.is_hidden || product.moderation?.is_blurred) ? (
          <Text style={styles.moderationNotice}>
            This product is limited due to automated moderation.
          </Text>
        ) : null}

        {isOwner ? (
          <Pressable
            style={styles.editBtn}
            onPress={() => router.push(`/edit/${encodeURIComponent(String(product.id))}`)}
          >
            <Text style={styles.editBtnText}>Edit Product</Text>
          </Pressable>
        ) : null}

        {!isOwner && user ? (
          <Pressable style={styles.reportBtn} onPress={() => setReportVisible(true)}>
            <Text style={styles.reportBtnText}>Report</Text>
          </Pressable>
        ) : null}

        <View style={styles.row}>
          <Pressable
            style={[styles.btn, !product.url && styles.btnDisabled]}
            disabled={!product.url}
            onPress={() => {
              if (!product.url) return;
              trackEvent({
                eventType: "shop_click",
                productId: product.id,
                sellerId: product.user_id ?? null,
                category: product.category ?? null,
                metadata: { source: "product_detail" },
              });
              Linking.openURL(product.url);
            }}
          >
            <Text style={styles.btnText}>
              {product.url ? "Open Link" : "No Link"}
            </Text>
          </Pressable>

          <Pressable
            style={[styles.reactionBtn, likePending && styles.btnDisabled]}
            disabled={likePending}
            accessibilityRole="button"
            accessibilityLabel={liked ? "Unlike product" : "Like product"}
            accessibilityState={{ disabled: likePending, selected: liked }}
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
            accessibilityRole="button"
            accessibilityLabel={saved ? "Remove saved product" : "Save product"}
            accessibilityState={{ disabled: savePending, selected: saved }}
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
      <ReportProductModal visible={reportVisible} productId={product.id} onClose={() => setReportVisible(false)} />
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
  catalogBadge: {
    alignSelf: "flex-start",
    marginTop: 10,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: "#f0fdf4",
    borderWidth: 1,
    borderColor: "#bbf7d0",
  },
  catalogBadgeText: { color: "#166534", fontSize: 12, fontWeight: "700" },
  price: { marginTop: 10, fontSize: 18, fontWeight: "800", color: "#111" },
  reactionError: { marginTop: 10, color: "#b00020", fontSize: 13 },
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
  reportBtn: { marginTop: 18, alignSelf: "flex-start", paddingVertical: 6 },
  reportBtnText: { color: "#b00020", fontWeight: "700" },
  moderationNotice: { marginTop: 12, color: "#7a3d00", fontSize: 13 },
});
