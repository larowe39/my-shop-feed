import { Ionicons } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Alert,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { Product, SellerProfile } from "../hooks/ProductsContext";

export type ProductFeedCardProps = {
  product: Product;
  sellerProfile?: SellerProfile;
  isLiked: boolean;
  isSaved: boolean;
  isLikePending: boolean;
  isSavePending: boolean;
  onLikePress: () => void;
  onSavePress: () => void;
  onSellerPress?: () => void;
  onProductPress: () => void;
};

export function safeImageUri(uri?: string | null): string | null {
  const u = (uri ?? "").trim();
  if (!u) return null;
  try {
    return encodeURI(u);
  } catch {
    return u;
  }
}

function formatUrlDomain(url: string): string {
  try {
    const formatted = url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`;
    const parsed = new URL(formatted);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "store";
  }
}

export function ProductFeedCard({
  product,
  sellerProfile,
  isLiked,
  isSaved,
  isLikePending,
  isSavePending,
  onLikePress,
  onSavePress,
  onSellerPress,
  onProductPress,
}: ProductFeedCardProps) {
  const [imageError, setImageError] = useState(false);

  const rawImageUri = safeImageUri(product.image_url);
  const sellerName = sellerProfile?.display_name?.trim() || product.brand || "Seller";
  const sellerAvatarUri = safeImageUri(sellerProfile?.avatar_url);
  const rawUrl = (product.url ?? "").trim();
  const canOpenSeller = Boolean(product.user_id && onSellerPress);

  const handleOpenLink = async () => {
    if (!rawUrl) return;
    try {
      const targetUrl = rawUrl.startsWith("http://") || rawUrl.startsWith("https://") ? rawUrl : `https://${rawUrl}`;
      const ok = await Linking.canOpenURL(targetUrl);
      if (ok) {
        await Linking.openURL(targetUrl);
      } else {
        Alert.alert("Link error", "Cannot open the provided product link.");
      }
    } catch (err) {
      console.log("Failed to open product URL:", err);
      Alert.alert("Link error", "Unable to open this link.");
    }
  };

  const domainLabel = rawUrl ? formatUrlDomain(rawUrl) : "";

  return (
    <View style={styles.card}>
      {/* 1. Seller Header */}
      <View style={styles.header}>
        <Pressable
          style={styles.sellerRow}
          disabled={!canOpenSeller}
          accessibilityRole="button"
          accessibilityLabel={canOpenSeller ? `View ${sellerName}'s profile` : undefined}
          onPress={onSellerPress}
        >
          {sellerAvatarUri ? (
            <Image
              source={{ uri: sellerAvatarUri }}
              style={styles.avatarImage}
            />
          ) : (
            <View style={styles.avatarFallback}>
              <Ionicons name="person" size={16} color="#8e8e93" />
            </View>
          )}

          <View style={styles.sellerMeta}>
            <Text style={styles.sellerName} numberOfLines={1}>
              {sellerName}
            </Text>
            {!!product.category && (
              <Text style={styles.sellerSubtitle} numberOfLines={1}>
                {product.category}
              </Text>
            )}
          </View>
        </Pressable>

        <Pressable
          style={styles.moreButton}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="More options"
        >
          <Ionicons name="ellipsis-horizontal" size={18} color="#8e8e93" />
        </Pressable>
      </View>

      {/* 2. Product Image */}
      <Pressable
        onPress={onProductPress}
        style={styles.imageContainer}
        accessibilityRole="button"
        accessibilityLabel={`View details for ${product.title}`}
      >
        {rawImageUri && !imageError ? (
          <Image
            source={{ uri: rawImageUri }}
            style={styles.productImage}
            resizeMode="cover"
            onError={() => setImageError(true)}
          />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Ionicons name="bag-handle-outline" size={44} color="#b0b0b8" />
            <Text style={styles.imagePlaceholderText}>PENCHANT</Text>
            <Text style={styles.imagePlaceholderSubtext}>No image available</Text>
          </View>
        )}
      </Pressable>

      {/* 3. Action Row */}
      <View style={styles.actionRow}>
        <View style={styles.leftActions}>
          <Pressable
            style={[styles.actionBtn, isLikePending && styles.actionDisabled]}
            disabled={isLikePending}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={isLiked ? "Unlike product" : "Like product"}
            accessibilityState={{ disabled: isLikePending, selected: isLiked }}
            onPress={onLikePress}
          >
            <Ionicons
              name={isLiked ? "heart" : "heart-outline"}
              size={24}
              color={isLiked ? "#ff2d55" : "#111111"}
            />
          </Pressable>

          <Pressable
            style={[styles.actionBtn, isSavePending && styles.actionDisabled]}
            disabled={isSavePending}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={isSaved ? "Remove from saved" : "Save product"}
            accessibilityState={{ disabled: isSavePending, selected: isSaved }}
            onPress={onSavePress}
          >
            <Ionicons
              name={isSaved ? "bookmark" : "bookmark-outline"}
              size={23}
              color="#111111"
            />
          </Pressable>

          {!!rawUrl && (
            <Pressable
              style={styles.actionBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Open product website"
              onPress={handleOpenLink}
            >
              <Ionicons name="open-outline" size={22} color="#111111" />
            </Pressable>
          )}
        </View>

        {!!rawUrl && (
          <Pressable
            style={styles.shopPill}
            onPress={handleOpenLink}
            accessibilityRole="button"
            accessibilityLabel={`Shop on ${domainLabel}`}
          >
            <Text style={styles.shopPillText}>Shop now</Text>
            <Ionicons name="arrow-forward" size={12} color="#111111" />
          </Pressable>
        )}
      </View>

      {/* 4. Product Information */}
      <View style={styles.productInfo}>
        <Pressable
          onPress={onProductPress}
          style={styles.detailsPressable}
          accessibilityRole="button"
          accessibilityLabel={`View ${product.title}`}
        >
          <View style={styles.titlePriceRow}>
            <Text style={styles.productTitle} numberOfLines={2}>
              {product.title}
            </Text>
            {!!product.price && (
              <Text style={styles.productPrice}>${product.price}</Text>
            )}
          </View>

          <View style={styles.metaRow}>
            {!!product.brand && (
              <Text style={styles.brandText}>
                {product.brand.toUpperCase()}
              </Text>
            )}
            {!!product.category && (
              <Text style={styles.categoryBadge}>
                {product.category}
              </Text>
            )}
          </View>
        </Pressable>

        {!!rawUrl && (
          <Pressable
            style={styles.externalLinkButton}
            onPress={handleOpenLink}
            accessibilityRole="link"
            accessibilityLabel={`View on ${domainLabel}`}
          >
            <Text style={styles.externalLinkText}>
              View on {domainLabel}
            </Text>
            <Ionicons name="arrow-forward-outline" size={13} color="#555555" />
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#ffffff",
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f2",
    marginBottom: 8,
    width: "100%",
    maxWidth: 580,
    alignSelf: "center",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sellerRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  avatarImage: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#e8e8ed",
  },
  avatarFallback: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#f2f2f4",
    alignItems: "center",
    justifyContent: "center",
  },
  sellerMeta: {
    flex: 1,
    justifyContent: "center",
  },
  sellerName: {
    fontSize: 13.5,
    fontWeight: "600",
    color: "#111111",
    letterSpacing: -0.2,
  },
  sellerSubtitle: {
    fontSize: 11.5,
    color: "#8e8e93",
    marginTop: 1,
    textTransform: "capitalize",
  },
  moreButton: {
    padding: 4,
    marginLeft: 8,
  },
  imageContainer: {
    width: "100%",
    aspectRatio: 1,
    backgroundColor: "#f7f7f8",
    overflow: "hidden",
  },
  productImage: {
    width: "100%",
    height: "100%",
  },
  imagePlaceholder: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f6f6f8",
    gap: 4,
  },
  imagePlaceholderText: {
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 2,
    color: "#8e8e93",
    marginTop: 6,
  },
  imagePlaceholderSubtext: {
    fontSize: 12,
    color: "#aeaeb2",
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  leftActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  actionBtn: {
    padding: 2,
  },
  actionDisabled: {
    opacity: 0.45,
  },
  shopPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#f4f4f5",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 100,
    borderWidth: 1,
    borderColor: "#e4e4e7",
  },
  shopPillText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#111111",
  },
  productInfo: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 8,
  },
  detailsPressable: {
    gap: 6,
  },
  titlePriceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
  },
  productTitle: {
    flex: 1,
    fontSize: 14.5,
    fontWeight: "600",
    color: "#18181b",
    lineHeight: 20,
    letterSpacing: -0.2,
  },
  productPrice: {
    fontSize: 15,
    fontWeight: "700",
    color: "#18181b",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  brandText: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: "#71717a",
  },
  categoryBadge: {
    fontSize: 11,
    color: "#a1a1aa",
    textTransform: "capitalize",
  },
  externalLinkButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    marginTop: 2,
    paddingVertical: 2,
  },
  externalLinkText: {
    fontSize: 12.5,
    fontWeight: "500",
    color: "#52525b",
    textDecorationLine: "underline",
  },
});
