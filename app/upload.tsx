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

  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("");
  const [price, setPrice] = useState("");
  const [category, setCategory] = useState("shoes");
  const [url, setUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Pick from gallery
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
      setSelectedImage(result.assets[0].uri);
    }
  };

  // Take photo
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
      setSelectedImage(result.assets[0].uri);
    }
  };

  const handleSave = async () => {
    if (!selectedImage) {
      Alert.alert("Please pick an image first.");
      return;
    }

    if (!title || !brand || !category) {
      Alert.alert("Title, brand, and category are required.");
      return;
    }

    try {
      setIsSaving(true);

      // 1) Turn image URI into an ArrayBuffer (works in Expo / RN)
      const response = await fetch(selectedImage);
      const arrayBuffer = await response.arrayBuffer();

      const ext =
        selectedImage.split(".").pop()?.split("?")[0]?.toLowerCase() ?? "jpg";
      const fileName = `${Date.now()}.${ext}`;
      const filePath = `products/${fileName}`;

      // 2) Upload to Supabase Storage
      const { data: uploadData, error: storageError } = await supabase.storage
        .from("products")
        .upload(filePath, arrayBuffer, {
          contentType: `image/${ext === "jpg" ? "jpeg" : ext}`,
        });

      if (storageError) {
        console.error(storageError);
        Alert.alert("Upload failed", storageError.message);
        setIsSaving(false);
        return;
      }

      // 3) Get public URL
      const { data: publicData } = supabase.storage
        .from("products")
        .getPublicUrl(filePath);

      const imageUrl = publicData?.publicUrl ?? "";

      // 4) Insert row into products table
      const { error: insertError } = await supabase.from("products").insert({
        title,
        brand,
        price: price || null,
        url: url || null, 
        category,
        image_url: imageUrl, // make sure your table has this column if you want it
      });

      if (insertError) {
        console.error(insertError);
        Alert.alert("Save error", insertError.message);
        setIsSaving(false);
        return;
      }

      Alert.alert("Product saved!");

      // optional: refresh feed
      refresh?.();

      // Reset form
      setTitle("");
      setBrand("");
      setPrice("");
      setCategory("shoes");
      setUrl("");
      setSelectedImage(null);
    } catch (err: any) {
      console.error("Unexpected upload error", err);
      Alert.alert("Unexpected error", err?.message ?? "Something went wrong.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>Upload a product</Text>

        <View style={styles.imageWrapper}>
          {selectedImage ? (
            <Image source={{ uri: selectedImage }} style={styles.image} />
          ) : (
            <View style={styles.placeholder}>
              <Text style={styles.placeholderText}>No image selected</Text>
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
          placeholder="Product title"
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
          keyboardType="numeric"
          value={price}
          onChangeText={setPrice}
        />
        <TextInput
          style={styles.input}
          placeholder="Category (e.g. shoes)"
          value={category}
          onChangeText={setCategory}
        />
        <TextInput
          style={styles.input}
          placeholder="Product URL (link to site)"
          autoCapitalize="none"
          value={url}
          onChangeText={setUrl}
        />

        <Pressable
          style={styles.saveButton}
          onPress={handleSave}
          disabled={isSaving}
        >
          {isSaving ? (
            <ActivityIndicator color="#fff" />
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
    marginTop: 8,
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
