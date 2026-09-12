// app/(tabs)/categories.tsx
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { CategoryCard } from "../../components/CategoryCard";
import { CategorySearchBar } from "../../components/CategorySearchBar";
import {
  CATEGORIES,
  type CategoryItem,
  getCategoryProductCount,
} from "../../constants/categories";
import { useProducts } from "../../hooks/ProductsContext";

export default function CategoriesScreen() {
  const router = useRouter();
  const { products, refresh, loading } = useProducts();
  const [filterQuery, setFilterQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  };

  // Build the complete category list: curated categories + any extra distinct categories found in db
  const allCategories = useMemo(() => {
    const list: CategoryItem[] = [...CATEGORIES];
    const knownKeys = new Set(
      CATEGORIES.flatMap((c) => [c.id.toLowerCase(), c.name.toLowerCase(), ...c.keywords])
    );

    // Detect if products have other custom categories
    for (const p of products) {
      const raw = (p.category ?? "").trim();
      if (!raw) continue;
      const lower = raw.toLowerCase();
      if (!knownKeys.has(lower)) {
        knownKeys.add(lower);
        list.push({
          id: lower,
          name: raw.charAt(0).toUpperCase() + raw.slice(1),
          subtitle: "Community collection",
          imageUrl:
            "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=800&q=80",
          keywords: [lower],
        });
      }
    }

    return list;
  }, [products]);

  // Filter categories by query
  const filteredCategories = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return allCategories;

    return allCategories.filter((cat) => {
      const nameMatch = cat.name.toLowerCase().includes(q);
      const subMatch = cat.subtitle.toLowerCase().includes(q);
      const kwMatch = cat.keywords.some((k) => k.toLowerCase().includes(q));
      return nameMatch || subMatch || kwMatch;
    });
  }, [allCategories, filterQuery]);

  const handleSelectCategory = (category: CategoryItem) => {
    router.push({
      pathname: "/category/[category]",
      params: { category: category.id },
    });
  };

  const handleSearchAll = () => {
    router.push({
      pathname: "/category/[category]",
      params: { category: "all" },
    });
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.container}>
        {/* Header Section */}
        <View style={styles.header}>
          <View style={styles.headerTop}>
            <View>
              <Text style={styles.eyebrow}>PENCHANT</Text>
              <Text style={styles.title}>CATEGORIES</Text>
            </View>
            <Pressable
              style={styles.allButton}
              onPress={handleSearchAll}
              accessibilityRole="button"
              accessibilityLabel="View all products"
            >
              <Text style={styles.allButtonText}>VIEW ALL</Text>
              <Ionicons name="arrow-forward" size={12} color="#111" />
            </Pressable>
          </View>
          <Text style={styles.subtitle}>
            Explore curated departments and premium goods
          </Text>

          {/* Quick Filter Bar */}
          <View style={styles.searchWrap}>
            <CategorySearchBar
              value={filterQuery}
              onChangeText={setFilterQuery}
              placeholder="Search categories & departments..."
            />
          </View>
        </View>

        {/* Categories Grid */}
        <FlatList
          data={filteredCategories}
          keyExtractor={(item) => item.id}
          numColumns={2}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing || loading}
              onRefresh={onRefresh}
              tintColor="#111"
            />
          }
          renderItem={({ item }) => {
            const count = getCategoryProductCount(products, item.id);
            return (
              <View style={styles.gridCol}>
                <CategoryCard
                  category={item}
                  productCount={count}
                  onPress={() => handleSelectCategory(item)}
                />
              </View>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="search-outline" size={36} color="#999" />
              <Text style={styles.emptyTitle}>
                No categories match &ldquo;{filterQuery}&rdquo;
              </Text>
              <Text style={styles.emptySubtitle}>
                Try searching for a different department or view all products.
              </Text>
              <Pressable
                style={styles.emptyButton}
                onPress={() => setFilterQuery("")}
              >
                <Text style={styles.emptyButtonText}>Clear Filter</Text>
              </Pressable>
            </View>
          }
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  container: {
    flex: 1,
    width: "100%",
    maxWidth: 960,
    alignSelf: "center",
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
  },
  eyebrow: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.5,
    color: "#888",
    marginBottom: 2,
  },
  title: {
    fontSize: 24,
    fontWeight: "900",
    letterSpacing: 0.5,
    color: "#111",
  },
  subtitle: {
    fontSize: 13,
    color: "#666",
    marginTop: 4,
    fontWeight: "400",
  },
  allButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: "#f4f4f4",
    borderWidth: 1,
    borderColor: "#e8e8e8",
  },
  allButtonText: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    color: "#111",
  },
  searchWrap: {
    marginTop: 12,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 40,
  },
  row: {
    gap: 12,
    marginBottom: 12,
  },
  gridCol: {
    flex: 1,
  },
  emptyState: {
    paddingVertical: 48,
    paddingHorizontal: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#111",
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 13,
    color: "#666",
    textAlign: "center",
    lineHeight: 18,
  },
  emptyButton: {
    marginTop: 10,
    backgroundColor: "#111",
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 8,
  },
  emptyButtonText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
});
