// app/_layout.tsx
import React, { useEffect } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Stack, useRouter, useSegments } from "expo-router";
import { AuthProvider, useAuth } from "../hooks/AuthContext";
import { ProductsProvider } from "../hooks/ProductsContext";
import {
  TasteOnboardingProvider,
  useTasteOnboarding,
} from "../hooks/TasteOnboardingContext";
import { resolveOnboardingGate } from "../lib/tasteOnboarding";

// The ONE centralized onboarding/auth routing decision (PR #35). Evaluated
// at the root navigation boundary so individual tabs never duplicate
// onboarding checks. While a redirect is pending — or while auth/onboarding
// state is still loading — an opaque veil covers the navigator so a required
// onboarding user never sees a flash of the normal app.
function OnboardingGate() {
  const { loading: authLoading } = useAuth();
  const { status } = useTasteOnboarding();
  const segments = useSegments();
  const router = useRouter();

  const inOnboarding = segments[0] === "onboarding";
  const decision = resolveOnboardingGate({ authLoading, status, inOnboarding });

  useEffect(() => {
    if (decision === "to_onboarding") {
      router.replace("/onboarding");
    } else if (decision === "to_app") {
      router.replace("/");
    }
  }, [decision, router]);

  if (decision === "loading" || decision === "to_onboarding" || decision === "to_app") {
    return (
      <View style={styles.veil} pointerEvents="auto">
        <ActivityIndicator color="#111" />
      </View>
    );
  }
  return null;
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <ProductsProvider>
        <TasteOnboardingProvider>
          <Stack screenOptions={{ headerShown: false }} />
          <OnboardingGate />
        </TasteOnboardingProvider>
      </ProductsProvider>
    </AuthProvider>
  );
}

const styles = StyleSheet.create({
  veil: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
});
