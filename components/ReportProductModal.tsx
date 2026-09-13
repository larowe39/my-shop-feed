import React, { useState } from "react";
import { Alert, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { trackEvent } from "../lib/analytics";
import { supabase } from "../lib/supabase";

const REASONS = [
  ["nudity", "Nudity or sexual content"],
  ["violence", "Violence or graphic content"],
  ["hate", "Hate or harassment"],
  ["scam", "Scam or misleading listing"],
  ["illegal", "Illegal or prohibited item"],
  ["spam", "Spam"],
  ["other", "Other"],
] as const;

type Props = { visible: boolean; productId: string; onClose: () => void };

export function ReportProductModal({ visible, productId, onClose }: Props) {
  const [reason, setReason] = useState<(typeof REASONS)[number][0] | null>(null);
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!reason || submitting) return;
    setSubmitting(true);
    const { error } = await supabase.from("product_reports").insert({
      product_id: productId,
      reason,
      details: details.trim() || null,
    });
    setSubmitting(false);
    if (error) {
      if (error.code === "23505") Alert.alert("Already reported", "Thanks. You have already submitted this report.");
      else Alert.alert("Report unavailable", "We couldn't submit your report right now.");
      return;
    }
    trackEvent({ eventType: "product_report", productId, metadata: { reason } });
    setReason(null);
    setDetails("");
    onClose();
    Alert.alert("Report submitted", "Thanks. We'll review this product.");
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Report product</Text>
          {REASONS.map(([value, label]) => (
            <Pressable key={value} style={styles.reason} onPress={() => setReason(value)}>
              <Text style={[styles.reasonText, reason === value && styles.selected]}>{label}</Text>
            </Pressable>
          ))}
          <TextInput
            value={details}
            onChangeText={setDetails}
            placeholder="Add details (optional)"
            multiline
            style={styles.input}
          />
          <View style={styles.actions}>
            <Pressable onPress={onClose} style={styles.cancel}><Text>Cancel</Text></Pressable>
            <Pressable disabled={!reason || submitting} onPress={submit} style={[styles.submit, !reason && styles.disabled]}><Text style={styles.submitText}>Submit</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: { backgroundColor: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 20, gap: 8 },
  title: { fontSize: 20, fontWeight: "800", marginBottom: 6 },
  reason: { paddingVertical: 9 },
  reasonText: { color: "#222", fontSize: 15 },
  selected: { fontWeight: "800", color: "#b00020" },
  input: { minHeight: 64, borderWidth: 1, borderColor: "#ddd", borderRadius: 8, padding: 10, textAlignVertical: "top" },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 8 },
  cancel: { padding: 12 },
  submit: { backgroundColor: "#111", borderRadius: 8, paddingHorizontal: 18, paddingVertical: 12 },
  disabled: { opacity: 0.4 },
  submitText: { color: "#fff", fontWeight: "700" },
});