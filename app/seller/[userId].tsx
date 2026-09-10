import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
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
  const { userId } = useLocalSearchParams<{ userId?: string }>();
  const sellerId = useMemo(() => String(userId ?? "").trim(), [userId]);

  const [loading, setLoading] = useState(true);
  const [followPending, setFollowPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<SellerProfile | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [isFollowing, setIsFollowing] = useState(false);

  const loadSeller = useCallback(async () => {
    if (!sellerId) {
      setError("Missing seller id.");
      setLoading(false);
      return;
    }

    setLoading(true);
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
    }
  }, [sellerId, user?.id]);

  useEffect(() => {
    loadSeller();
  }, [loadSeller]);

  const onToggleFollow = async () => {
    if (!user) {
      Alert.alert("Sign in required", "Please sign in to follow sellers.");
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
  const isOwnProfile = user?.id && sellerId && user.id === sellerId;

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" />
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
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Pressable style={styles.backBtnInline} onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </Pressable>

        <View style={styles.header}>
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
          ) : (
            <View style={styles.avatarPlaceholder}>
              <Text style={styles.avatarPlaceholderText}>
                {(profile?.display_name ?? "S").charAt(0).toUpperCase()}
              </Text>
            </View>
          )}

          <View style={styles.headerText}>
            <Text style={styles.name}>{profile?.display_name ?? "Seller"}</Text>
            {!!profile?.bio && <Text style={styles.bio}>{profile.bio}</Text>}
          </View>
        </View>

        <View style={styles.countsRow}>
          <View style={styles.countCard}>
            <Text style={styles.countNumber}>{followerCount}</Text>
            <Text style={styles.countLabel}>Followers</Text>
          </View>
          <View style={styles.countCard}>
            <Text style={styles.countNumber}>{followingCount}</Text>
            <Text style={styles.countLabel}>Following</Text>
          </View>
        </View>

        {!isOwnProfile ? (
          <Pressable
            style={[styles.followButton, isFollowing && styles.followingButton, followPending && styles.buttonDisabled]}
            disabled={followPending}
            onPress={onToggleFollow}
          >
            <Text style={[styles.followButtonText, isFollowing && styles.followingButtonText]}>
              {isFollowing ? "Following" : "Follow"}
            </Text>
          </Pressable>
        ) : null}

        <View style={styles.productsHeader}>
          <Text style={styles.productsTitle}>Products</Text>
          <Text style={styles.productsCount}>{products.length}</Text>
        </View>

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
  container: { flex: 1, backgroundColor: "#fff" },
  content: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24, gap: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 20 },
  muted: { color: "#666" },
  errorTitle: { fontSize: 18, fontWeight: "700", color: "#b00020" },
  errorText: { color: "#b00020", textAlign: "center" },
  backBtn: {
    marginTop: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  backBtnInline: { alignSelf: "flex-start" },
  backText: { fontWeight: "700", color: "#111" },
  header: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatarImage: { width: 64, height: 64, borderRadius: 32, backgroundColor: "#ddd" },
  avatarPlaceholder: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ececec",
  },
  avatarPlaceholderText: { fontSize: 24, fontWeight: "800", color: "#777" },
  headerText: { flex: 1, gap: 6 },
  name: { fontSize: 22, fontWeight: "800", color: "#111" },
  bio: { color: "#555", lineHeight: 20 },
  countsRow: { flexDirection: "row", gap: 10 },
  countCard: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ececec",
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: "center",
    gap: 4,
  },
  countNumber: { fontSize: 18, fontWeight: "800", color: "#111" },
  countLabel: { fontSize: 12, color: "#666", fontWeight: "600" },
  followButton: {
    borderRadius: 999,
    backgroundColor: "#111",
    paddingVertical: 12,
    alignItems: "center",
  },
  followingButton: { backgroundColor: "#f3f3f3", borderWidth: 1, borderColor: "#ddd" },
  buttonDisabled: { opacity: 0.5 },
  followButtonText: { color: "#fff", fontWeight: "800" },
  followingButtonText: { color: "#111" },
  productsHeader: {
    marginTop: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  productsTitle: { fontSize: 20, fontWeight: "800", color: "#111" },
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
