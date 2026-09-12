// app/(tabs)/upload.tsx
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { CATEGORIES } from "../../constants/categories";
import { useAuth } from "../../hooks/AuthContext";
import { useProducts } from "../../hooks/ProductsContext";
import { supabase } from "../../lib/supabase";

function getExt(uri: string): string {
  const clean = uri.split("?")[0];
  const parts = clean.split(".");
  const ext = parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "jpg";
  if (ext === "jpeg") return "jpg";
  return ext;
}

function getContentType(ext: string): string {
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

function makeFileName(ext: string): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
}

function sanitizeUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

const POPULAR_BRANDS = [
  "PENCHANT",
  "Nike",
  "Ami Paris",
  "Salomon",
  "Tudor",
  "Sony",
  "Patagonia",
  "Aesop",
  "Lululemon",
];

export default function UploadScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { refresh } = useProducts();

  const [imageUri, setImageUri] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [brand, setBrand] = useState("PENCHANT");
  const [selectedCategory, setSelectedCategory] = useState("fashion");
  const [customCategory, setCustomCategory] = useState("");
  const [price, setPrice] = useState("");
  const [url, setUrl] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const signedInEmail = useMemo(
    () => session?.user?.email ?? null,
    [session?.user?.email]
  );

  const clearError = (field: string) => {
    if (formErrors[field]) {
      setFormErrors((prev) => {
        const next = { ...prev };
        delete next[field];
        return next;
      });
    }
  };

  const pickImageFromLibrary = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission Required",
          "Please grant photo library permissions to upload product photos."
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.9,
        allowsEditing: true,
        aspect: [4, 5],
      });

      if (!result.canceled && result.assets && result.assets[0]?.uri) {
        setImageUri(result.assets[0].uri);
        clearError("image");
      }
    } catch (err: any) {
      console.log("Error selecting image from library:", err);
      Alert.alert("Picker error", err?.message ?? "Unable to select photo.");
    }
  };

  const takePhotoWithCamera = async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission Required",
          "Please grant camera access to take product photos."
        );
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        quality: 0.9,
        allowsEditing: true,
        aspect: [4, 5],
      });

      if (!result.canceled && result.assets && result.assets[0]?.uri) {
        setImageUri(result.assets[0].uri);
        clearError("image");
      }
    } catch (err: any) {
      console.log("Error taking photo:", err);
      Alert.alert("Camera error", err?.message ?? "Unable to capture photo.");
    }
  };

  const handleRemoveImage = () => {
    setImageUri(null);
  };

  const uploadToSupabaseStorage = async (localUri: string): Promise<string> => {
    if (!session) throw new Error("Not signed in");

    const ext = getExt(localUri);
    const fileName = makeFileName(ext);
    const path = `${session.user.id}/${fileName}`;

    // ArrayBuffer -> Uint8Array for Expo & RN compatibility
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

  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    if (!imageUri) {
      errors.image = "Please select or take a product photo.";
    }

    if (!title.trim()) {
      errors.title = "Product title is required.";
    } else if (title.trim().length < 2) {
      errors.title = "Title must be at least 2 characters long.";
    }

    if (!brand.trim()) {
      errors.brand = "Brand name is required.";
    }

    const effectiveCategory =
      selectedCategory === "other" ? customCategory.trim() : selectedCategory;
    if (!effectiveCategory) {
      errors.category = "Please choose or specify a category.";
    }

    if (price.trim()) {
      const cleanPrice = price.replace(/[^\d.]/g, "");
      const num = parseFloat(cleanPrice);
      if (isNaN(num) || num < 0) {
        errors.price = "Enter a valid positive price.";
      }
    }

    if (url.trim()) {
      const sanitized = sanitizeUrl(url);
      try {
        const parsed = new URL(sanitized);
        if (!parsed.hostname.includes(".")) {
          errors.url = "Enter a valid website URL (e.g. brand.com).";
        }
      } catch {
        errors.url = "Enter a valid URL.";
      }
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const onSubmit = async () => {
    if (!session) {
      Alert.alert(
        "Authentication Required",
        "Please sign in to upload new products to PENCHANT.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Sign In", onPress: () => router.push("/sign-in") },
        ]
      );
      return;
    }

    if (!validateForm()) {
      Alert.alert(
        "Incomplete Listing",
        "Please resolve the highlighted fields before submitting."
      );
      return;
    }

    try {
      setSubmitting(true);
      setSubmitStatus("Uploading image to storage...");

      // 1) Upload image to Supabase Storage
      const publicUrl = await uploadToSupabaseStorage(imageUri!);

      setSubmitStatus("Publishing product listing...");

      // 2) Prepare clean payload
      const effectiveCategory =
        selectedCategory === "other" ? customCategory.trim() : selectedCategory;

      const cleanPrice = price.trim() ? price.replace(/[^\d.]/g, "") : null;
      const cleanUrl = url.trim() ? sanitizeUrl(url) : null;

      const payload = {
        title: title.trim(),
        brand: brand.trim() || "PENCHANT",
        price: cleanPrice,
        url: cleanUrl,
        category: effectiveCategory.toLowerCase(),
        image_url: publicUrl,
        user_id: session.user.id,
      };

      const { error: insertErr } = await supabase
        .from("products")
        .insert(payload);

      if (insertErr) throw insertErr;

      // 3) Synchronize state across all tabs
      await refresh();

      // 4) Reset form
      setImageUri(null);
      setTitle("");
      setBrand("PENCHANT");
      setSelectedCategory("fashion");
      setCustomCategory("");
      setPrice("");
      setUrl("");
      setFormErrors({});

      Alert.alert(
        "Product Published! 🎉",
        "Your item is now live on the Feed, in Categories, and on your Seller Profile.",
        [
          {
            text: "View in Feed",
            onPress: () => router.navigate("/(tabs)"),
          },
          {
            text: "Add Another",
            style: "cancel",
          },
        ]
      );
    } catch (e: any) {
      console.log("Upload error:", e);
      Alert.alert(
        "Upload Failed",
        e?.message ?? "An error occurred while uploading. Please try again."
      );
    } finally {
      setSubmitting(false);
      setSubmitStatus(null);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.select({ ios: "padding", android: undefined })}
      >
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.contentContainer}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header Title & Status */}
          <View style={styles.header}>
            <Text style={styles.eyebrow}>PENCHANT STUDIO</Text>
            <Text style={styles.title}>Upload Product</Text>
            <Text style={styles.subtitle}>
              List a new item in the curated discovery feed
            </Text>

            {signedInEmail ? (
              <View style={styles.authBadge}>
                <Ionicons name="checkmark-circle" size={14} color="#10b981" />
                <Text style={styles.authBadgeText} numberOfLines={1}>
                  Signed in as {signedInEmail}
                </Text>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.signInBanner}
                onPress={() => router.push("/sign-in")}
              >
                <Ionicons name="log-in-outline" size={18} color="#b00020" />
                <Text style={styles.signInBannerText}>
                  You are not signed in. Tap here to sign in first.
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {/* 1. Image Picker & Preview Section */}
          <View style={styles.section}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionLabel}>PRODUCT IMAGE</Text>
              <Text style={styles.requiredTag}>* Required</Text>
            </View>

            {imageUri ? (
              <View style={styles.previewContainer}>
                <Image
                  source={{ uri: imageUri }}
                  style={styles.previewImage}
                  resizeMode="cover"
                />

                <View style={styles.previewOverlay}>
                  <TouchableOpacity
                    style={styles.overlayButton}
                    onPress={pickImageFromLibrary}
                    disabled={submitting}
                  >
                    <Ionicons name="image-outline" size={16} color="#fff" />
                    <Text style={styles.overlayButtonText}>Change</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.overlayButton, styles.overlayButtonDanger]}
                    onPress={handleRemoveImage}
                    disabled={submitting}
                  >
                    <Ionicons name="trash-outline" size={16} color="#fff" />
                    <Text style={styles.overlayButtonText}>Remove</Text>
                  </TouchableOpacity>
                </View>

                <View style={styles.readyBadge}>
                  <Ionicons name="checkmark-circle" size={14} color="#10b981" />
                  <Text style={styles.readyBadgeText}>Photo Ready</Text>
                </View>
              </View>
            ) : (
              <View
                style={[
                  styles.emptyImageContainer,
                  !!formErrors.image && styles.containerError,
                ]}
              >
                <View style={styles.emptyIconCircle}>
                  <Ionicons name="cloud-upload-outline" size={32} color="#555" />
                </View>
                <Text style={styles.emptyTitle}>Select a Product Photo</Text>
                <Text style={styles.emptySubtitle}>
                  High quality 4:5 portrait photo works best
                </Text>

                <View style={styles.pickerActionsRow}>
                  <TouchableOpacity
                    style={styles.pickerActionBtn}
                    onPress={pickImageFromLibrary}
                    disabled={submitting}
                  >
                    <Ionicons name="images-outline" size={18} color="#111" />
                    <Text style={styles.pickerActionBtnText}>Photo Library</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.pickerActionBtn, styles.pickerActionBtnOutline]}
                    onPress={takePhotoWithCamera}
                    disabled={submitting}
                  >
                    <Ionicons name="camera-outline" size={18} color="#111" />
                    <Text style={styles.pickerActionBtnText}>Camera</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {!!formErrors.image && (
              <Text style={styles.errorText}>
                <Ionicons name="alert-circle" size={12} color="#ef4444" />{" "}
                {formErrors.image}
              </Text>
            )}
          </View>

          {/* 2. Product Details */}
          <View style={styles.section}>
            {/* Title */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelRow}>
                <Text style={styles.fieldLabel}>TITLE</Text>
                <Text style={styles.requiredTag}>*</Text>
              </View>
              <TextInput
                value={title}
                onChangeText={(text) => {
                  setTitle(text);
                  clearError("title");
                }}
                placeholder="e.g. Heavyweight Boxy Fit Hoodie"
                placeholderTextColor="#999"
                style={[
                  styles.input,
                  !!formErrors.title && styles.inputError,
                ]}
                editable={!submitting}
              />
              {!!formErrors.title && (
                <Text style={styles.errorText}>{formErrors.title}</Text>
              )}
            </View>

            {/* Brand */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelRow}>
                <Text style={styles.fieldLabel}>BRAND</Text>
                <Text style={styles.requiredTag}>*</Text>
              </View>
              <TextInput
                value={brand}
                onChangeText={(text) => {
                  setBrand(text);
                  clearError("brand");
                }}
                placeholder="e.g. PENCHANT, Nike, Ami Paris"
                placeholderTextColor="#999"
                style={[
                  styles.input,
                  !!formErrors.brand && styles.inputError,
                ]}
                editable={!submitting}
              />
              {/* Brand Suggestion Chips */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.suggestionChips}
              >
                {POPULAR_BRANDS.map((item) => (
                  <TouchableOpacity
                    key={item}
                    style={[
                      styles.suggestionChip,
                      brand.toLowerCase() === item.toLowerCase() &&
                        styles.suggestionChipActive,
                    ]}
                    onPress={() => {
                      setBrand(item);
                      clearError("brand");
                    }}
                    disabled={submitting}
                  >
                    <Text
                      style={[
                        styles.suggestionChipText,
                        brand.toLowerCase() === item.toLowerCase() &&
                          styles.suggestionChipTextActive,
                      ]}
                    >
                      {item}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              {!!formErrors.brand && (
                <Text style={styles.errorText}>{formErrors.brand}</Text>
              )}
            </View>

            {/* Category Selector */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelRow}>
                <Text style={styles.fieldLabel}>CATEGORY</Text>
                <Text style={styles.requiredTag}>* Curated System</Text>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.categoryChips}
              >
                {CATEGORIES.map((cat) => {
                  const isSelected = selectedCategory === cat.id;
                  return (
                    <TouchableOpacity
                      key={cat.id}
                      style={[
                        styles.categoryChip,
                        isSelected && styles.categoryChipSelected,
                      ]}
                      onPress={() => {
                        setSelectedCategory(cat.id);
                        clearError("category");
                      }}
                      disabled={submitting}
                    >
                      <Text
                        style={[
                          styles.categoryChipText,
                          isSelected && styles.categoryChipTextSelected,
                        ]}
                      >
                        {cat.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity
                  style={[
                    styles.categoryChip,
                    selectedCategory === "other" && styles.categoryChipSelected,
                  ]}
                  onPress={() => {
                    setSelectedCategory("other");
                    clearError("category");
                  }}
                  disabled={submitting}
                >
                  <Text
                    style={[
                      styles.categoryChipText,
                      selectedCategory === "other" &&
                        styles.categoryChipTextSelected,
                    ]}
                  >
                    Other...
                  </Text>
                </TouchableOpacity>
              </ScrollView>

              {selectedCategory === "other" && (
                <View style={{ marginTop: 8 }}>
                  <TextInput
                    value={customCategory}
                    onChangeText={(text) => {
                      setCustomCategory(text);
                      clearError("category");
                    }}
                    placeholder="Enter custom category name..."
                    placeholderTextColor="#999"
                    style={[
                      styles.input,
                      !!formErrors.category && styles.inputError,
                    ]}
                    editable={!submitting}
                  />
                </View>
              )}

              {!!formErrors.category && (
                <Text style={styles.errorText}>{formErrors.category}</Text>
              )}
            </View>

            {/* Price & Product URL Row */}
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>PRICE (USD)</Text>
              <View
                style={[
                  styles.priceInputWrapper,
                  !!formErrors.price && styles.inputError,
                ]}
              >
                <View style={styles.pricePrefix}>
                  <Text style={styles.pricePrefixText}>$</Text>
                </View>
                <TextInput
                  value={price}
                  onChangeText={(text) => {
                    setPrice(text);
                    clearError("price");
                  }}
                  placeholder="98"
                  placeholderTextColor="#999"
                  keyboardType="numeric"
                  style={styles.priceInput}
                  editable={!submitting}
                />
              </View>
              {!!formErrors.price && (
                <Text style={styles.errorText}>{formErrors.price}</Text>
              )}
            </View>

            {/* URL */}
            <View style={styles.fieldGroup}>
              <View style={styles.labelRow}>
                <Text style={styles.fieldLabel}>PRODUCT / STORE LINK</Text>
                <Text style={styles.optionalTag}>Optional</Text>
              </View>
              <View
                style={[
                  styles.urlInputWrapper,
                  !!formErrors.url && styles.inputError,
                ]}
              >
                <Ionicons
                  name="link-outline"
                  size={18}
                  color="#888"
                  style={{ marginLeft: 12 }}
                />
                <TextInput
                  value={url}
                  onChangeText={(text) => {
                    setUrl(text);
                    clearError("url");
                  }}
                  placeholder="https://brand.com/item/..."
                  placeholderTextColor="#999"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  style={styles.urlInput}
                  editable={!submitting}
                />
              </View>
              {!!formErrors.url && (
                <Text style={styles.errorText}>{formErrors.url}</Text>
              )}
            </View>
          </View>

          {/* Submit Button */}
          <View style={styles.submitSection}>
            <TouchableOpacity
              onPress={onSubmit}
              disabled={submitting || !session}
              style={[
                styles.submitButton,
                (!session || submitting) && styles.submitButtonDisabled,
              ]}
              activeOpacity={0.85}
            >
              {submitting ? (
                <View style={styles.submitLoadingRow}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.submitButtonText}>
                    {submitStatus || "Publishing..."}
                  </Text>
                </View>
              ) : (
                <View style={styles.submitContentRow}>
                  <Ionicons name="sparkles-outline" size={18} color="#fff" />
                  <Text style={styles.submitButtonText}>Publish to Feed</Text>
                </View>
              )}
            </TouchableOpacity>

            {!session && (
              <Text style={styles.submitHelperNote}>
                Sign in above to enable product publishing.
              </Text>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 48,
    gap: 22,
  },
  header: {
    gap: 4,
  },
  eyebrow: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.5,
    color: "#666666",
    textTransform: "uppercase",
  },
  title: {
    fontSize: 26,
    fontWeight: "900",
    color: "#111111",
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 13,
    color: "#666666",
    marginBottom: 8,
  },
  authBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#f0fdf4",
    borderColor: "#bbf7d0",
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  authBadgeText: {
    fontSize: 12,
    color: "#166534",
    fontWeight: "600",
  },
  signInBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#fef2f2",
    borderColor: "#fecaca",
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  signInBannerText: {
    fontSize: 13,
    color: "#991b1b",
    fontWeight: "600",
  },
  section: {
    gap: 12,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 1,
    color: "#333333",
  },
  requiredTag: {
    fontSize: 11,
    color: "#ef4444",
    fontWeight: "600",
  },
  optionalTag: {
    fontSize: 11,
    color: "#888888",
    fontWeight: "500",
  },
  previewContainer: {
    position: "relative",
    width: "100%",
    aspectRatio: 4 / 5,
    borderRadius: 16,
    overflow: "hidden",
    backgroundColor: "#f5f5f5",
    borderWidth: 1,
    borderColor: "#e5e5e5",
  },
  previewImage: {
    width: "100%",
    height: "100%",
  },
  previewOverlay: {
    position: "absolute",
    bottom: 14,
    left: 14,
    right: 14,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  overlayButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "rgba(0,0,0,0.75)",
    paddingVertical: 10,
    borderRadius: 10,
  },
  overlayButtonDanger: {
    backgroundColor: "rgba(185, 28, 28, 0.85)",
  },
  overlayButtonText: {
    color: "#ffffff",
    fontWeight: "700",
    fontSize: 13,
  },
  readyBadge: {
    position: "absolute",
    top: 14,
    left: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(255,255,255,0.92)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  readyBadgeText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#166534",
  },
  emptyImageContainer: {
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: "#d1d5db",
    borderRadius: 16,
    paddingVertical: 36,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fafafa",
    gap: 8,
  },
  emptyIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#f3f4f6",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111827",
  },
  emptySubtitle: {
    fontSize: 13,
    color: "#6b7280",
    textAlign: "center",
    marginBottom: 8,
  },
  pickerActionsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
  pickerActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#111827",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
  },
  pickerActionBtnOutline: {
    backgroundColor: "#f9fafb",
    borderColor: "#d1d5db",
  },
  pickerActionBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#111827",
  },
  containerError: {
    borderColor: "#ef4444",
    backgroundColor: "#fef2f2",
  },
  fieldGroup: {
    gap: 6,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    color: "#4b5563",
  },
  input: {
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#111827",
  },
  inputError: {
    borderColor: "#ef4444",
    backgroundColor: "#fef2f2",
  },
  errorText: {
    fontSize: 12,
    color: "#ef4444",
    fontWeight: "600",
    marginTop: 2,
  },
  suggestionChips: {
    gap: 6,
    paddingVertical: 4,
  },
  suggestionChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#f3f4f6",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  suggestionChipActive: {
    backgroundColor: "#111827",
    borderColor: "#111827",
  },
  suggestionChipText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#4b5563",
  },
  suggestionChipTextActive: {
    color: "#ffffff",
  },
  categoryChips: {
    gap: 8,
    paddingVertical: 4,
  },
  categoryChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#f3f4f6",
    borderWidth: 1,
    borderColor: "#e5e7eb",
  },
  categoryChipSelected: {
    backgroundColor: "#111827",
    borderColor: "#111827",
  },
  categoryChipText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
  },
  categoryChipTextSelected: {
    color: "#ffffff",
    fontWeight: "700",
  },
  priceInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
    borderRadius: 12,
    overflow: "hidden",
  },
  pricePrefix: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "#f3f4f6",
    borderRightWidth: 1,
    borderRightColor: "#e5e7eb",
  },
  pricePrefixText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#374151",
  },
  priceInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#111827",
  },
  urlInputWrapper: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    backgroundColor: "#f9fafb",
    borderRadius: 12,
  },
  urlInput: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 12,
    fontSize: 15,
    color: "#111827",
  },
  submitSection: {
    marginTop: 6,
    gap: 8,
  },
  submitButton: {
    backgroundColor: "#111827",
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  submitButtonDisabled: {
    backgroundColor: "#9ca3af",
    shadowOpacity: 0,
    elevation: 0,
  },
  submitContentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  submitLoadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  submitButtonText: {
    color: "#ffffff",
    fontWeight: "800",
    fontSize: 16,
    letterSpacing: 0.2,
  },
  submitHelperNote: {
    fontSize: 12,
    color: "#6b7280",
    textAlign: "center",
  },
});
