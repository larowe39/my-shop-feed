import { Ionicons } from "@expo/vector-icons";
import React from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

export type CategorySearchBarProps = {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  onClear?: () => void;
};

export function CategorySearchBar({
  value,
  onChangeText,
  placeholder = "Search items or brands...",
  onClear,
}: CategorySearchBarProps) {
  const handleClear = () => {
    onChangeText("");
    if (onClear) onClear();
  };

  return (
    <View style={styles.container}>
      <Ionicons name="search-outline" size={16} color="#888" style={styles.icon} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#888"
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="never"
        returnKeyType="search"
      />
      {value.length > 0 && (
        <Pressable
          onPress={handleClear}
          style={styles.clearButton}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Clear search text"
        >
          <Ionicons name="close-circle" size={16} color="#888" />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f5f5f5",
    borderWidth: 1,
    borderColor: "#e8e8e8",
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 42,
  },
  icon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    fontSize: 14,
    color: "#111",
    paddingVertical: 0,
  },
  clearButton: {
    padding: 4,
    marginLeft: 6,
  },
});
