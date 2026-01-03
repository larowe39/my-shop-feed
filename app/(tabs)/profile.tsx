// app/(tabs)/profile.tsx
import React from "react";
import { SafeAreaView, StyleSheet, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../hooks/AuthContext";

export default function ProfileScreen() {
  const router = useRouter();
  const { user, loading, signOut } = useAuth();

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <Text>Loading…</Text>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.title}>Profile</Text>
        <Text style={styles.muted}>You’re not signed in.</Text>

        <TouchableOpacity
          style={styles.button}
          onPress={() => router.push("/sign-in")}
        >
          <Text style={styles.buttonText}>Sign In</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.center}>
      <Text style={styles.title}>Profile</Text>
      <Text style={styles.muted}>{user.email}</Text>

      <TouchableOpacity
        style={[styles.button, { backgroundColor: "#b00020" }]}
        onPress={async () => {
          await signOut();
          // send them back to the Profile tab (not required, but keeps UX clean)
          router.replace("/profile");
        }}
      >
        <Text style={styles.buttonText}>Sign Out</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    backgroundColor: "#fff",
    gap: 10,
  },
  title: { fontSize: 22, fontWeight: "800" },
  muted: { color: "#666" },
  button: {
    backgroundColor: "#111",
    padding: 14,
    borderRadius: 12,
    marginTop: 8,
    minWidth: 160,
    alignItems: "center",
  },
  buttonText: { color: "#fff", fontWeight: "800" },
});
