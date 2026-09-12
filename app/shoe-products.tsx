import { Redirect, useLocalSearchParams } from "expo-router";
import React from "react";

/**
 * Legacy route refactored to forward to the generic PENCHANT category discovery screen.
 */
export default function ShoeProductsScreen() {
  const params = useLocalSearchParams<{ category?: string; brand?: string }>();
  const category = params.category ?? "shoes";
  const brand = params.brand ?? "";

  return (
    <Redirect
      href={{
        pathname: "/category/[category]",
        params: { category, brand },
      }}
    />
  );
}
