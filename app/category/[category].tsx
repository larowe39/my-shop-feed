import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BrandFilterChips } from "../../components/BrandFilterChips";
import { CategorySearchBar } from "../../components/CategorySearchBar";
import { ProductGrid } from "../../components/ProductGrid";
import {
  getCategoryInfo,
  matchProductCategory,
} from "../../constants/categories";
import { type Product, useProducts } from "../../hooks/ProductsContext";

export default function CategoryProductsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ category?: string; brand?: string }>();
  const categoryParam = params.category ?? "all";
  const initialBrand = params.brand ?? "";

  const { products, loading } = useProducts();
  const [selectedBrand, setSelectedBrand] = useState<string>(initialBrand);
  const [searchQuery, setSearchQuery] = useState<string>("");

  const categoryInfo = useMemo(
    () => getCategoryInfo(categoryParam),
    [categoryParam]
  );

  // Filter products for this category case-insensitively using keyword & alias mapping
  const categoryProducts = useMemo(() => {
    return products.filter((p) =>
      matchProductCategory(p.category, categoryParam)
    );
  }, [products, categoryParam]);

  // Extract unique brands for this category
  const brands = useMemo(() => {
    const brandSet = new Set<string>();
    for (const p of categoryProducts) {
      const b = (p.brand ?? "").trim();
      if (b) brandSet.add(b);
    }
    return Array.from(brandSet).sort((a, b) => a.localeCompare(b));
  }, [categoryProducts]);

  // Filter products by selected brand and search query (matches title and brand)
  const visibleProducts = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const brandFilter = selectedBrand.trim().toLowerCase();

    return categoryProducts.filter((product) => {
      if (brandFilter && brandFilter !== "all") {
        const prodBrand = (product.brand ?? "").trim().toLowerCase();
        if (prodBrand !== brandFilter) {
          return false;
        }
      }

      if (query) {
        const titleMatch = (product.title ?? "")
          .toLowerCase()
          .includes(query);
        const brandMatch = (product.brand ?? "")
          .toLowerCase()
          .includes(query);
        if (!titleMatch && !brandMatch) {
          return false;
        }
      }

      return true;
    });
  }, [categoryProducts, selectedBrand, searchQuery]);

  const hasActiveFilters = Boolean(
    (selectedBrand && selectedBrand.toLowerCase() !== "all") || searchQuery.trim()
  );

  const handleResetFilters = () => {
    setSelectedBrand("");
    setSearchQuery("");
  };

  const emptyTitle = hasActiveFilters
    ? "No matching products found"
    : `No ${categoryInfo.name} products yet`;

  const emptyDescription = hasActiveFilters
    ? "Try adjusting your search query or selecting a different brand filter."
    : "Check back soon as sellers add new items to this collection.";

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.wrapper}>
        {/* Top Header */}
        <View style={styles.header}>
          <Pressable
            style={styles.backButton}
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={24} color="#111" />
          </Pressable>

          <View style={styles.headerTitles}>
            <Text style={styles.headerCategoryName} numberOfLines={1}>
              {categoryInfo.name.toUpperCase()}
            </Text>
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {categoryInfo.subtitle}
            </Text>
          </View>

          <View style={styles.headerRightPlaceholder} />
        </View>

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Search Bar */}
          <View style={styles.searchSection}>
            <CategorySearchBar
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={`Search in ${categoryInfo.name}...`}
            />
          </View>

          {/* Brand Filter Chips (if 2+ brands exist) */}
          {brands.length > 1 && (
            <View style={styles.brandSection}>
              <Text style={styles.sectionLabel}>FILTER BY BRAND</Text>
              <BrandFilterChips
                brands={brands}
                selectedBrand={selectedBrand}
                onSelectBrand={setSelectedBrand}
              />
            </View>
          )}

          {/* Results Summary Meta */}
          <View style={styles.resultsMetaRow}>
            <Text style={styles.resultsCount}>
              {visibleProducts.length}{" "}
              {visibleProducts.length === 1 ? "Product" : "Products"}
            </Text>

            {hasActiveFilters && (
              <Pressable
                onPress={handleResetFilters}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel="Clear all filters"
              >
                <Text style={styles.resetFiltersText}>Reset filters</Text>
              </Pressable>
            )}
          </View>

          {/* Product Grid or Loading */}
          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#111" />
              <Text style={styles.loadingText}>Loading products…</Text>
            </View>
          ) : (
            <ProductGrid
              products={visibleProducts}
              onPressProduct={(product: Product) =>
                router.push(`/${encodeURIComponent(String(product.id))}`)
              }
              emptyTitle={emptyTitle}
              emptyDescription={emptyDescription}
              emptyActionLabel={hasActiveFilters ? "Clear Filters" : undefined}
              onEmptyAction={hasActiveFilters ? handleResetFilters : undefined}
            />
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  wrapper: {
    flex: 1,
    width: "100%",
    maxWidth: 960,
    alignSelf: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f5f5f5",
  },
  headerTitles: {
    flex: 1,
    alignItems: "center",
    marginHorizontal: 12,
  },
  headerCategoryName: {
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: 1.2,
    color: "#111",
  },
  headerSubtitle: {
    fontSize: 11,
    color: "#888",
    fontWeight: "500",
    marginTop: 1,
  },
  headerRightPlaceholder: {
    width: 36,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 40,
  },
  searchSection: {
    marginBottom: 12,
  },
  brandSection: {
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    color: "#999",
    marginBottom: 4,
  },
  resultsMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
    paddingHorizontal: 2,
  },
  resultsCount: {
    fontSize: 13,
    fontWeight: "700",
    color: "#222",
  },
  resetFiltersText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#666",
    textDecorationLine: "underline",
  },
  loadingContainer: {
    paddingVertical: 48,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    fontSize: 13,
    color: "#888",
    fontWeight: "500",
  },
});
