import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CATEGORIES } from "../../constants/categories";
import { type Product, type SellerProfile, useProducts } from "../../hooks/ProductsContext";
import { trackEvent } from "../../lib/analytics";
import { loadRecentSearches, removeRecentSearch, saveRecentSearch, clearRecentSearches } from "../../lib/recentSearches";
import { normalizeSearchQuery, rankSearchProducts, rankSearchSellers } from "../../lib/searchRanking";
import { rankForYouFeed } from "../../lib/feedRanking";
import { supabase } from "../../lib/supabase";
import { ProductGrid } from "../../components/ProductGrid";

function imageUri(value?: string | null) {
  const trimmed = (value ?? "").trim();
  return trimmed ? encodeURI(trimmed) : null;
}

export default function SearchScreen() {
  const router = useRouter();
  const { products, sellerProfiles, followingIds, toggleFollow, isFollowPending, likedIds, savedIds } = useProducts();
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [sellers, setSellers] = useState<SellerProfile[]>([]);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [sellerLoading, setSellerLoading] = useState(false);
  const lastTrackedQuery = useRef("");

  useEffect(() => {
    loadRecentSearches().then(setRecentSearches);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const normalized = normalizeSearchQuery(input);
      if (!normalized) {
        setQuery("");
        setSellers([]);
        return;
      }
      setQuery(normalized);
    }, 350);
    return () => clearTimeout(timer);
  }, [input]);

  const productResults = useMemo(() => rankSearchProducts(products, query), [products, query]);
  const brandResults = useMemo(() => {
    if (!query) return [];
    const brands = Array.from(new Set(products.map((product) => product.brand.trim()).filter(Boolean)));
    return brands
      .filter((brand) => normalizeSearchQuery(brand).includes(query))
      .sort((a, b) => (normalizeSearchQuery(a).startsWith(query) ? -1 : 1) - (normalizeSearchQuery(b).startsWith(query) ? -1 : 1));
  }, [products, query]);
  const categoryResults = useMemo(() => {
    if (!query) return [];
    return CATEGORIES.filter((category) =>
      [category.id, category.name, ...category.keywords].some((value) => normalizeSearchQuery(value).includes(query))
    );
  }, [query]);
  const discoveryProducts = useMemo(
    () => rankForYouFeed(products, { likedIds, savedIds, followingIds }).slice(0, 6),
    [products, likedIds, savedIds, followingIds]
  );
  const suggestedBrands = useMemo(
    () => Array.from(new Set(products.map((product) => product.brand.trim()).filter(Boolean))).slice(0, 6),
    [products]
  );
  const suggestedSellers = useMemo(() => Object.values(sellerProfiles).slice(0, 6), [sellerProfiles]);

  useEffect(() => {
    let cancelled = false;
    if (!query) return;
    const fetchSellers = async () => {
      setSellerLoading(true);
      const safeQuery = query.replace(/[%,]/g, " ");
      const { data } = await supabase
        .from("user_profiles")
        .select("user_id, display_name, avatar_url, bio")
        .or(`display_name.ilike.%${safeQuery}%,bio.ilike.%${safeQuery}%`)
        .limit(20);
      if (cancelled) return;
      const nextSellers = rankSearchSellers((data as SellerProfile[] | null) ?? [], query);
      setSellers(nextSellers);
      setSellerLoading(false);
      if (lastTrackedQuery.current !== query) {
        lastTrackedQuery.current = query;
        trackEvent({
          eventType: "search_query",
          metadata: {
            source: "search",
            query,
            result_count: productResults.length + nextSellers.length + brandResults.length + categoryResults.length,
            product_result_count: productResults.length,
            seller_result_count: nextSellers.length,
            brand_result_count: brandResults.length,
            category_result_count: categoryResults.length,
          },
        });
      }
    };
    fetchSellers();
    return () => {
      cancelled = true;
    };
  }, [brandResults.length, categoryResults.length, productResults.length, query]);

  const submitSearch = async () => {
    const normalized = normalizeSearchQuery(input);
    if (!normalized) return;
    setInput(normalized);
    setQuery(normalized);
    setRecentSearches(await saveRecentSearch(normalized));
  };

  const selectRecentSearch = (value: string) => {
    setInput(value);
    setQuery(normalizeSearchQuery(value));
  };

  const openProduct = (product: Product) => {
    trackEvent({ eventType: "search_result_open", productId: product.id, metadata: { source: "search", query, result_type: "product", target_id: product.id } });
    router.push(`/${encodeURIComponent(product.id)}`);
  };

  const openSeller = (seller: SellerProfile) => {
    trackEvent({ eventType: "search_result_open", sellerId: seller.user_id, metadata: { source: "search", query, result_type: "seller", target_id: seller.user_id } });
    router.push(`/seller/${encodeURIComponent(seller.user_id)}`);
  };

  const renderSeller = (seller: SellerProfile) => {
    const avatar = imageUri(seller.avatar_url);
    const following = followingIds.includes(seller.user_id);
    return (
      <View style={styles.sellerRow} key={seller.user_id}>
        <Pressable style={styles.sellerIdentity} onPress={() => openSeller(seller)}>
          {avatar ? <Image source={{ uri: avatar }} style={styles.avatar} /> : <View style={styles.avatarFallback}><Ionicons name="person" size={16} color="#777" /></View>}
          <View style={styles.sellerCopy}>
            <Text style={styles.sellerName} numberOfLines={1}>{seller.display_name || "Seller"}</Text>
            {!!seller.bio && <Text style={styles.sellerBio} numberOfLines={1}>{seller.bio}</Text>}
          </View>
        </Pressable>
        <Pressable
          style={[styles.followButton, following && styles.followingButton]}
          disabled={isFollowPending(seller.user_id)}
          onPress={async () => {
            const result = await toggleFollow(seller.user_id);
            if (result === "auth_required") Alert.alert("Sign in required", "Please sign in to follow sellers.", [{ text: "Cancel", style: "cancel" }, { text: "Sign In", onPress: () => router.push("/sign-in") }]);
          }}
        >
          <Text style={[styles.followText, following && styles.followingText]}>{following ? "Following" : "Follow"}</Text>
        </Pressable>
      </View>
    );
  };

  const hasResults = productResults.length + sellers.length + brandResults.length + categoryResults.length > 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>PENCHANT</Text>
        <Text style={styles.title}>SEARCH & DISCOVER</Text>
        <View style={styles.searchBox}>
          <Ionicons name="search-outline" size={20} color="#777" />
          <TextInput value={input} onChangeText={setInput} onSubmitEditing={submitSearch} returnKeyType="search" placeholder="Products, brands, sellers, categories" placeholderTextColor="#929292" style={styles.input} />
          {!!input && <Pressable onPress={() => setInput("")} accessibilityLabel="Clear search"><Ionicons name="close-circle" size={18} color="#777" /></Pressable>}
        </View>

        {!query ? (
          <>
            {!!recentSearches.length && <View style={styles.section}><View style={styles.sectionHeader}><Text style={styles.sectionLabel}>RECENT SEARCHES</Text><Pressable onPress={async () => { await clearRecentSearches(); setRecentSearches([]); }}><Text style={styles.clearText}>Clear All</Text></Pressable></View>{recentSearches.map((recent) => <View style={styles.recentRow} key={recent}><Pressable style={styles.recentValue} onPress={() => selectRecentSearch(recent)}><Ionicons name="time-outline" size={16} color="#999" /><Text style={styles.recentText}>{recent}</Text></Pressable><Pressable onPress={async () => setRecentSearches(await removeRecentSearch(recent))} accessibilityLabel={`Remove ${recent}`}><Ionicons name="close" size={16} color="#999" /></Pressable></View>)}</View>}
            <View style={styles.section}><Text style={styles.sectionLabel}>EXPLORE</Text><Text style={styles.sectionTitle}>A considered edit of what is here now.</Text><ProductGrid products={discoveryProducts} onPressProduct={openProduct} onImpression={(product) => trackEvent({ eventType: "product_impression", productId: product.id, sellerId: product.user_id ?? null, category: product.category, metadata: { source: "search_discover" } })} emptyTitle="Nothing to explore yet" emptyDescription="New pieces will appear here as the catalog grows." /></View>
            {!!suggestedBrands.length && <View style={styles.section}><Text style={styles.sectionLabel}>BRANDS TO KNOW</Text><View style={styles.chips}>{suggestedBrands.map((brand) => <Pressable style={styles.chip} key={brand} onPress={() => router.push(`/brand/${encodeURIComponent(brand)}`)}><Text style={styles.chipText}>{brand}</Text></Pressable>)}</View></View>}
            {!!suggestedSellers.length && <View style={styles.section}><Text style={styles.sectionLabel}>SELLERS TO FOLLOW</Text>{suggestedSellers.map(renderSeller)}</View>}
            <View style={styles.section}><Text style={styles.sectionLabel}>CATEGORIES</Text><View style={styles.chips}>{CATEGORIES.slice(0, 8).map((category) => <Pressable style={styles.categoryChip} key={category.id} onPress={() => router.push(`/category/${encodeURIComponent(category.id)}`)}><Text style={styles.chipText}>{category.name}</Text></Pressable>)}</View></View>
          </>
        ) : (
          <>
            {!!categoryResults.length && <View style={styles.section}><Text style={styles.sectionLabel}>CATEGORIES</Text>{categoryResults.map((category) => <Pressable style={styles.resultRow} key={category.id} onPress={() => router.push(`/category/${encodeURIComponent(category.id)}`)}><Ionicons name="grid-outline" size={18} color="#111" /><View><Text style={styles.resultTitle}>{category.name}</Text><Text style={styles.resultSubtitle}>{category.subtitle}</Text></View></Pressable>)}</View>}
            {!!brandResults.length && <View style={styles.section}><Text style={styles.sectionLabel}>BRANDS</Text>{brandResults.map((brand) => <Pressable style={styles.resultRow} key={brand} onPress={() => router.push(`/brand/${encodeURIComponent(brand)}`)}><Ionicons name="pricetag-outline" size={18} color="#111" /><Text style={styles.resultTitle}>{brand}</Text></Pressable>)}</View>}
            {!!sellers.length && <View style={styles.section}><Text style={styles.sectionLabel}>SELLERS</Text>{sellers.map(renderSeller)}</View>}
            {sellerLoading && <ActivityIndicator color="#111" style={styles.loader} />}
            {!!productResults.length && <View style={styles.section}><Text style={styles.sectionLabel}>PRODUCTS</Text><ProductGrid products={productResults} onPressProduct={openProduct} onImpression={(product) => trackEvent({ eventType: "product_impression", productId: product.id, sellerId: product.user_id ?? null, category: product.category, metadata: { source: "search", query } })} emptyTitle="No products" emptyDescription="" /></View>}
            {!hasResults && !sellerLoading && <View style={styles.empty}><Ionicons name="search-outline" size={34} color="#999" /><Text style={styles.emptyTitle}>No results for “{query}”</Text><Text style={styles.emptyText}>Try a broader term, or explore categories and popular products.</Text><Pressable style={styles.emptyButton} onPress={() => setInput("")}><Text style={styles.emptyButtonText}>Explore</Text></Pressable></View>}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#fff" },
  content: { padding: 22, paddingBottom: 42 },
  eyebrow: { color: "#777", fontSize: 12, letterSpacing: 2, fontWeight: "700" },
  title: { color: "#111", fontSize: 26, fontWeight: "800", letterSpacing: 1, marginTop: 6, marginBottom: 22 },
  searchBox: { flexDirection: "row", alignItems: "center", gap: 10, borderWidth: 1, borderColor: "#d8d8d8", borderRadius: 10, paddingHorizontal: 14, minHeight: 52, backgroundColor: "#fafafa" },
  input: { flex: 1, color: "#111", fontSize: 15 },
  section: { marginTop: 30 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionLabel: { color: "#777", fontSize: 11, fontWeight: "800", letterSpacing: 1.5, marginBottom: 12 },
  sectionTitle: { color: "#111", fontSize: 21, fontWeight: "700", marginBottom: 16 },
  clearText: { color: "#555", fontSize: 12, marginBottom: 12 },
  recentRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: "#eee" },
  recentValue: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  recentText: { color: "#222", fontSize: 15 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: "#ddd", paddingHorizontal: 13, paddingVertical: 10, borderRadius: 20 },
  categoryChip: { backgroundColor: "#f1f1ef", paddingHorizontal: 13, paddingVertical: 10, borderRadius: 20 },
  chipText: { color: "#222", fontSize: 13, fontWeight: "600" },
  sellerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 10 },
  sellerIdentity: { flex: 1, flexDirection: "row", alignItems: "center", gap: 11 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#eee" },
  avatarFallback: { width: 42, height: 42, borderRadius: 21, backgroundColor: "#eee", alignItems: "center", justifyContent: "center" },
  sellerCopy: { flex: 1 },
  sellerName: { color: "#111", fontWeight: "700", fontSize: 15 },
  sellerBio: { color: "#777", fontSize: 12, marginTop: 3 },
  followButton: { borderWidth: 1, borderColor: "#111", paddingHorizontal: 13, paddingVertical: 7, borderRadius: 7 },
  followingButton: { backgroundColor: "#111" },
  followText: { color: "#111", fontSize: 12, fontWeight: "700" },
  followingText: { color: "#fff" },
  resultRow: { flexDirection: "row", alignItems: "center", gap: 13, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#eee" },
  resultTitle: { color: "#111", fontWeight: "700", fontSize: 15 },
  resultSubtitle: { color: "#777", fontSize: 12, marginTop: 3 },
  loader: { marginTop: 18 },
  empty: { alignItems: "center", paddingVertical: 70, paddingHorizontal: 20 },
  emptyTitle: { color: "#111", fontSize: 19, fontWeight: "700", marginTop: 14, textAlign: "center" },
  emptyText: { color: "#777", fontSize: 14, lineHeight: 21, textAlign: "center", marginTop: 8 },
  emptyButton: { backgroundColor: "#111", paddingHorizontal: 18, paddingVertical: 11, borderRadius: 7, marginTop: 20 },
  emptyButtonText: { color: "#fff", fontWeight: "700" },
});