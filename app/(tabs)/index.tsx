// app/(tabs)/index.tsx
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ProductFeedCard } from "../../components/ProductFeedCard";
import { useAuth } from "../../hooks/AuthContext";
import { type Product, useProducts } from "../../hooks/ProductsContext";

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
    refresh,
  } = useProducts();

  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const requireAuth = useCallback(() => {
    if (user) return true;
    Alert.alert("Sign in required", "Please sign in to like or save products.");
    return false;
  }, [user]);

  const handleLike = useCallback(
    async (productId: string) => {
      if (!requireAuth()) return;
      const result = await toggleLike(productId);
      if (result === "error") {
        Alert.alert("Like failed", "We couldn't update your like just now.");
      }
    },
    [requireAuth, toggleLike]
  );

  const handleSave = useCallback(
    async (productId: string) => {
      if (!requireAuth()) return;
      const result = await toggleSave(productId);
      if (result === "error") {
        Alert.alert("Save failed", "We couldn't update your save just now.");
      }
    },
    [requireAuth, toggleSave]
  );

  const renderProductItem = useCallback(
    ({ item }: { item: Product }) => {
      const sellerProfile = item.user_id ? sellerProfiles[item.user_id] : undefined;
      const isLiked = likedIds.includes(item.id);
      const isSaved = savedIds.includes(item.id);
      const likePending = isLikePending(item.id);
      const savePending = isSavePending(item.id);

      return (
        <ProductFeedCard
          product={item}
          sellerProfile={sellerProfile}
          isLiked={isLiked}
          isSaved={isSaved}
          isLikePending={likePending}
          isSavePending={savePending}
          onLikePress={() => handleLike(item.id)}
          onSavePress={() => handleSave(item.id)}
          onSellerPress={
            item.user_id
              ? () => router.push(`/seller/${encodeURIComponent(item.user_id!)}`)
              : undefined
          }
          onProductPress={() =>
            router.push(`/${encodeURIComponent(String(item.id))}`)
          }
        />
      );
    },
    [
      sellerProfiles,
      likedIds,
      savedIds,
      isLikePending,
      isSavePending,
      handleLike,
      handleSave,
      router,
    ]
  );

  if (loading && !refreshing && products.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.topHeader}>
          <View style={styles.headerContent}>
            <View>
              <Text style={styles.brandTitle}>PENCHANT</Text>
              <Text style={styles.brandSubtitle}>CURATED SHOPPING</Text>
            </View>
          </View>
        </View>
        <View style={styles.center}>
          <ActivityIndicator size="small" color="#18181b" />
          <Text style={styles.loadingText}>Loading feed…</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error && products.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        <View style={styles.topHeader}>
          <View style={styles.headerContent}>
            <Text style={styles.brandTitle}>PENCHANT</Text>
          </View>
        </View>
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={44} color="#dc2626" />
          <Text style={styles.errorTitle}>Unable to load feed</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={refresh}>
            <Text style={styles.retryButtonText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />

      {/* App Header */}
      <View style={styles.topHeader}>
        <View style={styles.headerContent}>
          <View>
            <Text style={styles.brandTitle}>PENCHANT</Text>
            <Text style={styles.brandSubtitle}>CURATED FEED</Text>
          </View>
          <Pressable
            style={styles.headerIconButton}
            onPress={() => router.push("/categories")}
            accessibilityRole="button"
            accessibilityLabel="Explore categories"
          >
            <Ionicons name="grid-outline" size={20} color="#18181b" />
          </Pressable>
        </View>
      </View>

      {!!reactionError && (
        <View style={styles.reactionErrorBanner}>
          <Ionicons name="information-circle" size={16} color="#b91c1c" />
          <Text style={styles.reactionErrorText}>{reactionError}</Text>
        </View>
      )}

      <FlatList
        data={products}
        keyExtractor={(item) => String(item.id)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        renderItem={renderProductItem}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor="#18181b"
            colors={["#18181b"]}
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconContainer}>
              <Ionicons name="bag-handle-outline" size={36} color="#71717a" />
            </View>
            <Text style={styles.emptyTitle}>No posts yet</Text>
            <Text style={styles.emptyDescription}>
              Be the first to share curated fashion pieces with the community.
            </Text>
            <Pressable
              style={styles.emptyActionButton}
              onPress={() => router.push("/upload")}
            >
              <Text style={styles.emptyActionText}>Upload a product</Text>
            </Pressable>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  topHeader: {
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f2",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  headerContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    maxWidth: 580,
    width: "100%",
    alignSelf: "center",
  },
  brandTitle: {
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 4,
    color: "#09090b",
  },
  brandSubtitle: {
    fontSize: 9.5,
    fontWeight: "600",
    letterSpacing: 1.5,
    color: "#71717a",
    marginTop: 1,
  },
  headerIconButton: {
    padding: 6,
    borderRadius: 8,
  },
  listContent: {
    paddingBottom: 32,
    backgroundColor: "#ffffff",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 24,
  },
  loadingText: {
    color: "#71717a",
    fontSize: 13,
    fontWeight: "500",
  },
  reactionErrorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fef2f2",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#fee2e2",
  },
  reactionErrorText: {
    color: "#b91c1c",
    fontSize: 12.5,
    flex: 1,
  },
  errorTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#18181b",
    marginTop: 4,
  },
  errorText: {
    color: "#71717a",
    fontSize: 13.5,
    textAlign: "center",
    lineHeight: 19,
    maxWidth: 320,
  },
  retryButton: {
    marginTop: 8,
    backgroundColor: "#18181b",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
  },
  retryButtonText: {
    color: "#ffffff",
    fontWeight: "600",
    fontSize: 13,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
    paddingHorizontal: 32,
    maxWidth: 400,
    alignSelf: "center",
    gap: 10,
  },
  emptyIconContainer: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: "#f4f4f5",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#18181b",
  },
  emptyDescription: {
    fontSize: 13.5,
    color: "#71717a",
    textAlign: "center",
    lineHeight: 20,
  },
  emptyActionButton: {
    marginTop: 12,
    backgroundColor: "#18181b",
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: 999,
  },
  emptyActionText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "600",
  },
});

