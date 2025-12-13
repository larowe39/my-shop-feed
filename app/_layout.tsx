import { Tabs } from "expo-router";
import React, { useState } from "react";
import { Button, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { ProductsProvider } from "../hooks/ProductsContext";

function AuthScreen({ onDone }: { onDone: () => void }) {
  return (
    <SafeAreaView style={styles.authContainer}>
      <Text style={styles.logo}>PENCHANT</Text>
      <Text style={styles.text}>
        Create an account to save products, follow brands, and get a curated
        feed.
      </Text>

      <View style={{ height: 24 }} />

      <Button
        title="Create test account"
        onPress={onDone}
        color="#111"
      />

      <View style={{ height: 12 }} />

      <Text style={styles.hint}>
        (Later this becomes real sign up / log in.)
      </Text>
    </SafeAreaView>
  );
}

export default function RootLayout() {
  const [isSignedIn, setIsSignedIn] = useState(false);

  // If not signed in, show auth screen instead of tabs
  if (!isSignedIn) {
    return <AuthScreen onDone={() => setIsSignedIn(true)} />;
  }

  // After "sign in", show the tabbed app
  return (
    <ProductsProvider>
     <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "#111",
        tabBarInactiveTintColor: "#999",
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Feed" }}
      />
      <Tabs.Screen
        name="categories"
        options={{ title: "Categories" }}
      />
      <Tabs.Screen
      name="upload"
      options={{ title: "Upload" }}
    />
      <Tabs.Screen
        name="profile"
        options={{ title: "Profile" }}
        
      />
    </Tabs>
    </ProductsProvider>
  );
}

const styles = StyleSheet.create({
  authContainer: {
    flex: 1,
    backgroundColor: "#ffffff",
    paddingHorizontal: 24,
    justifyContent: "center",
  },
  logo: {
    fontSize: 32,
    fontWeight: "bold",
    letterSpacing: 4,
    textAlign: "center",
    marginBottom: 12,
  },
  text: {
    fontSize: 16,
    textAlign: "center",
    color: "#444",
  },
  hint: {
    fontSize: 12,
    textAlign: "center",
    color: "#888",
  },
});
