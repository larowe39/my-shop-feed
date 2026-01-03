// app/(tabs)/_layout.tsx
import React from "react";
import { Tabs } from "expo-router";

export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false }}>
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
  );
}
