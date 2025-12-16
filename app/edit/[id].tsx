import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput
} from "react-native";
import { useProducts } from "../../hooks/ProductsContext";
import { supabase } from "../../lib/supabase";

export default function EditProductScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { products, refresh } = useProducts();

  const product = useMemo(() => {
    return products.find((p: any) => String(p.id) === String(id));
  }, [products, id]);

  const [userId, setUserId] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState("shoes");
  const [url, setUrl] = useState("");

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getUser();
      setUserId(data?.user?.id ?? null);
    })();
  }, []);

  useEffect(() => {
    if (!product) return;
    setTitle(String(product.title ?? ""));
    setBrand(String(product.brand ?? ""));
    setPrice(product.price ? String(product.price) : "");
    setCategory(String(product.category ?? "shoes"));
    setUrl(String(product.url ?? ""));
  }, [product]);

  const isOwner = useMemo(() => {
    if (!product) return false;
    return String(product.owner_id ?? "") === String(userId ?? "");
  }, [product, userId]);

  const handleSave = async () => {
    if (!product) return;

    if (!isOwner) {
      Alert.alert("Not allowed", "Only the owner can edit this product.");
      return;
    }

    if (!title.trim() || !brand.trim() || !category.trim()) {
      Alert.alert("Missing fields", "Title, brand, and category are required.");
      return;
    }

    try {
      setSaving(true);

      const cleanUrl = url.trim();
      const finalUrl = cleanUrl.length ? cleanUrl : null; // URL optional

      const finalPrice = price.trim().length ? price.trim() : null; // price optional

      const { error } = await supabase
        .from("products")
        .update({
          title: title.trim(),
          brand: brand.trim(),
          category: category.trim(),
          price: finalPrice,
          url: finalUrl,
        })
        .eq("id", product.id);

      if (error) {
        Alert.alert("Update failed", error.message);
        return;
      }

      await refresh?.();
      Alert.alert("Saved!");
      router.back();
    } finally {
      setSaving(false);
    }
  };

  if (!product) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.header}>Product not found</Text>
        <Pressable style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!isOwner) {
    return (
      <SafeAreaView style={styles.container}>
        <Text style={styles.header}>Not allowed</Text>
        <Text style={styles.note}>
          Only the person who posted this item can edit it.
        </Text>
        <Pressable style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>Back</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <Pressable onPress={() => router.back()} style={styles.topBack}>
        <Text style={styles.topBackText}>← Back</Text>
      </Pressable>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>Edit product</Text>

          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Title"
          />

          <TextInput
            style={styles.input}
            value={brand}
            onChangeText={setBrand}
            placeholder="Brand"
          />

          <TextInput
            style={styles.input}
            value={price}
            onChangeText={setPrice}
            placeholder="Price (optional)"
            keyboardType="numeric"
          />

          <TextInput
            style={styles.input}
            value={category}
            onChangeText={setCategory}
            placeholder="Category"
          />

          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="URL (optional)"
            autoCapitalize="none"
          />

          <Pressable
            style={[styles.saveBtn, saving && { opacity: 0.6 }]}
            onPress={handleSave}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator />
            ) : (
              <Text style={styles.saveText}>Save changes</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  topBack: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  topBackText: { fontSize: 16, fontWeight: "600" },

  content: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 40,
    gap: 12,
  },

  title: { fontSize: 24, fontWeight: "800", marginBottom: 6 },
  header: { fontSize: 20, fontWeight: "800", padding: 16 },
  note: { paddingHorizontal: 16, color: "#666", marginBottom: 12 },

  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: "#fff",
  },

  saveBtn: {
    marginTop: 8,
    backgroundColor: "#111",
    paddingVertical: 14,
    borderRadius: 999,
    alignItems: "center",
  },
  saveText: { color: "#fff", fontWeight: "800", fontSize: 16 },

  btn: {
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: "#111",
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: "center",
  },
  btnText: { color: "#fff", fontWeight: "700" },
});
