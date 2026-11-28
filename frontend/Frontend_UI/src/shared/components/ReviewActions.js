import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/theme';

export default function ReviewActions({ actions }) {
  return <View style={styles.row}>
    {actions.filter(Boolean).map(({ label, onPress, primary, danger, disabled }) => (
      <Pressable key={label} accessibilityRole="button" disabled={disabled} onPress={onPress}
        style={({ pressed }) => [styles.button, (pressed || disabled) && styles.dimmed]}>
        <Text style={[styles.label, primary && styles.primary, danger && styles.danger]}>{label}</Text>
      </Pressable>
    ))}
  </View>;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', columnGap: 4, alignItems: 'center' },
  button: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center', alignItems: 'center' },
  dimmed: { opacity: 0.55 },
  label: { fontSize: 13, color: colors.muted, paddingVertical: 4 },
  primary: { color: colors.ink, fontWeight: '600' },
  danger: { color: colors.coral },
});
