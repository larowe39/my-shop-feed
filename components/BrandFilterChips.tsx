import React from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

export type BrandFilterChipsProps = {
  brands: string[];
  selectedBrand: string;
  onSelectBrand: (brand: string) => void;
};

export function BrandFilterChips({
  brands,
  selectedBrand,
  onSelectBrand,
}: BrandFilterChipsProps) {
  if (brands.length <= 1) {
    return null;
  }

  const allBrands = ["All", ...brands];

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {allBrands.map((brand) => {
          const isSelected =
            selectedBrand.toLowerCase() === brand.toLowerCase() ||
            (brand === "All" && (!selectedBrand || selectedBrand.toLowerCase() === "all"));

          return (
            <Pressable
              key={brand}
              style={({ pressed }) => [
                styles.chip,
                isSelected ? styles.chipSelected : styles.chipUnselected,
                pressed && styles.chipPressed,
              ]}
              onPress={() => onSelectBrand(brand === "All" ? "" : brand)}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={`Filter by brand ${brand}`}
            >
              <Text
                style={[
                  styles.chipText,
                  isSelected ? styles.chipTextSelected : styles.chipTextUnselected,
                ]}
              >
                {brand}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginVertical: 10,
  },
  scrollContent: {
    paddingHorizontal: 16,
    gap: 8,
    alignItems: "center",
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
  },
  chipSelected: {
    backgroundColor: "#111",
    borderColor: "#111",
  },
  chipUnselected: {
    backgroundColor: "#f7f7f7",
    borderColor: "#e8e8e8",
  },
  chipPressed: {
    opacity: 0.8,
  },
  chipText: {
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.2,
  },
  chipTextSelected: {
    color: "#fff",
    fontWeight: "700",
  },
  chipTextUnselected: {
    color: "#555",
  },
});
