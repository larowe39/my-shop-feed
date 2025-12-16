// app/upload.tsx
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { useProducts } from "../hooks/ProductsContext";
import { supabase } from "../lib/supabase";

export default function UploadScreen() {
  const router = useRouter();
  const { refresh } = useProducts();

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState("shoes");
  const [url, setUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission required", "We need access to your photos.");
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      quality: 0.8,
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
    });

    if (!result.canceled && result.assets.length > 0) {
      setImageUri(result.assets[0].uri);
    }
  };

  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission required", "We need access to your camera.");
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      allowsEditing: true,
      quality: 0.8,
    });

    if (!result.canceled && result.assets.length > 0) {
      setImageUri(result.assets[0].uri);
    }
  };

  const handleSave = async () => {
    if (!imageUri) {
      Alert.alert("Please pick an image first.");
      return;
    }

    if (!title.trim() || !brand.trim() || !category.trim()) {
      Alert.alert("Title, brand, and category are required.");
      return;
    }

    try {
      setIsSaving(true);

      // 0) Make sure user is signed in (needed for owner_id + RLS later)
      const {
        data: { user },
        error: userErr,
      } = await supabase.auth.getUser();

      if (userErr || !user) {
        Alert.alert("Not signed in", "Please log in again.");
        return;
      }

      // 1) Convert local image URI -> ArrayBuffer (RN doesn't support blob() reliably)
      const response = await fetch(imageUri);
      const arrayBuffer = await response.arrayBuffer();

      const ext =
        imageUri.split(".").pop()?.split("?")[0]?.toLowerCase() ?? "jpg";
      const safeExt = ext === "jpeg" ? "jpg" : ext;
      const fileName = `${Date.now()}.${safeExt}`;
      const filePath = `products/${fileName}`;

      // 2) Upload to Supabase Storage bucket named: "products"
      const { error: storageError } = await supabase.storage
        .from("products")
        .upload(filePath, arrayBuffer, {
          contentType: `image/${safeExt === "jpg" ? "jpeg" : safeExt}`,
          upsert: false,
        });

      if (storageError) {
        console.error(storageError);
        Alert.alert("Upload failed", storageError.message);
        return;
      }

      // 3) Get public URL for image
      const { data: publicData } = supabase.storage
        .from("products")
        .getPublicUrl(filePath);

      const imageUrl = publicData?.publicUrl ?? "";

      // 4) Insert product row (URL is OPTIONAL)
      const insertPayload: any = {
        title: title.trim(),
        brand: brand.trim(),
        price: price.trim() ? price.trim() : null,
        category: category.trim(),
        image_url: imageUrl,
        owner_id: user.id, // if you added owner_id column
      };

      // only include url if user typed one
      const cleanUrl = url.trim();
      if (cleanUrl) insertPayload.url = cleanUrl;

      const { error: insertError } = await supabase
        .from("products")
        .insert(insertPayload);

      if (insertError) {
        console.error(insertError);
        Alert.alert("Save error", insertError.message);
        return;
      }

      Alert.alert("Product saved!");

      // Reset form
      setTitle("");
      setBrand("");
      setPrice("");
      setCategory("shoes");
      setUrl("");
      setImageUri(null);

      // Refresh feed data (if you use it)
      await refresh?.();

      // Optional: navigate back to home
      router.back();
    } catch (err: any) {
      console.error("Unexpected upload error", err);
      Alert.alert("Unexpected error", err?.message ?? "Something went wrong.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#fff" }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Upload a product</Text>

        <View style={styles.imageWrapper}>
          {imageUri ? (
            <Image source={{ uri: imageUri }} style={styles.image} />
          ) : (
            <View style={styles.placeholder}>
              <Text style={styles.placeholderText}>Pick an image</Text>
            </View>
          )}
        </View>

        <View style={styles.row}>
          <Pressable style={styles.button} onPress={pickImage}>
            <Text style={styles.buttonText}>Pick from gallery</Text>
          </Pressable>

          <Pressable style={styles.button} onPress={takePhoto}>
            <Text style={styles.buttonText}>Take photo</Text>
          </Pressable>
        </View>

        <TextInput
          style={styles.input}
          placeholder="Title"
          value={title}
          onChangeText={setTitle}
        />
        <TextInput
          style={styles.input}
          placeholder="Brand"
          value={brand}
          onChangeText={setBrand}
        />
        <TextInput
          style={styles.input}
          placeholder="Price (optional)"
          value={price}
          onChangeText={setPrice}
          keyboardType="numeric"
        />
        <TextInput
          style={styles.input}
          placeholder="Category"
          value={category}
          onChangeText={setCategory}
        />
        <TextInput
          style={styles.input}
          placeholder="URL (optional)"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
        />

        <Pressable
          style={[styles.saveButton, isSaving && { opacity: 0.6 }]}
          onPress={handleSave}
          disabled={isSaving}
        >
          {isSaving ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.saveButtonText}>Save product</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 40,
    gap: 12,
    backgroundColor: "#fff",
  },
  title: {
    fontSize: 22,
    fontWeight: "700",
    marginBottom: 8,
  },
  imageWrapper: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#eee",
  },
  image: {
    width: "100%",
    height: "100%",
  },
  placeholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  placeholderText: {
    color: "#888",
  },
  row: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  button: {
    flex: 1,
    backgroundColor: "#111",
    paddingVertical: 10,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: {
    color: "#fff",
    fontWeight: "600",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
  },
  saveButton: {
    marginTop: 12,
    backgroundColor: "#111",
    paddingVertical: 12,
    borderRadius: 999,
    alignItems: "center",
  },
  saveButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
