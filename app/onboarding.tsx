// app/onboarding.tsx
//
// PENCHANT Taste Onboarding (PR #35) — the first-user experience that turns
// a brand-new authenticated user from cold start into an explicit taste seed.
//
//   Stage 0  "What are you into?"               curated category multi-select
//   Stage 1  "Pick what catches your eye."      real-product visual selection
//   Stage 2  "Your Penchant is taking shape."   summary + Enter PENCHANT
//
// Selections are LOCAL while the user experiments — no events fire per tap.
// In-progress selections persist to the user's state row (no taste events);
// the explicit taste events are committed atomically by the
// complete_taste_onboarding RPC on completion. Navigation after completion is
// owned by the centralized gate in app/_layout.tsx (status flips to
// "completed" and the gate routes into the app).
import { Ionicons } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
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
import { ModeratedProductImage } from "../components/ModeratedProductImage";
import { useAuth } from "../hooks/AuthContext";
import { useProducts } from "../hooks/ProductsContext";
import { useTasteOnboarding } from "../hooks/TasteOnboardingContext";
import {
  getOnboardingCategories,
  ONBOARDING_MIN_CATEGORY_SELECTIONS,
  ONBOARDING_PRODUCT_CANDIDATE_COUNT,
  requiredProductMinimum,
  selectOnboardingCandidates,
} from "../lib/tasteOnboarding";

const STAGE_HEADLINES = [
  "What are you into?",
  "Pick what catches your eye.",
  "Your Penchant is taking shape.",
] as const;

export default function OnboardingScreen() {
  const { signOut } = useAuth();
  const { products } = useProducts();
  const { status, state, saveProgress, completeOnboarding } = useTasteOnboarding();

  const [stage, setStage] = useState(0);
  const [selectedCategories, setSelectedCategories] = useState<string[]>(
    () => (Array.isArray(state?.selected_categories) ? state.selected_categories : [])
  );
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>(
    () =>
      Array.isArray(state?.selected_product_ids) ? state.selected_product_ids : []
  );
  const [submitting, setSubmitting] = useState(false);

  const categories = useMemo(() => getOnboardingCategories(), []);

  const candidates = useMemo(
    () =>
      selectOnboardingCandidates({
        products,
        selectedCategoryIds: selectedCategories,
        count: ONBOARDING_PRODUCT_CANDIDATE_COUNT,
      }),
    [products, selectedCategories]
  );

  const productMinimum = requiredProductMinimum(candidates.length);
  const canContinueCategories =
    selectedCategories.length >= ONBOARDING_MIN_CATEGORY_SELECTIONS;
  const canContinueProducts =
    selectedProductIds.length >= productMinimum && productMinimum > 0;

  const selectedProductList = useMemo(
    () => candidates.filter((p) => selectedProductIds.includes(p.id)),
    [candidates, selectedProductIds]
  );

  const summaryBrands = useMemo(() => {
    const seen = new Set<string>();
    for (const product of selectedProductList) {
      const brand = (product.brand ?? "").trim();
      if (brand) seen.add(brand);
      if (seen.size >= 4) break;
    }
    return [...seen];
  }, [selectedProductList]);

  const toggleCategory = (id: string) => {
    setSelectedCategories((prev) =>
      prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]
    );
  };

  const toggleProduct = (id: string) => {
    setSelectedProductIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const goToProducts = async () => {
    await saveProgress(selectedCategories, selectedProductIds);
    setStage(1);
  };

  const goToSummary = async () => {
    await saveProgress(selectedCategories, selectedProductIds);
    setStage(2);
  };

  const onEnter = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const result = await completeOnboarding({
        categories: selectedCategories,
        productIds: selectedProductIds,
        availableProductCount: candidates.length,
      });
      if (!result.ok) {
        Alert.alert("Could not finish", result.error ?? "Please try again.");
        return;
      }
      // Status is now "completed": the centralized gate routes into the app.
    } finally {
      setSubmitting(false);
    }
  };

  if (status !== "required") {
    // Gate redirect is in flight (or state is refreshing after completion).
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loadingWrap}>
          <ActivityIndicator color="#111" />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.frame}>
        {/* Header: wordmark + progress + sign out */}
        <View style={styles.header}>
          <Text style={styles.wordmark}>PENCHANT</Text>
          <View
            style={styles.progressDots}
            accessibilityLabel={`Step ${stage + 1} of 3`}
          >
            {STAGE_HEADLINES.map((_, i) => (
              <View
                key={i}
                style={[styles.dot, i <= stage ? styles.dotActive : undefined]}
              />
            ))}
          </View>
          <Pressable
            onPress={() => signOut()}
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            hitSlop={8}
          >
            <Text style={styles.signOut}>Sign out</Text>
          </Pressable>
        </View>

        <Text style={styles.headline}>{STAGE_HEADLINES[stage]}</Text>

        {stage === 0 && (
          <>
            <Text style={styles.subcopy}>
              {canContinueCategories
                ? `${selectedCategories.length} selected`
                : `Choose at least ${ONBOARDING_MIN_CATEGORY_SELECTIONS} — ${
                    ONBOARDING_MIN_CATEGORY_SELECTIONS - selectedCategories.length
                  } to go`}
            </Text>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.categoryGrid}
            >
              {categories.map((category) => {
                const selected = selectedCategories.includes(category.id);
                return (
                  <Pressable
                    key={category.id}
                    style={[styles.categoryTile, selected && styles.tileSelected]}
                    onPress={() => toggleCategory(category.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${selected ? "Deselect" : "Select"} ${category.name}`}
                  >
                    <Image
                      source={{ uri: category.imageUrl }}
                      style={styles.tileImage}
                      resizeMode="cover"
                    />
                    <View
                      style={[styles.tileOverlay, selected && styles.tileOverlaySelected]}
                    />
                    <View style={styles.tileLabelWrap}>
                      <Text style={styles.tileLabel}>{category.name}</Text>
                    </View>
                    {selected && (
                      <View style={styles.checkBadge}>
                        <Ionicons name="checkmark" size={14} color="#fff" />
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
            <Pressable
              style={[styles.cta, !canContinueCategories && styles.ctaDisabled]}
              disabled={!canContinueCategories}
              onPress={goToProducts}
              accessibilityRole="button"
              accessibilityLabel="Continue to product picks"
            >
              <Text style={styles.ctaText}>Continue</Text>
            </Pressable>
          </>
        )}

        {stage === 1 && (
          <>
            <Text style={styles.subcopy}>
              {candidates.length === 0
                ? "We're still stocking the shelves — check back soon."
                : canContinueProducts
                ? `${selectedProductIds.length} picked`
                : `Pick at least ${productMinimum} — ${
                    productMinimum - selectedProductIds.length
                  } to go`}
            </Text>
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.productGrid}
            >
              {candidates.map((product) => {
                const selected = selectedProductIds.includes(product.id);
                const uri = (product.image_url ?? "").trim();
                return (
                  <Pressable
                    key={product.id}
                    style={[styles.productTile, selected && styles.tileSelected]}
                    onPress={() => toggleProduct(product.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${selected ? "Deselect" : "Select"} ${
                      product.title ?? "product"
                    }`}
                  >
                    <ModeratedProductImage
                      uri={uri}
                      style={styles.productImage}
                      moderation={product.moderation}
                      productId={product.id}
                      sellerId={product.user_id}
                      allowReveal={false}
                    />
                    <View style={styles.productMeta}>
                      <Text style={styles.productBrand} numberOfLines={1}>
                        {(product.brand ?? "").trim() || "PENCHANT"}
                      </Text>
                      <Text style={styles.productTitle} numberOfLines={2}>
                        {product.title}
                      </Text>
                    </View>
                    {selected && (
                      <View style={styles.checkBadge}>
                        <Ionicons name="checkmark" size={14} color="#fff" />
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.footerRow}>
              <Pressable
                onPress={() => setStage(0)}
                accessibilityRole="button"
                accessibilityLabel="Back to categories"
                hitSlop={8}
              >
                <Text style={styles.backText}>Back</Text>
              </Pressable>
              <Pressable
                style={[styles.cta, styles.ctaFlex, !canContinueProducts && styles.ctaDisabled]}
                disabled={!canContinueProducts}
                onPress={goToSummary}
                accessibilityRole="button"
                accessibilityLabel="Continue to summary"
              >
                <Text style={styles.ctaText}>Continue</Text>
              </Pressable>
            </View>
          </>
        )}

        {stage === 2 && (
          <>
            <Text style={styles.subcopy}>
              Your picks are already shaping what PENCHANT shows you.
            </Text>
            <ScrollView style={styles.scroll} contentContainerStyle={styles.summaryBody}>
              <Text style={styles.summaryLabel}>INTO</Text>
              <View style={styles.summaryChips}>
                {selectedCategories.map((id) => {
                  const category = categories.find((c) => c.id === id);
                  return (
                    <View key={id} style={styles.chip}>
                      <Text style={styles.chipText}>{category?.name ?? id}</Text>
                    </View>
                  );
                })}
              </View>
              {summaryBrands.length > 0 && (
                <>
                  <Text style={styles.summaryLabel}>BRANDS THAT CAUGHT YOUR EYE</Text>
                  <Text style={styles.summaryBrands}>{summaryBrands.join("  ·  ")}</Text>
                </>
              )}
              <Text style={styles.summaryLabel}>PICKED</Text>
              <Text style={styles.summaryCount}>
                {selectedProductIds.length}{" "}
                {selectedProductIds.length === 1 ? "product" : "products"}
              </Text>
            </ScrollView>
            <View style={styles.footerRow}>
              <Pressable
                onPress={() => setStage(1)}
                accessibilityRole="button"
                accessibilityLabel="Back to product picks"
                hitSlop={8}
              >
                <Text style={styles.backText}>Back</Text>
              </Pressable>
              <Pressable
                style={[styles.cta, styles.ctaFlex, submitting && styles.ctaDisabled]}
                disabled={submitting}
                onPress={onEnter}
                accessibilityRole="button"
                accessibilityLabel="Enter PENCHANT"
              >
                {submitting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.ctaText}>Enter PENCHANT</Text>
                )}
              </Pressable>
            </View>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff" },
  frame: {
    flex: 1,
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  loadingWrap: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
  },
  wordmark: { fontSize: 13, fontWeight: "900", letterSpacing: 3, color: "#111" },
  progressDots: { flexDirection: "row", gap: 6 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#ddd",
  },
  dotActive: { backgroundColor: "#111" },
  signOut: { fontSize: 12, fontWeight: "600", color: "#888" },
  headline: {
    fontSize: 30,
    fontWeight: "800",
    letterSpacing: -0.5,
    color: "#111",
    marginTop: 8,
  },
  subcopy: { fontSize: 14, color: "#777", marginTop: 6, marginBottom: 14 },
  scroll: { flex: 1 },
  categoryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    paddingBottom: 20,
  },
  categoryTile: {
    width: "47%",
    flexGrow: 1,
    height: 150,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#1a1a1a",
    borderWidth: 2,
    borderColor: "transparent",
  },
  tileSelected: { borderColor: "#111" },
  tileImage: { ...StyleSheet.absoluteFillObject, width: "100%", height: "100%" },
  tileOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.38)",
  },
  tileOverlaySelected: { backgroundColor: "rgba(0,0,0,0.18)" },
  tileLabelWrap: { flex: 1, justifyContent: "flex-end", padding: 12 },
  tileLabel: { color: "#fff", fontSize: 16, fontWeight: "800", letterSpacing: 0.2 },
  checkBadge: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#111",
    borderWidth: 1,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  productGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    paddingBottom: 20,
  },
  productTile: {
    width: "47%",
    flexGrow: 1,
    maxWidth: "50%",
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#fff",
    borderWidth: 2,
    borderColor: "#eee",
  },
  productImage: { width: "100%", aspectRatio: 1, backgroundColor: "#f3f3f3" },
  productMeta: { padding: 10 },
  productBrand: {
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: "#999",
  },
  productTitle: { fontSize: 13, fontWeight: "600", color: "#111", marginTop: 2 },
  cta: {
    backgroundColor: "#111",
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 6,
  },
  ctaFlex: { flex: 1, marginTop: 0 },
  ctaDisabled: { opacity: 0.25 },
  ctaText: { color: "#fff", fontSize: 15, fontWeight: "800", letterSpacing: 0.4 },
  footerRow: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 6 },
  backText: { fontSize: 14, fontWeight: "700", color: "#777" },
  summaryBody: { paddingBottom: 20 },
  summaryLabel: {
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 2,
    color: "#999",
    marginTop: 22,
    marginBottom: 10,
  },
  summaryChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: "#111",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipText: { fontSize: 13, fontWeight: "700", color: "#111" },
  summaryBrands: { fontSize: 16, fontWeight: "700", color: "#111" },
  summaryCount: { fontSize: 24, fontWeight: "800", color: "#111" },
});
