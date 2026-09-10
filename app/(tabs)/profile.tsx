// app/(tabs)/profile.tsx
import React, { useMemo } from "react";
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../hooks/AuthContext";
import { useProducts } from "../../hooks/ProductsContext";
import { ProductGrid } from "../../components/ProductGrid";

export default function ProfileScreen() {
  const router = useRouter();
  const { user, loading, signOut } = useAuth();
  const { products, savedIds, loading: productsLoading, error, reactionError } = useProducts();

  const savedProducts = useMemo(() => {
    const savedSet = new Set(savedIds);
    return products.filter((product) => savedSet.has(product.id));
  }, [products, savedIds]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <Text>Loading…</Text>
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

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Profile</Text>
        <Text style={styles.muted}>{user.email}</Text>

        <TouchableOpacity
          style={[styles.button, styles.signOutButton]}
          onPress={async () => {
            await signOut();
            router.replace("/profile");
          }}
        >
          <Text style={styles.buttonText}>Sign Out</Text>
        </TouchableOpacity>

        <View style={styles.savedHeader}>
          <Text style={styles.savedTitle}>Saved</Text>
          <Text style={styles.savedCount}>{savedProducts.length}</Text>
        </View>

        {!!reactionError && <Text style={styles.errorText}>{reactionError}</Text>}
        {!!error && <Text style={styles.errorText}>{error}</Text>}

        {productsLoading ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator size="small" />
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
    gap: 10,
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
  savedHeader: {
    marginTop: 14,
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
  signOutButton: {
    backgroundColor: "#b00020",
    marginBottom: 8,
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
