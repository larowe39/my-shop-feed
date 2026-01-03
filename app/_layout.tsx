// app/_layout.tsx
import React from "react";
import { Stack } from "expo-router";
import { AuthProvider } from "../hooks/AuthContext";
import { ProductsProvider } from "../hooks/ProductsContext";

export default function RootLayout() {
  return (
    <AuthProvider>
      <ProductsProvider>
        <Stack screenOptions={{ headerShown: false }} />
      </ProductsProvider>
    </AuthProvider>
  );
}
