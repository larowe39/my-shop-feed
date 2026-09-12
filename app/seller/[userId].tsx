import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { ProductGrid } from "../../components/ProductGrid";
import { useAuth } from "../../hooks/AuthContext";
import type { Product } from "../../hooks/ProductsContext";
import { supabase } from "../../lib/supabase";

type SellerProfile = {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
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

export default function SellerProfileScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { userId } = useLocalSearchParams<{ userId?: string | string[] }>();
  const sellerId = useMemo(() => {
    const raw = Array.isArray(userId) ? userId[0] : userId;
    return String(raw ?? "").trim();
  }, [userId]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [followPending, setFollowPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);

  const isOwnProfile = Boolean(user?.id && sellerId && user.id === sellerId);

  const loadSeller = useCallback(
    async (isPullToRefresh = false) => {
      if (!sellerId) {
        setError("Missing seller id.");
        setLoading(false);
        return;
      }

      if (!isPullToRefresh) {
        setLoading(true);
      }
      setError(null);

      try {
        const [
          { data: profileData, error: profileError },
          { data: productData, error: productsError },
          { count: followers, error: followersError },
          { count: following, error: followingError },
        ] = await Promise.all([
          supabase
            .from("user_profiles")
            .select("user_id, display_name, avatar_url, bio")
            .eq("user_id", sellerId)
            .maybeSingle(),
          supabase
            .from("products")
            .select("*")
            .eq("user_id", sellerId)
            .order("created_at", { ascending: false }),
          supabase
            .from("user_follows")
            .select("follower_id", { count: "exact", head: true })
            .eq("following_id", sellerId),
          supabase
            .from("user_follows")
            .select("following_id", { count: "exact", head: true })
            .eq("follower_id", sellerId),
        ]);

        if (profileError) throw profileError;
        if (productsError) throw productsError;
        if (followersError) throw followersError;
        if (followingError) throw followingError;

        const typedProducts = (productData as Product[] | null) ?? [];
        const fallbackName = typedProducts[0]?.brand?.trim() || "Seller";
        setProfile(
          profileData
            ? (profileData as SellerProfile)
            : {
                user_id: sellerId,
                display_name: fallbackName,
                avatar_url: null,
                bio: null,
              }
        );
        setProducts(typedProducts);
        setFollowerCount(followers ?? 0);
        setFollowingCount(following ?? 0);

        if (user?.id && user.id !== sellerId) {
          const { data: followData, error: followError } = await supabase
            .from("user_follows")
            .select("follower_id")
            .eq("follower_id", user.id)
            .eq("following_id", sellerId)
            .maybeSingle();

          if (followError) throw followError;
          setIsFollowing(!!followData);
        } else {
          setIsFollowing(false);
        }
      } catch (loadError: any) {
        console.log("Error loading seller profile", loadError);
        setError(loadError?.message ?? "Failed to load seller profile.");
        setProducts([]);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [sellerId, user?.id]
  );

  useFocusEffect(
    useCallback(() => {
      loadSeller();
    }, [loadSeller])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadSeller(true);
  }, [loadSeller]);

  const onToggleFollow = async () => {
    if (!user) {
      Alert.alert(
        "Sign in required",
        "Please sign in to follow sellers.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Sign In", onPress: () => router.push("/sign-in") },
        ]
      );
      return;
    }
    if (!sellerId || user.id === sellerId || followPending) return;

    const wasFollowing = isFollowing;
    setFollowPending(true);
    setIsFollowing(!wasFollowing);
    setFollowerCount((prev) => Math.max(0, prev + (wasFollowing ? -1 : 1)));

    try {
      if (wasFollowing) {
        const { error: unfollowError } = await supabase
          .from("user_follows")
          .delete()
          .eq("follower_id", user.id)
          .eq("following_id", sellerId);

        if (unfollowError) throw unfollowError;
      } else {
        const { error: followError } = await supabase.from("user_follows").insert({
          follower_id: user.id,
          following_id: sellerId,
        });

        if (followError) throw followError;
      }
    } catch (followError) {
      console.log("Error toggling follow", followError);
      setIsFollowing(wasFollowing);
      setFollowerCount((prev) => Math.max(0, prev + (wasFollowing ? 1 : -1)));
      Alert.alert("Follow failed", "We couldn't update this follow right now.");
    } finally {
      setFollowPending(false);
    }
  };

  const avatarUri = safeImageUri(profile?.avatar_url);

  if (loading && !refreshing) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#111" />
        <Text style={styles.muted}>Loading seller profile…</Text>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.errorTitle}>Profile Error</Text>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backText}>Go back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Top App Bar */}
      <View style={styles.navBar}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={22} color="#111" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.navTitle} numberOfLines={1}>
          {profile?.display_name ?? "Seller Profile"}
        </Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* Profile Header */}
        <View style={styles.header}>
          <View style={styles.avatarWrapper}>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarPlaceholderText}>
                  {(profile?.display_name ?? "S").charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.profileDetails}>
            <Text style={styles.name}>{profile?.display_name ?? "Seller"}</Text>
            {!!profile?.bio && <Text style={styles.bio}>{profile.bio}</Text>}
          </View>
        </View>

        {/* Horizontal Stats Row */}
        <View style={styles.statsCard}>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>{products.length}</Text>
            <Text style={styles.statLabel}>Products</Text>
          </View>

          <View style={styles.statDivider} />

          <Pressable
            style={({ pressed }) => [
              styles.statItem,
              styles.statItemPressable,
              pressed && styles.statItemPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`View ${followerCount} followers`}
            onPress={() => {
              router.push({
                pathname: "/seller-follows",
                params: { userId: sellerId, type: "followers" },
              });
            }}
          >
            <Text style={styles.statNumber}>{followerCount}</Text>
            <Text style={styles.statLabel}>Followers</Text>
          </Pressable>

          <View style={styles.statDivider} />

          <Pressable
            style={({ pressed }) => [
              styles.statItem,
              styles.statItemPressable,
              pressed && styles.statItemPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`View ${followingCount} following`}
            onPress={() => {
              router.push({
                pathname: "/seller-follows",
                params: { userId: sellerId, type: "following" },
              });
            }}
          >
            <Text style={styles.statNumber}>{followingCount}</Text>
            <Text style={styles.statLabel}>Following</Text>
          </Pressable>
        </View>

        {/* Action Button: Follow/Following or Edit Profile */}
        {isOwnProfile ? (
          <Pressable
            style={styles.editProfileButton}
            onPress={() => router.push("/edit-profile")}
          >
            <Ionicons name="pencil-outline" size={16} color="#111" />
            <Text style={styles.editProfileButtonText}>Edit Profile</Text>
          </Pressable>
        ) : (
          <Pressable
            style={[
              styles.followButton,
              isFollowing && styles.followingButton,
              followPending && styles.buttonDisabled,
            ]}
            disabled={followPending}
            onPress={onToggleFollow}
          >
            {followPending ? (
              <ActivityIndicator
                size="small"
                color={isFollowing ? "#111" : "#fff"}
              />
            ) : (
              <>
                {isFollowing && (
                  <Ionicons
                    name="checkmark-outline"
                    size={16}
                    color="#111"
                    style={{ marginRight: 4 }}
                  />
                )}
                <Text
                  style={[
                    styles.followButtonText,
                    isFollowing && styles.followingButtonText,
                  ]}
                >
                  {isFollowing ? "Following" : "Follow"}
                </Text>
              </>
            )}
          </Pressable>
        )}

        {/* Products Section Header */}
        <View style={styles.productsHeader}>
          <Text style={styles.productsTitle}>Products</Text>
          <Text style={styles.productsCount}>{products.length}</Text>
        </View>

        {/* 2-Column Product Grid */}
        <ProductGrid
          products={products}
          onPressProduct={(product) =>
            router.push(`/${encodeURIComponent(String(product.id))}`)
          }
          emptyTitle="No products yet"
          emptyDescription="This seller hasn’t uploaded any products yet."
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 32,
    gap: 16,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
    backgroundColor: "#fff",
  },
  muted: {
    color: "#666",
    fontSize: 14,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#b00020",
  },
  errorText: {
    color: "#b00020",
    textAlign: "center",
    fontSize: 14,
  },
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minWidth: 60,
  },
  backText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111",
  },
  navTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111",
    maxWidth: 180,
    textAlign: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  avatarWrapper: {
    width: 84,
    height: 84,
    borderRadius: 42,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    overflow: "hidden",
    backgroundColor: "#f5f5f5",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
    borderRadius: 42,
    backgroundColor: "#f0f0f0",
  },
  avatarPlaceholder: {
    width: "100%",
    height: "100%",
    borderRadius: 42,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ececec",
  },
  avatarPlaceholderText: {
    fontSize: 32,
    fontWeight: "800",
    color: "#777",
  },
  profileDetails: {
    flex: 1,
    gap: 6,
  },
  name: {
    fontSize: 22,
    fontWeight: "800",
    color: "#111",
    letterSpacing: -0.3,
  },
  bio: {
    color: "#555",
    fontSize: 14,
    lineHeight: 20,
  },
  statsCard: {
    flexDirection: "row",
    backgroundColor: "#fafafa",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ececec",
    paddingVertical: 14,
    paddingHorizontal: 6,
    alignItems: "center",
  },
  statItem: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 4,
  },
  statItemPressable: {
    borderRadius: 8,
  },
  statItemPressed: {
    opacity: 0.6,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: "#e5e5e5",
  },
  statNumber: {
    fontSize: 18,
    fontWeight: "800",
    color: "#111",
  },
  statLabel: {
    fontSize: 12,
    color: "#666",
    fontWeight: "600",
  },
  followButton: {
    flexDirection: "row",
    borderRadius: 12,
    backgroundColor: "#111",
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  followingButton: {
    backgroundColor: "#f3f3f3",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  followButtonText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 15,
  },
  followingButtonText: {
    color: "#111",
  },
  editProfileButton: {
    flexDirection: "row",
    borderRadius: 12,
    backgroundColor: "#fafafa",
    borderWidth: 1,
    borderColor: "#ddd",
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  editProfileButtonText: {
    color: "#111",
    fontWeight: "700",
    fontSize: 15,
  },
  productsHeader: {
    marginTop: 6,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  productsTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#111",
  },
  productsCount: {
    minWidth: 28,
    textAlign: "center",
    fontSize: 13,
    fontWeight: "700",
    color: "#333",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
});
