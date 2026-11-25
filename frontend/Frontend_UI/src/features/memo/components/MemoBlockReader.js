import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { memoTitle } from '../../../data/memos/MemoStore';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { readMemoBlocks } from '../utils/memoBlocks.mjs';
import { readMemoReference } from '../utils/memoReferences.mjs';

export default function MemoBlockReader({ body, pages, onOpenPage }) {
  const pageById = pages ? new Map(pages.map(page => [page.id, page])) : null;
  return (
    <View style={styles.document}>
      {readMemoBlocks(body).map(({ type, text, checked }, index) => {
        if (!text && type === 'text') return <View key={index} style={styles.blank} />;
        const reference = type === 'text' && readMemoReference(text);
        if (reference) {
          const page = pageById?.get(reference.id);
          const canOpen = Boolean(onOpenPage && page);
          const label = page ? memoTitle(page) : reference.label;
          return <Text key={index} selectable={!canOpen} accessibilityRole={canOpen ? 'link' : undefined}
            onPress={canOpen ? () => onOpenPage(reference.id) : undefined}
            style={[styles.text, canOpen && styles.link]}>
            {pageById && !page ? `${label} · 열 수 없는 페이지` : label}
          </Text>;
        }
        const prefix = type === 'bullet' ? '•  ' : type === 'todo' ? (checked ? '☑  ' : '☐  ') : '';
        const accessibilityLabel = type === 'todo' ? `${checked ? '완료' : '미완료'}, ${text || '제목 없는 할 일'}` : undefined;
        return (
          <Text
            key={index}
            selectable
            accessibilityRole={type === 'heading' ? 'header' : undefined}
            accessibilityLabel={accessibilityLabel}
            style={[styles.text, type === 'heading' && styles.heading, checked && styles.completed]}
          >
            {prefix}{text}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  document: { paddingTop: spacing.sm, paddingBottom: spacing.xl },
  text: { fontSize: font.bodyLg, lineHeight: 26, color: colors.ink },
  heading: { marginTop: spacing.md, marginBottom: spacing.xs, fontSize: 21, lineHeight: 29, fontWeight: '500' },
  completed: { color: colors.muted, textDecorationLine: 'line-through' },
  link: { color: colors.mintDark, textDecorationLine: 'underline' },
  blank: { height: 13 },
});
