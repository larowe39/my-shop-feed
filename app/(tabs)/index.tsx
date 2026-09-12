// app/(tabs)/index.tsx
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
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
import { rankForYouFeed } from "../../lib/feedRanking";

type FeedMode = "for_you" | "following";

export default function FeedScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const {
    products,
    sellerProfiles,
    likedIds,
    savedIds,
    followingIds,
    isLikePending,
    isSavePending,
    toggleLike,
    toggleSave,
    loading,
    error,
    reactionError,
    refresh,
  } = useProducts();

  const [activeFeedMode, setActiveFeedMode] = useState<FeedMode>("for_you");
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

  // Personalized discovery ranking for "FOR YOU" feed
  const forYouProducts = useMemo(() => {
    return rankForYouFeed(products, {
      likedIds,
      savedIds,
      followingIds,
      currentUserId: user?.id ?? null,
    });
  }, [products, likedIds, savedIds, followingIds, user?.id]);

  // Chronological newest-first feed of followed sellers for "FOLLOWING" feed
  const followingProducts = useMemo(() => {
    if (!user || followingIds.length === 0) return [];
    const followingSet = new Set(followingIds);
    return products.filter((p) => p.user_id && followingSet.has(p.user_id));
  }, [products, followingIds, user]);

  const displayedProducts =
    activeFeedMode === "for_you" ? forYouProducts : followingProducts;

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

  const renderEmptyState = () => {
    if (activeFeedMode === "following") {
      if (!user) {
        return (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconContainer}>
              <Ionicons name="person-add-outline" size={34} color="#71717a" />
            </View>
            <Text style={styles.emptyTitle}>Sign in to see Following</Text>
            <Text style={styles.emptyDescription}>
              Follow your favorite curators and sellers to see their newest drops and fashion finds here.
            </Text>
            <Pressable
              style={styles.emptyActionButton}
              onPress={() => router.push("/sign-in")}
              accessibilityRole="button"
              accessibilityLabel="Sign in to PENCHANT"
            >
              <Text style={styles.emptyActionText}>Sign in</Text>
            </Pressable>
          </View>
        );
      }

      if (followingIds.length === 0) {
        return (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconContainer}>
              <Ionicons name="people-outline" size={34} color="#71717a" />
            </View>
            <Text style={styles.emptyTitle}>{"You're not following anyone yet"}</Text>
            <Text style={styles.emptyDescription}>
              Follow creators and curators to build your personalized feed of their latest pieces.
            </Text>
            <Pressable
              style={styles.emptyActionButton}
              onPress={() => router.push("/categories")}
              accessibilityRole="button"
              accessibilityLabel="Explore categories"
            >
              <Text style={styles.emptyActionText}>Explore Categories</Text>
            </Pressable>
          </View>
        );
      }

      return (
        <View style={styles.emptyContainer}>
          <View style={styles.emptyIconContainer}>
            <Ionicons name="sparkles-outline" size={34} color="#71717a" />
          </View>
          <Text style={styles.emptyTitle}>No posts from followed sellers</Text>
          <Text style={styles.emptyDescription}>
            {"The sellers you follow haven't posted any products yet. Discover more curators or check back soon."}
          </Text>
          <Pressable
            style={styles.emptyActionButton}
            onPress={() => router.push("/categories")}
            accessibilityRole="button"
            accessibilityLabel="Explore categories"
          >
            <Text style={styles.emptyActionText}>Explore Categories</Text>
          </Pressable>
        </View>
      );
    }

    // For You empty state
    return (
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
          accessibilityRole="button"
          accessibilityLabel="Upload a product"
        >
          <Text style={styles.emptyActionText}>Upload a product</Text>
        </Pressable>
      </View>
    );
  };

  const renderHeader = () => (
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

      {/* Segmented Feed Mode Control */}
      <View style={styles.segmentedControlContainer}>
        <View style={styles.segmentedControl} accessibilityRole="tablist">
          <Pressable
            style={[
              styles.segmentButton,
              activeFeedMode === "for_you" && styles.segmentButtonActive,
            ]}
            onPress={() => setActiveFeedMode("for_you")}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeFeedMode === "for_you" }}
            accessibilityLabel="For You feed"
          >
            <Text
              style={[
                styles.segmentText,
                activeFeedMode === "for_you" && styles.segmentTextActive,
              ]}
            >
              FOR YOU
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.segmentButton,
              activeFeedMode === "following" && styles.segmentButtonActive,
            ]}
            onPress={() => setActiveFeedMode("following")}
            accessibilityRole="tab"
            accessibilityState={{ selected: activeFeedMode === "following" }}
            accessibilityLabel="Following feed"
          >
            <Text
              style={[
                styles.segmentText,
                activeFeedMode === "following" && styles.segmentTextActive,
              ]}
            >
              FOLLOWING
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );

  if (loading && !refreshing && products.length === 0) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar barStyle="dark-content" />
        {renderHeader()}
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
        {renderHeader()}
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

      {/* App Header with Segmented Control */}
      {renderHeader()}

      {!!reactionError && (
        <View style={styles.reactionErrorBanner}>
          <Ionicons name="information-circle" size={16} color="#b91c1c" />
          <Text style={styles.reactionErrorText}>{reactionError}</Text>
        </View>
      )}

      <FlatList
        data={displayedProducts}
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
        ListEmptyComponent={renderEmptyState}
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
    paddingTop: 12,
    paddingBottom: 10,
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
  segmentedControlContainer: {
    maxWidth: 580,
    width: "100%",
    alignSelf: "center",
    marginTop: 10,
  },
  segmentedControl: {
    flexDirection: "row",
    backgroundColor: "#f4f4f5",
    borderRadius: 999,
    padding: 3,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentButtonActive: {
    backgroundColor: "#ffffff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 2,
  },
  segmentText: {
    fontSize: 11.5,
    fontWeight: "600",
    letterSpacing: 1.2,
    color: "#71717a",
  },
  segmentTextActive: {
    color: "#09090b",
    fontWeight: "800",
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

