// app/(tabs)/upload.tsx
import React, { useMemo, useState } from "react";
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Text,
  TextInput,
  View,
  ActivityIndicator,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../hooks/AuthContext";
import { useProducts } from "../../hooks/ProductsContext";

function getExt(uri: string) {
  const clean = uri.split("?")[0];
  const parts = clean.split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "jpg";
  if (ext === "jpeg") return "jpg";
  return ext;
}

function getContentType(ext: string) {
  switch (ext) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    case "jpg":
    default:
      return "image/jpeg";
  }
}

function makeFileName(ext: string) {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
}

export default function UploadScreen() {
  const { session } = useAuth();
  const { refresh } = useProducts();

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [category, setCategory] = useState("hoodies");
  const [brand, setBrand] = useState("PENCHANT");
  const [price, setPrice] = useState("98");
  const [url, setUrl] = useState("");

  const [submitting, setSubmitting] = useState(false);

  const signedInEmail = useMemo(
    () => session?.user?.email ?? null,
    [session?.user?.email]
  );

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Please allow photo access.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.9,
      allowsEditing: true,
      aspect: [4, 5],
    });

    if (!result.canceled) {
      setImageUri(result.assets[0].uri);
    }
  };

  const uploadToSupabaseStorage = async (localUri: string): Promise<string> => {
    if (!session) throw new Error("Not signed in");

    const ext = getExt(localUri);
    const fileName = makeFileName(ext);
    const path = `${session.user.id}/${fileName}`;

    // Expo/RN-safe: ArrayBuffer -> Uint8Array
    const fileRes = await fetch(localUri);
    const arrayBuffer = await fileRes.arrayBuffer();
    const fileData = new Uint8Array(arrayBuffer);

    const contentType = getContentType(ext);

    const { error: upErr } = await supabase.storage
      .from("product-images")
      .upload(path, fileData, {
        contentType,
        cacheControl: "3600",
        upsert: false,
      });

    if (upErr) throw upErr;

    const { data } = supabase.storage.from("product-images").getPublicUrl(path);
    return data.publicUrl;
  };

  const onSubmit = async () => {
    if (!session) {
      Alert.alert("Not signed in", "Please sign in first.");
      return;
    }
    if (!imageUri) {
      Alert.alert("Missing photo", "Pick an image first.");
      return;
    }
    if (!caption.trim()) {
      Alert.alert("Missing caption", "Add a caption (title) for the post.");
      return;
    }

    try {
      setSubmitting(true);

      // 1) Upload image to Storage
      const publicUrl = await uploadToSupabaseStorage(imageUri);

      // 2) Insert product row
      const payload = {
        title: caption.trim(),
        brand: brand.trim() || "PENCHANT",
        price: price.trim() || null,
        url: url.trim() || null,
        category: category.trim() || "other",
        image_url: publicUrl,
        user_id: session.user.id,
      };

      const { error: insertErr } = await supabase.from("products").insert(payload);
      if (insertErr) throw insertErr;

      // 3) Reset + refresh feed
      setImageUri(null);
      setCaption("");
      setUrl("");
      await refresh();

      Alert.alert("Posted ✅", "Your post is live on the feed.");
    } catch (e: any) {
      console.log("Upload error:", e);
      Alert.alert("Upload failed", e?.message ?? "Unknown error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "white" }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: "padding", android: undefined })}
      >
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
          <Text style={{ fontSize: 22, fontWeight: "700" }}>Upload</Text>

          {!signedInEmail ? (
            <Text style={{ opacity: 0.6 }}>You’re not signed in.</Text>
          ) : (
            <Text style={{ opacity: 0.6 }}>Signed in as {signedInEmail}</Text>
          )}

          <Pressable
            onPress={pickImage}
            style={{
              borderWidth: 1,
              borderColor: "#ddd",
              borderRadius: 14,
              overflow: "hidden",
              height: 420,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "#fafafa",
            }}
          >
            {!imageUri ? (
              <Text style={{ fontSize: 16, opacity: 0.7 }}>Tap to pick a photo</Text>
            ) : (
              <Image
                source={{ uri: imageUri }}
                style={{ width: "100%", height: "100%" }}
                resizeMode="cover"
              />
            )}
          </Pressable>

          <View style={{ gap: 10 }}>
            <Text style={{ fontWeight: "600" }}>Caption</Text>
            <TextInput
              value={caption}
              onChangeText={setCaption}
              placeholder="Write something…"
              style={{
                borderWidth: 1,
                borderColor: "#ddd",
                borderRadius: 12,
                padding: 12,
              }}
            />

            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1, gap: 8 }}>
                <Text style={{ fontWeight: "600" }}>Category</Text>
                <TextInput
                  value={category}
                  onChangeText={setCategory}
                  placeholder="hoodies"
                  style={{
                    borderWidth: 1,
                    borderColor: "#ddd",
                    borderRadius: 12,
                    padding: 12,
                  }}
                />
              </View>

              <View style={{ width: 110, gap: 8 }}>
                <Text style={{ fontWeight: "600" }}>Price</Text>
                <TextInput
                  value={price}
                  onChangeText={setPrice}
                  placeholder="98"
                  keyboardType="numeric"
                  style={{
                    borderWidth: 1,
                    borderColor: "#ddd",
                    borderRadius: 12,
                    padding: 12,
                  }}
                />
              </View>
            </View>

            <View style={{ gap: 8 }}>
              <Text style={{ fontWeight: "600" }}>Brand</Text>
              <TextInput
                value={brand}
                onChangeText={setBrand}
                placeholder="PENCHANT"
                style={{
                  borderWidth: 1,
                  borderColor: "#ddd",
                  borderRadius: 12,
                  padding: 12,
                }}
              />
            </View>

            <View style={{ gap: 8 }}>
              <Text style={{ fontWeight: "600" }}>URL (optional)</Text>
              <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder="https://…"
                autoCapitalize="none"
                style={{
                  borderWidth: 1,
                  borderColor: "#ddd",
                  borderRadius: 12,
                  padding: 12,
                }}
              />
            </View>
          </View>

          <Pressable
            onPress={onSubmit}
            disabled={submitting || !session}
            style={{
              backgroundColor: !session ? "#aaa" : "black",
              padding: 14,
              borderRadius: 14,
              alignItems: "center",
              marginTop: 10,
            }}
          >
            {submitting ? (
              <ActivityIndicator />
            ) : (
              <Text style={{ color: "white", fontWeight: "700", fontSize: 16 }}>
                Post
              </Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
