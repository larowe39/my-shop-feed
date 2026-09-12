// app/seller-follows.tsx
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { supabase } from "../lib/supabase";

type FollowUser = {
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

export default function SellerFollowsScreen() {
  const router = useRouter();
  const { userId, type } = useLocalSearchParams<{
    userId?: string | string[];
    type?: string | string[];
  }>();

  const sellerId = useMemo(() => {
    const raw = Array.isArray(userId) ? userId[0] : userId;
    return String(raw ?? "").trim();
  }, [userId]);

  const initialTab = useMemo(() => {
    const raw = Array.isArray(type) ? type[0] : type;
    return raw === "following" ? "following" : "followers";
  }, [type]);

  const [activeTab, setActiveTab] = useState<"followers" | "following">(initialTab);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sellerName, setSellerName] = useState<string>("Seller");

  const [followers, setFollowers] = useState<FollowUser[]>([]);
  const [following, setFollowing] = useState<FollowUser[]>([]);

  const loadData = useCallback(async () => {
    if (!sellerId) {
      setError("Missing user ID");
      setLoading(false);
      return;
    }

    try {
      setError(null);

      // Fetch seller profile to show their name in header
      const { data: sellerProf } = await supabase
        .from("user_profiles")
        .select("display_name")
        .eq("user_id", sellerId)
        .maybeSingle();

      if (sellerProf?.display_name) {
        setSellerName(sellerProf.display_name);
      }

      // Fetch followers and following IDs in parallel
      const [
        { data: followerRows, error: followerErr },
        { data: followingRows, error: followingErr },
      ] = await Promise.all([
        supabase
          .from("user_follows")
          .select("follower_id")
          .eq("following_id", sellerId),
        supabase
          .from("user_follows")
          .select("following_id")
          .eq("follower_id", sellerId),
      ]);

      if (followerErr) throw followerErr;
      if (followingErr) throw followingErr;

      const followerIds = (followerRows ?? []).map((r) => r.follower_id).filter(Boolean);
      const followingIds = (followingRows ?? []).map((r) => r.following_id).filter(Boolean);

      const allUserIds = Array.from(new Set([...followerIds, ...followingIds]));

      let profilesMap: Record<string, FollowUser> = {};

      if (allUserIds.length > 0) {
        const { data: profilesData, error: profilesErr } = await supabase
          .from("user_profiles")
          .select("user_id, display_name, avatar_url, bio")
          .in("user_id", allUserIds);

        if (profilesErr) throw profilesErr;

        for (const p of profilesData ?? []) {
          profilesMap[p.user_id] = {
            user_id: p.user_id,
            display_name: p.display_name || "Seller",
            avatar_url: p.avatar_url,
            bio: p.bio,
          };
        }
      }

      const mappedFollowers: FollowUser[] = followerIds.map((id) => {
        return (
          profilesMap[id] ?? {
            user_id: id,
            display_name: "Seller",
            avatar_url: null,
            bio: null,
          }
        );
      });

      const mappedFollowing: FollowUser[] = followingIds.map((id) => {
        return (
          profilesMap[id] ?? {
            user_id: id,
            display_name: "Seller",
            avatar_url: null,
            bio: null,
          }
        );
      });

      setFollowers(mappedFollowers);
      setFollowing(mappedFollowing);
    } catch (err: any) {
      console.log("Error loading follows data", err);
      setError(err?.message ?? "Failed to load follows list.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [sellerId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadData();
  }, [loadData]);

  const currentList = activeTab === "followers" ? followers : following;

  return (
    <SafeAreaView style={styles.container}>
      {/* Top App Bar */}
      <View style={styles.navBar}>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={22} color="#111" />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <Text style={styles.navTitle} numberOfLines={1}>
          {sellerName}
        </Text>
        <View style={{ width: 60 }} />
      </View>

      {/* Segmented Tab Header */}
      <View style={styles.tabContainer}>
        <Pressable
          style={[styles.tabButton, activeTab === "followers" && styles.tabButtonActive]}
          onPress={() => setActiveTab("followers")}
        >
          <Text
            style={[
              styles.tabButtonText,
              activeTab === "followers" && styles.tabButtonTextActive,
            ]}
          >
            Followers ({followers.length})
          </Text>
        </Pressable>

        <Pressable
          style={[styles.tabButton, activeTab === "following" && styles.tabButtonActive]}
          onPress={() => setActiveTab("following")}
        >
          <Text
            style={[
              styles.tabButtonText,
              activeTab === "following" && styles.tabButtonTextActive,
            ]}
          >
            Following ({following.length})
          </Text>
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#111" />
          <Text style={styles.muted}>Loading...</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={loadData}>
            <Text style={styles.retryBtnText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={currentList}
          keyExtractor={(item) => item.user_id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <View style={styles.emptyIconCircle}>
                <Ionicons
                  name={activeTab === "followers" ? "people-outline" : "person-add-outline"}
                  size={32}
                  color="#888"
                />
              </View>
              <Text style={styles.emptyTitle}>
                {activeTab === "followers" ? "No followers yet" : "Not following anyone yet"}
              </Text>
              <Text style={styles.emptyDescription}>
                {activeTab === "followers"
                  ? "When users follow this profile, they will show up here."
                  : "When this seller follows other accounts, they will appear here."}
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const avatarUri = safeImageUri(item.avatar_url);
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.userRow,
                  pressed && styles.userRowPressed,
                ]}
                onPress={() => {
                  router.push(`/seller/${encodeURIComponent(item.user_id)}`);
                }}
              >
                {avatarUri ? (
                  <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
                ) : (
                  <View style={styles.avatarPlaceholder}>
                    <Text style={styles.avatarPlaceholderText}>
                      {(item.display_name || "S").charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}

                <View style={styles.userInfo}>
                  <Text style={styles.userName} numberOfLines={1}>
                    {item.display_name}
                  </Text>
                  {!!item.bio && (
                    <Text style={styles.userBio} numberOfLines={1}>
                      {item.bio}
                    </Text>
                  )}
                </View>

                <Ionicons name="chevron-forward" size={18} color="#bbb" />
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  muted: {
    color: "#666",
    fontSize: 14,
  },
  errorText: {
    color: "#b00020",
    fontSize: 15,
    textAlign: "center",
    fontWeight: "600",
  },
  retryBtn: {
    marginTop: 8,
    backgroundColor: "#111",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 999,
  },
  retryBtnText: {
    color: "#fff",
    fontWeight: "700",
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
  tabContainer: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  tabButton: {
    flex: 1,
    paddingVertical: 14,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabButtonActive: {
    borderBottomColor: "#111",
  },
  tabButtonText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#777",
  },
  tabButtonTextActive: {
    color: "#111",
    fontWeight: "800",
  },
  listContent: {
    paddingVertical: 8,
    flexGrow: 1,
  },
  userRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f8f8f8",
  },
  userRowPressed: {
    backgroundColor: "#f9f9f9",
  },
  avatarImage: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#f0f0f0",
  },
  avatarPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#f0f0f0",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarPlaceholderText: {
    fontSize: 20,
    fontWeight: "700",
    color: "#666",
  },
  userInfo: {
    flex: 1,
    gap: 3,
  },
  userName: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111",
  },
  userBio: {
    fontSize: 13,
    color: "#666",
    lineHeight: 18,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingTop: 60,
    gap: 10,
  },
  emptyIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#f5f5f5",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 6,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111",
  },
  emptyDescription: {
    fontSize: 14,
    color: "#777",
    textAlign: "center",
    lineHeight: 20,
  },
});
