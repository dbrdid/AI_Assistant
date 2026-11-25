import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { memoTitle } from '../../../data/memos/MemoStore';
import { rankSearchRows, searchTerms } from '../../../data/memos/memoSearch.mjs';
import { PillButton } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { appendMemoReference, memoReferenceIds, removeMemoReference } from '../utils/memoReferences.mjs';

export default function MemoReferences({ body, memos, memoId, canEdit, onChange, onOpen }) {
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const referenceIds = isOpen ? memoReferenceIds(body) : new Set();
  const linked = isOpen ? memos.filter(memo => referenceIds.has(memo.id)) : [];
  const backlinks = isOpen && memoId ? memos.filter(memo => memo.id !== memoId && memoReferenceIds(memo.body).has(memoId)) : [];
  const terms = searchTerms(query);
  const candidates = isOpen && canEdit
    ? memos.filter(memo => memo.id !== memoId && !referenceIds.has(memo.id))
      .map(memo => ({ id: memo.id, title: memoTitle(memo) }))
    : [];
  const matchingPages = terms.length ? rankSearchRows(candidates, terms) : candidates;
  const renderLink = (memo, canRemove = false) => (
    <View key={memo.id} style={styles.linkRow}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${memoTitle(memo)} 열기`} style={[styles.row, styles.openLink]} onPress={() => {
        if (onOpen(memo.id)) setOpen(false);
      }}>
        <Text numberOfLines={1} style={styles.rowText}>{memoTitle(memo)}</Text>
      </Pressable>
      {canRemove && <Pressable accessibilityRole="button" accessibilityLabel={`${memoTitle(memo)} 연결 해제`}
        style={[styles.row, styles.unlink]} onPress={() => onChange(removeMemoReference(body, memo.id))}>
        <Text style={styles.empty}>연결 해제</Text>
      </Pressable>}
    </View>
  );
  if (!canEdit && !memoId) return null;
  return (
    <>
      <PillButton kind="ghost" label="관련 페이지" onPress={() => {
        setQuery('');
        setOpen(true);
      }} />
      <Modal transparent visible={isOpen} animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <View accessibilityViewIsModal style={styles.dialog}>
            <Text accessibilityRole="header" style={styles.title}>관련 페이지</Text>
            <ScrollView keyboardShouldPersistTaps="handled" style={styles.list}>
              <Text accessibilityRole="header" style={styles.heading}>이 메모에서 연결한 페이지</Text>
              {linked.map(memo => renderLink(memo, canEdit))}
              {linked.length === 0 && <Text style={styles.empty}>열 수 있는 연결이 없어요.</Text>}
              {linked.length < referenceIds.size && <Text style={styles.empty}>일부 연결은 이 공간에서 열 수 없어요.</Text>}
              <Text accessibilityRole="header" style={styles.heading}>이 메모를 참조한 페이지</Text>
              {backlinks.map(memo => renderLink(memo))}
              {backlinks.length === 0 && <Text style={styles.empty}>아직 이 메모를 참조한 페이지가 없어요.</Text>}
              {canEdit && <>
                <Text accessibilityRole="header" style={styles.heading}>페이지 연결 추가</Text>
                <TextInput accessibilityLabel="연결할 페이지 검색" placeholder="페이지 제목 검색" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} style={styles.input} />
                {matchingPages.map(page => (
                  <Pressable key={page.id} accessibilityRole="button" accessibilityLabel={`${page.title} 연결 추가`} style={styles.row} onPress={() => {
                    onChange(appendMemoReference(body, page.id, page.title));
                    setOpen(false);
                  }}>
                    <Text numberOfLines={1} style={styles.rowText}>+ {page.title}</Text>
                  </Pressable>
                ))}
                {matchingPages.length === 0 && <Text style={styles.empty}>추가할 페이지가 없어요.</Text>}
              </>}
            </ScrollView>
            <PillButton kind="ghost" label="닫기" onPress={() => setOpen(false)} />
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.35)', padding: spacing.lg },
  dialog: { width: '100%', maxWidth: 420, borderRadius: radius.md, backgroundColor: colors.card, padding: spacing.md, gap: spacing.sm },
  title: { fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
  heading: { fontSize: font.body, fontWeight: '500', color: colors.ink, marginTop: spacing.sm },
  empty: { fontSize: font.caption, color: colors.muted, marginVertical: spacing.sm },
  list: { maxHeight: 360 },
  row: { minHeight: 44, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  linkRow: { flexDirection: 'row', alignItems: 'stretch' },
  openLink: { flex: 1, minWidth: 0 },
  unlink: { paddingHorizontal: spacing.sm },
  rowText: { fontSize: font.body, color: colors.ink },
  input: { minHeight: 44, marginTop: spacing.sm, paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.line, color: colors.ink },
});
