// app/edit-profile.tsx
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAuth } from "../hooks/AuthContext";
import { useProducts } from "../hooks/ProductsContext";
import { supabase } from "../lib/supabase";

function safeImageUri(uri?: string | null) {
  const value = (uri ?? "").trim();
  if (!value) return null;
  try {
    return encodeURI(value);
  } catch {
    return value;
  }
}

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
  return `avatar-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
}

export default function EditProfileScreen() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { refresh } = useProducts();

  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);

  useEffect(() => {
    if (!user) {
      if (!authLoading) {
        setLoading(false);
      }
      return;
    }

    let isMounted = true;
    const fetchProfile = async () => {
      try {
        setLoading(true);
        const { data, error } = await supabase
          .from("user_profiles")
          .select("display_name, avatar_url, bio")
          .eq("user_id", user.id)
          .maybeSingle();

        if (error) throw error;

        if (isMounted) {
          if (data) {
            setDisplayName(data.display_name ?? "");
            setBio(data.bio ?? "");
            setAvatarUrl(data.avatar_url ?? "");
          } else {
            const fallbackName =
              user.user_metadata?.full_name ??
              user.email?.split("@")[0] ??
              "Seller";
            setDisplayName(fallbackName);
          }
        }
      } catch (err: any) {
        console.log("Error loading profile to edit", err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchProfile();
    return () => {
      isMounted = false;
    };
  }, [user, authLoading]);

  const handlePickImage = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission needed",
          "Please allow photo library access to change your avatar."
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.85,
        allowsEditing: true,
        aspect: [1, 1],
      });

      if (result.canceled || !result.assets[0]?.uri || !user) return;

      const localUri = result.assets[0].uri;
      setUploadingImage(true);

      const ext = getExt(localUri);
      const fileName = makeFileName(ext);
      const path = `${user.id}/${fileName}`;

      const fileRes = await fetch(localUri);
      const arrayBuffer = await fileRes.arrayBuffer();
      const fileData = new Uint8Array(arrayBuffer);
      const contentType = getContentType(ext);

      const { error: upErr } = await supabase.storage
        .from("product-images")
        .upload(path, fileData, {
          contentType,
          cacheControl: "3600",
          upsert: true,
        });

      if (upErr) throw upErr;

      const { data } = supabase.storage
        .from("product-images")
        .getPublicUrl(path);

      if (data?.publicUrl) {
        setAvatarUrl(data.publicUrl);
      }
    } catch (e: any) {
      console.log("Avatar upload error:", e);
      Alert.alert(
        "Upload failed",
        e?.message ?? "Could not upload image. You can enter an image URL instead."
      );
    } finally {
      setUploadingImage(false);
    }
  };

  const handleSave = async () => {
    if (!user) {
      Alert.alert("Sign in required", "Please sign in to edit your profile.");
      return;
    }

    const trimmedName = displayName.trim();
    if (!trimmedName) {
      Alert.alert("Display name required", "Please enter a display name.");
      return;
    }

    setSaving(true);
    try {
      const trimmedBio = bio.trim();
      const trimmedAvatar = avatarUrl.trim();

      const payload = {
        user_id: user.id,
        display_name: trimmedName,
        bio: trimmedBio.length ? trimmedBio : null,
        avatar_url: trimmedAvatar.length ? trimmedAvatar : null,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase.from("user_profiles").upsert(payload, {
        onConflict: "user_id",
      });

      if (error) throw error;

      // refresh products context so feed seller profiles update
      try {
        await refresh();
      } catch (refErr) {
        console.log("Error refreshing products after profile edit", refErr);
      }

      Alert.alert("Saved", "Your profile has been updated successfully.", [
        {
          text: "OK",
          onPress: () => router.back(),
        },
      ]);
    } catch (err: any) {
      console.log("Error updating profile", err);
      Alert.alert("Update failed", err?.message ?? "Failed to save profile.");
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color="#111" />
        <Text style={styles.muted}>Loading profile…</Text>
      </SafeAreaView>
    );
  }

  if (!user) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.title}>Sign in required</Text>
        <Text style={styles.muted}>You must be signed in to edit your profile.</Text>
        <Pressable style={styles.btnPrimary} onPress={() => router.push("/sign-in")}>
          <Text style={styles.btnPrimaryText}>Sign In</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  const previewAvatarUri = safeImageUri(avatarUrl);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={styles.navBar}>
          <Pressable style={styles.backBtn} onPress={() => router.back()}>
            <Ionicons name="chevron-back" size={22} color="#111" />
            <Text style={styles.backText}>Back</Text>
          </Pressable>
          <Text style={styles.navTitle}>Edit Profile</Text>
          <View style={{ width: 60 }} />
        </View>

        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Avatar Section */}
          <View style={styles.avatarSection}>
            <View style={styles.avatarWrapper}>
              {previewAvatarUri ? (
                <Image source={{ uri: previewAvatarUri }} style={styles.avatarImage} />
              ) : (
                <View style={styles.avatarPlaceholder}>
                  <Text style={styles.avatarPlaceholderText}>
                    {(displayName.trim() || "S").charAt(0).toUpperCase()}
                  </Text>
                </View>
              )}
              {uploadingImage && (
                <View style={styles.avatarLoadingOverlay}>
                  <ActivityIndicator color="#fff" />
                </View>
              )}
            </View>

            <Pressable
              style={styles.changePhotoBtn}
              onPress={handlePickImage}
              disabled={uploadingImage}
            >
              <Ionicons name="camera-outline" size={18} color="#111" />
              <Text style={styles.changePhotoText}>
                {uploadingImage ? "Uploading…" : "Change Photo"}
              </Text>
            </Pressable>
          </View>

          {/* Form Fields */}
          <View style={styles.formGroup}>
            <Text style={styles.label}>Display Name *</Text>
            <TextInput
              style={styles.input}
              value={displayName}
              onChangeText={setDisplayName}
              placeholder="e.g. Vintage Vault"
              placeholderTextColor="#999"
              autoCapitalize="words"
            />
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Bio</Text>
            <TextInput
              style={[styles.input, styles.textArea]}
              value={bio}
              onChangeText={setBio}
              placeholder="Tell shoppers about your store, drops, and curation style…"
              placeholderTextColor="#999"
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Avatar Image URL (Optional)</Text>
            <TextInput
              style={styles.input}
              value={avatarUrl}
              onChangeText={setAvatarUrl}
              placeholder="https://..."
              placeholderTextColor="#999"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.fieldHint}>
              You can paste an image URL or use Change Photo above to upload an image.
            </Text>
          </View>

          {/* Action Buttons */}
          <View style={styles.actionRow}>
            <Pressable
              style={[styles.btnPrimary, saving && styles.btnDisabled]}
              disabled={saving}
              onPress={handleSave}
            >
              {saving ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.btnPrimaryText}>Save Changes</Text>
              )}
            </Pressable>

            <Pressable
              style={styles.btnSecondary}
              disabled={saving}
              onPress={() => router.back()}
            >
              <Text style={styles.btnSecondaryText}>Cancel</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
    backgroundColor: "#fff",
  },
  navBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minWidth: 60,
  },
  backText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111",
  },
  navTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111",
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
    gap: 20,
  },
  title: {
    fontSize: 22,
    fontWeight: "800",
    color: "#111",
  },
  muted: {
    color: "#666",
    fontSize: 14,
    textAlign: "center",
  },
  avatarSection: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingVertical: 8,
  },
  avatarWrapper: {
    width: 96,
    height: 96,
    borderRadius: 48,
    position: "relative",
    borderWidth: 1,
    borderColor: "#e5e5e5",
    overflow: "hidden",
  },
  avatarImage: {
    width: "100%",
    height: "100%",
    borderRadius: 48,
    backgroundColor: "#f5f5f5",
  },
  avatarPlaceholder: {
    width: "100%",
    height: "100%",
    borderRadius: 48,
    backgroundColor: "#f0f0f0",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarPlaceholderText: {
    fontSize: 36,
    fontWeight: "800",
    color: "#888",
  },
  avatarLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },
  changePhotoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ddd",
    backgroundColor: "#fafafa",
  },
  changePhotoText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#111",
  },
  formGroup: {
    gap: 8,
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
    color: "#222",
  },
  input: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#111",
    backgroundColor: "#fafafa",
  },
  textArea: {
    minHeight: 88,
    lineHeight: 20,
  },
  fieldHint: {
    fontSize: 12,
    color: "#888",
    lineHeight: 16,
  },
  actionRow: {
    marginTop: 10,
    gap: 10,
  },
  btnPrimary: {
    backgroundColor: "#111",
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  btnPrimaryText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  btnSecondary: {
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#ddd",
  },
  btnSecondaryText: {
    color: "#555",
    fontSize: 15,
    fontWeight: "600",
  },
  btnDisabled: {
    opacity: 0.6,
  },
});
