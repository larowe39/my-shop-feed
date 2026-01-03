// app/sign-in.tsx
import React, { useState } from "react";
import {
  Alert,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { supabase } from "../lib/supabase";
import { useAuth } from "../hooks/AuthContext";

export default function SignInScreen() {
  const router = useRouter();
  const { signInWithEmail, signUpWithEmail } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);

  const onSubmit = async () => {
    try {
      setBusy(true);

      const e = email.trim();
      if (!e || !password) {
        Alert.alert("Missing info", "Enter email + password.");
        return;
      }

      if (mode === "signin") {
        await signInWithEmail(e, password);
        router.replace("/profile");
        return;
      }

      // SIGN UP
      await signUpWithEmail(e, password);

      // If email confirmation is ON, Supabase will often return NO session here.
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        Alert.alert(
          "Check your email",
          "Your account was created. Please confirm your email, then return and sign in."
        );
        setMode("signin");
        return;
      }

      router.replace("/profile");
    } catch (err: any) {
      Alert.alert("Auth error", err?.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.card}>
        <Text style={styles.title}>
          {mode === "signin" ? "Sign in" : "Create account"}
        </Text>

        <TextInput
          style={styles.input}
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        <TouchableOpacity style={styles.button} onPress={onSubmit} disabled={busy}>
          <Text style={styles.buttonText}>
            {busy ? "..." : mode === "signin" ? "Sign in" : "Sign up"}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}
          style={{ marginTop: 14 }}
        >
          <Text style={styles.link}>
            {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fff", justifyContent: "center", padding: 18 },
  card: { borderWidth: 1, borderColor: "#eee", borderRadius: 12, padding: 16 },
  title: { fontSize: 22, fontWeight: "800", marginBottom: 14 },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  button: { backgroundColor: "#111", padding: 14, borderRadius: 12, alignItems: "center", marginTop: 4 },
  buttonText: { color: "#fff", fontWeight: "800" },
  link: { color: "#0a66c2", fontWeight: "700", textAlign: "center" },
});
