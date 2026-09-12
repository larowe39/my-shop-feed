import { Ionicons } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { CategoryItem } from "../constants/categories";

export type CategoryCardProps = {
  category: CategoryItem;
  productCount?: number;
  onPress: () => void;
};

export function CategoryCard({
  category,
  productCount,
  onPress,
}: CategoryCardProps) {
  const [imageError, setImageError] = useState(false);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        pressed && styles.cardPressed,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Browse ${category.name} category`}
    >
      {category.imageUrl && !imageError ? (
        <Image
          source={{ uri: category.imageUrl }}
          style={styles.image}
          resizeMode="cover"
          onError={() => setImageError(true)}
        />
      ) : (
        <View style={[styles.image, styles.fallbackBackground]} />
      )}

      {/* Dark overlay for editorial contrast */}
      <View style={styles.overlay} />

      {/* Card Content */}
      <View style={styles.content}>
        <View style={styles.topRow}>
          {typeof productCount === "number" && productCount > 0 ? (
            <View style={styles.countBadge}>
              <Text style={styles.countText}>
                {productCount} {productCount === 1 ? "item" : "items"}
              </Text>
            </View>
          ) : (
            <View style={styles.exploreBadge}>
              <Text style={styles.exploreBadgeText}>DISCOVER</Text>
            </View>
          )}
          <View style={styles.arrowIconWrap}>
            <Ionicons name="arrow-forward" size={14} color="#fff" />
          </View>
        </View>

        <View style={styles.bottomMeta}>
          <Text style={styles.title} numberOfLines={1}>
            {category.name}
          </Text>
          {!!category.subtitle && (
            <Text style={styles.subtitle} numberOfLines={2}>
              {category.subtitle}
            </Text>
          )}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    height: 170,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#1a1a1a",
    position: "relative",
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  cardPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.985 }],
  },
  image: {
    ...StyleSheet.absoluteFillObject,
    width: "100%",
    height: "100%",
  },
  fallbackBackground: {
    backgroundColor: "#222",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.42)",
  },
  content: {
    flex: 1,
    padding: 14,
    justifyContent: "space-between",
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  countBadge: {
    backgroundColor: "rgba(255, 255, 255, 0.22)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.35)",
  },
  countText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  exploreBadge: {
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.25)",
  },
  exploreBadgeText: {
    color: "rgba(255, 255, 255, 0.9)",
    fontSize: 9,
    fontWeight: "800",
    letterSpacing: 0.8,
  },
  arrowIconWrap: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "rgba(255, 255, 255, 0.2)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.3)",
  },
  bottomMeta: {
    gap: 3,
  },
  title: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: 0.2,
    textShadowColor: "rgba(0, 0, 0, 0.4)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  subtitle: {
    color: "rgba(255, 255, 255, 0.82)",
    fontSize: 11,
    fontWeight: "500",
    lineHeight: 14,
  },
});
