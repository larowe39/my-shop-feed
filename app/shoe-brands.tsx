import { Redirect, useLocalSearchParams } from "expo-router";
import React from "react";

/**
 * Legacy route refactored to forward to the generic PENCHANT category discovery screen.
 */
export default function ShoeBrandsScreen() {
  const params = useLocalSearchParams<{ category?: string }>();
  const category = params.category ?? "shoes";

  return (
    <Redirect
      href={{
        pathname: "/category/[category]",
        params: { category },
      }}
    />
  );
}
