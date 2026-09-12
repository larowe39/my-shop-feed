import React, { useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { trackEvent } from "../lib/analytics";
import type { ProductModeration } from "../lib/moderation";

type Props = {
  uri?: string | null;
  style: object;
  moderation?: ProductModeration | null;
  productId?: string;
  sellerId?: string | null;
  allowReveal?: boolean;
  resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
  onError?: () => void;
};

export function ModeratedProductImage({
  uri,
  style,
  moderation,
  productId,
  sellerId,
  allowReveal = true,
  resizeMode = "cover",
  onError,
}: Props) {
  const [revealed, setRevealed] = useState(false);
  const shouldBlur = Boolean(moderation?.is_blurred || moderation?.status === "blurred");
  const image = uri ? <Image source={{ uri }} style={style} resizeMode={resizeMode} onError={onError} /> : null;

  if (!shouldBlur || revealed) return image;

  return (
    <View style={[style, styles.cover]}>
      {image}
      <View style={styles.overlay}>
        <Text style={styles.warning}>Sensitive content</Text>
        {allowReveal && (
          <Pressable
            style={styles.revealButton}
            onPress={() => {
              setRevealed(true);
              trackEvent({
                eventType: "sensitive_content_reveal",
                productId,
                sellerId,
              });
            }}
          >
            <Text style={styles.revealText}>View anyway</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: { overflow: "hidden", backgroundColor: "#222" },
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(20,20,20,0.68)", padding: 12 },
  warning: { color: "#fff", fontWeight: "700", marginBottom: 8 },
  revealButton: { borderWidth: 1, borderColor: "rgba(255,255,255,0.8)", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  revealText: { color: "#fff", fontWeight: "600", fontSize: 12 },
});