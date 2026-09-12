// app/(tabs)/profile.tsx
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Image,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ProductGrid } from "../../components/ProductGrid";
import { useAuth } from "../../hooks/AuthContext";
import { useProducts } from "../../hooks/ProductsContext";
import { supabase } from "../../lib/supabase";

type UserProfile = {
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

export default function ProfileScreen() {
  const router = useRouter();
  const { user, loading, signOut } = useAuth();
  const { products, savedIds, loading: productsLoading, error, reactionError } = useProducts();
  const [profile, setProfile] = useState<UserProfile | null>(null);

  const fetchProfile = useCallback(async () => {
    if (!user?.id) return;
    try {
      const { data } = await supabase
        .from("user_profiles")
        .select("display_name, avatar_url, bio")
        .eq("user_id", user.id)
        .maybeSingle();

      if (data) {
        setProfile(data);
      }
    } catch (err) {
      console.log("Error loading user profile in profile tab", err);
    }
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      fetchProfile();
    }, [fetchProfile])
  );

  const savedProducts = useMemo(() => {
    const savedSet = new Set(savedIds);
    return products.filter((product) => savedSet.has(product.id));
  }, [products, savedIds]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#111" />
        <Text style={styles.muted}>Loading…</Text>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.title}>Profile</Text>
        <Text style={styles.muted}>You’re not signed in.</Text>

        <TouchableOpacity
          style={styles.button}
          onPress={() => router.push("/sign-in")}
        >
          <Text style={styles.buttonText}>Sign In</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  const avatarUri = safeImageUri(profile?.avatar_url);
  const displayName = profile?.display_name || user.email?.split("@")[0] || "Seller";

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* User Card */}
        <View style={styles.userCard}>
          <View style={styles.avatarWrapper}>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarPlaceholderText}>
                  {displayName.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
          </View>

          <View style={styles.userDetails}>
            <Text style={styles.displayName}>{displayName}</Text>
            <Text style={styles.emailText}>{user.email}</Text>
            {!!profile?.bio && <Text style={styles.bioText} numberOfLines={2}>{profile.bio}</Text>}
          </View>
        </View>

        {/* Profile Action Buttons */}
        <View style={styles.actionButtonsRow}>
          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => router.push("/edit-profile")}
          >
            <Ionicons name="pencil-outline" size={15} color="#111" />
            <Text style={styles.actionButtonText}>Edit Profile</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionButton}
            onPress={() => router.push(`/seller/${encodeURIComponent(user.id)}`)}
          >
            <Ionicons name="storefront-outline" size={15} color="#111" />
            <Text style={styles.actionButtonText}>Public Store</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, styles.signOutActionBtn]}
            onPress={async () => {
              await signOut();
              router.replace("/profile");
            }}
          >
            <Ionicons name="log-out-outline" size={15} color="#b00020" />
            <Text style={styles.signOutActionText}>Sign Out</Text>
          </TouchableOpacity>
        </View>

        {/* Saved Section */}
        <View style={styles.savedHeader}>
          <Text style={styles.savedTitle}>Saved</Text>
          <Text style={styles.savedCount}>{savedProducts.length}</Text>
        </View>

        {!!reactionError && <Text style={styles.errorText}>{reactionError}</Text>}
        {!!error && <Text style={styles.errorText}>{error}</Text>}

        {productsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="small" color="#111" />
            <Text style={styles.muted}>Loading saved products…</Text>
          </View>
        ) : (
          <ProductGrid
            products={savedProducts}
            onPressProduct={(product) =>
              router.push(`/${encodeURIComponent(String(product.id))}`)
            }
            emptyTitle="No saved products yet"
            emptyDescription="Tap ☆ Save on products in your feed to build your collection."
          />
        )}
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
    paddingTop: 18,
    paddingBottom: 24,
    gap: 14,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    backgroundColor: "#fff",
    gap: 10,
  },
  title: { fontSize: 22, fontWeight: "800" },
  muted: { color: "#666" },
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 6,
  },
  avatarWrapper: {
    width: 68,
    height: 68,
    borderRadius: 34,
    borderWidth: 1,
    borderColor: "#e5e5e5",
    overflow: "hidden",
    backgroundColor: "#f5f5f5",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
    borderRadius: 34,
  },
  avatarPlaceholder: {
    width: "100%",
    height: "100%",
    borderRadius: 34,
    backgroundColor: "#ececec",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarPlaceholderText: {
    fontSize: 26,
    fontWeight: "800",
    color: "#777",
  },
  userDetails: {
    flex: 1,
    gap: 3,
  },
  displayName: {
    fontSize: 20,
    fontWeight: "800",
    color: "#111",
  },
  emailText: {
    fontSize: 13,
    color: "#666",
  },
  bioText: {
    fontSize: 13,
    color: "#444",
    marginTop: 2,
  },
  actionButtonsRow: {
    flexDirection: "row",
    gap: 8,
  },
  actionButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#fafafa",
  },
  actionButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#111",
  },
  signOutActionBtn: {
    borderColor: "#ffcdd2",
    backgroundColor: "#fff5f5",
  },
  signOutActionText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#b00020",
  },
  savedHeader: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  savedTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#111",
  },
  savedCount: {
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
  button: {
    backgroundColor: "#111",
    padding: 14,
    borderRadius: 12,
    marginTop: 8,
    minWidth: 160,
    alignItems: "center",
  },
  loadingBox: {
    marginTop: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    minHeight: 120,
  },
  errorText: {
    color: "#b00020",
    fontSize: 12,
  },
  buttonText: { color: "#fff", fontWeight: "800" },
});
