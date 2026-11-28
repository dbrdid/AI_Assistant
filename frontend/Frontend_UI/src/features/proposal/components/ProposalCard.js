import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from '../../../shared/components/Icon';
import ReviewActions from '../../../shared/components/ReviewActions';
import { colors } from '../../../shared/theme/theme';
import { WEEKDAYS, fromKey } from '../../calendar/utils/DateUtils';
import { reviewReason } from '../useProposalActions';

export const KIND_LABEL = { event: '일정', task: '할 일', memo: '문서' };
const KIND_ICON = { event: 'calendar', task: 'checkSquare', memo: 'file' };

export function proposalWhen(p) {
  const parts = [];
  if (p.date) {
    const date = fromKey(p.date);
    parts.push(`${date.getMonth() + 1}월 ${date.getDate()}일 (${WEEKDAYS[date.getDay()]})${p.start ? ` ${p.start}` : ''}`);
  }
  if (p.place) parts.push(p.place);
  return parts.join(', ');
}

export default function ProposalCard({ p, actions, expanded, onToggle, onSource, onPlace, confirmFirst, readOnly }) {
  const [open, setOpen] = useState(false);
  const selected = expanded ?? open;
  const reason = selected ? reviewReason(p) : null;
  const metadata = [KIND_LABEL[p.kind] || '제안', proposalWhen(p)].filter(Boolean).join(', ');
  const source = p.sourceTitle || (p.sourceType === 'record' ? '녹음' : '원본 문서');

  return <View style={[styles.item, selected && styles.selected]}>
    <Pressable accessibilityRole="button" accessibilityLabel={p.title || '제목 없는 제안'}
      accessibilityState={{ expanded: selected }} onPress={onToggle ?? (() => setOpen(value => !value))} style={styles.heading}>
      <Icon name={KIND_ICON[p.kind] ?? 'file'} size={17} color={colors.muted} />
      <View style={styles.details}>
        <Text style={styles.title}>{p.title || '제목 없는 제안'}</Text>
        <Text style={styles.meta}>{metadata}</Text>
      </View>
      <Icon name={selected ? 'chevronUp' : 'chevronDown'} size={14} color={colors.muted} />
    </Pressable>
    {selected && <View style={styles.content}>
      {!!(p.body || p.evidence) && <Text selectable style={styles.body}>{p.body || p.evidence}</Text>}
      {!!p.body && !!p.evidence && p.evidence !== p.body && <Text selectable style={styles.meta}>근거: {p.evidence}</Text>}
      {p.sourceType === 'memo' && p.sourceId && onSource
        ? <Pressable accessibilityRole="button" onPress={onSource} style={styles.source}>
            <Icon name="file" size={14} color={colors.muted} /><Text style={styles.meta}>출처: {source}</Text>
          </Pressable>
        : (p.sourceTitle || p.sourceType === 'record') && <Text style={styles.meta}>출처: {source}</Text>}
      {!!reason && <Text style={styles.warning} accessibilityRole="alert" accessibilityLabel={`경고: ${reason}`}>{reason}</Text>}
      {!readOnly && <ReviewActions actions={[
        p.status !== 'hold' && { label: '보류', onPress: () => actions.hold(p) },
        { label: '무시', onPress: () => actions.dismiss(p), danger: true },
        onPlace && (p.kind === 'memo' || (p.sourceType === 'memo' && p.sourceId && !reason)) && { label: '문서에 넣기', onPress: onPlace },
        !reason && !confirmFirst && { label: '수정', onPress: () => actions.edit(p) },
        { label: reason ? '내용 확인' : confirmFirst ? '확인 후 저장' : '추가', onPress: () => (confirmFirst ? actions.edit : actions.add)(p), primary: true },
      ]} />}
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  item: { borderWidth: 1, borderColor: 'transparent', borderRadius: 6 },
  selected: { borderColor: colors.actionBorder, backgroundColor: colors.card },
  heading: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8 },
  details: { flex: 1, gap: 3 },
  title: { fontSize: 15, fontWeight: '600', color: colors.ink },
  meta: { fontSize: 12, color: colors.muted, lineHeight: 18, flexShrink: 1 },
  content: { paddingHorizontal: 10, paddingBottom: 3, gap: 6 },
  body: { fontSize: 14, lineHeight: 21, color: colors.ink },
  source: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6 },
  warning: { fontSize: 13, lineHeight: 19, color: colors.coral },
});
