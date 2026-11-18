// ============================================================
// ProposalCard.js — AI 제안 카드 하나 (종류 · 제목 · 일시 · 근거 + [추가][수정][보류][무시])
// ============================================================

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from '../../../shared/components/Icon';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { WEEKDAYS, fromKey } from '../../calendar/utils/DateUtils';
import { reviewReason } from '../useProposalActions';

export const KIND_LABEL = { event: '일정', task: '할 일', memo: '메모' };
const SRC = { memo: '메모', record: '녹음' };

// '11/21 (금) 14:00 · 공학관 301'
export function proposalWhen(p) {
  const parts = [];
  if (p.date) {
    const d = fromKey(p.date);
    parts.push(`${d.getMonth() + 1}/${d.getDate()} (${WEEKDAYS[d.getDay()]})${p.start ? ` ${p.start}` : ''}`);
  }
  if (p.place) parts.push(p.place);
  return parts.join(' · ');
}

function Btn({ label, onPress, primary, danger }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.btn, primary && styles.btnPrimary, pressed && { opacity: 0.7 }]}
    >
      <Text style={[styles.btnText, primary && { color: colors.white }, danger && { color: colors.coral }]}>{label}</Text>
    </Pressable>
  );
}

export default function ProposalCard({ p, actions, showHold = true, tone = 'card' }) {
  const reason = reviewReason(p);
  const when = proposalWhen(p);
  return (
    <View style={[styles.card, tone === 'soft' && styles.soft, !!reason && tone === 'card' && styles.warnCard]}>
      <View style={styles.head}>
        <View style={styles.badge}><Text style={styles.badgeText}>{KIND_LABEL[p.kind] || '제안'}</Text></View>
        <Text style={styles.src} numberOfLines={1}>
          {SRC[p.sourceType] || '메모'}{p.sourceTitle ? ` “${p.sourceTitle}”` : ''}에서 찾음
        </Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>{p.title || '(제목 없음)'}</Text>
      {!!when && <Text style={styles.when}>{when}</Text>}
      {!!p.evidence && <Text style={styles.evidence} numberOfLines={2}>“{p.evidence}”</Text>}
      {!!reason && (
        <View style={styles.reason}>
          <Icon name="alert" size={14} color={colors.coral} />
          <Text style={styles.reasonText}>{reason}</Text>
        </View>
      )}
      <View style={styles.row}>
        <Btn primary label={reason ? '확인하고 추가' : '추가'} onPress={() => actions.add(p)} />
        {!reason && <Btn label="수정" onPress={() => actions.edit(p)} />}
        {showHold && p.status !== 'hold' && <Btn label="보류" onPress={() => actions.hold(p)} />}
        <Btn danger label="무시" onPress={() => actions.dismiss(p)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, padding: spacing.lg, gap: 6 },
  soft: { backgroundColor: colors.white, borderColor: colors.white, padding: spacing.md },
  warnCard: { borderColor: colors.coral },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  badge: { backgroundColor: colors.mintSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: colors.mintDark, fontSize: font.caption, fontWeight: '800' },
  src: { flex: 1, fontSize: font.caption, color: colors.muted },
  title: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  when: { fontSize: font.body, color: colors.ink },
  evidence: { fontSize: 13, color: colors.muted, lineHeight: 19 },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  reasonText: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.coral },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: 4 },
  btn: { minHeight: 36, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  btnPrimary: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  btnText: { fontSize: font.body, fontWeight: '800', color: colors.ink },
});
