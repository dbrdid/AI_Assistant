// ============================================================
// MemoCard.js — 메모 카드 (삼성 메모처럼 "미리보기"가 보이는 카드). 목록 보기 / 격자 보기 두 모양
// ============================================================
// 미리보기: 사진을 붙인 메모는 첫 사진, 손글씨 메모는 손글씨 축소 그림, 글자 메모는 본문 앞부분
// props
//   memo, mode('list'|'grid'), selecting, selected, highlighted, projectTitle, photoUri
//   onPress, onLongPress, onLayout

import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { memoTitle } from '../../../data/memos/MemoStore';
import { pointsToPath } from '../utils/InkUtils';

// "오늘 14:05" / "어제" / "11월 5일" (다른 해는 "2025.11.05")
export function dateLabel(ms, now = new Date()) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (diff === 0) return `오늘 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (diff === 1) return '어제';
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}.${p2(d.getMonth() + 1)}.${p2(d.getDate())}`;
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// 손글씨 축소 그림
function InkPreview({ strokes }) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  strokes.forEach((s) => s.p.forEach(([x, y]) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }));
  if (!isFinite(minX)) return null;
  const pad = 12;
  const w = Math.max(40, maxX - minX + pad * 2);
  const h = Math.max(40, maxY - minY + pad * 2);
  const thin = Math.max(w, h) / 70; // 축소해도 선이 보이게 최소 굵기
  return (
    <Svg width="100%" height="100%" viewBox={`${minX - pad} ${minY - pad} ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
      {strokes.map((s) => (
        <Path key={s.id} d={pointsToPath(s.p)} stroke={s.c} strokeWidth={Math.max(s.w, thin)} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ))}
    </Svg>
  );
}

function Thumb({ memo, photoUri, style }) {
  const hasInk = memo.strokes && memo.strokes.length > 0;
  if (photoUri) return <Image source={{ uri: photoUri }} style={[styles.thumbBase, style]} resizeMode="cover" accessibilityLabel="붙인 사진" />;
  if (hasInk) return <View style={[styles.thumbBase, styles.inkBox, style]}><InkPreview strokes={memo.strokes} /></View>;
  return null;
}

export default function MemoCard({ memo, mode, selecting, selected, highlighted, projectTitle, photoUri, onPress, onLongPress, onLayout }) {
  const hasThumb = !!photoUri || (memo.strokes && memo.strokes.length > 0);
  const body = (memo.body || '').trim();
  const photoCount = (memo.photos || []).length;
  const extra = [photoCount > 0 ? `📷 ${photoCount}` : '', memo.strokes && memo.strokes.length > 0 ? '✎' : ''].filter(Boolean).join('  ');
  const base = [styles.card, mode === 'grid' ? styles.gridCard : styles.listCard, highlighted && styles.focus, selected && styles.on];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`메모 ${memoTitle(memo)} ${selecting ? '선택' : '열기'}`}
      onLayout={onLayout}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [...base, pressed && { opacity: 0.75 }]}
    >
      {mode === 'grid' ? (
        <>
          {hasThumb && <Thumb memo={memo} photoUri={photoUri} style={styles.gridThumb} />}
          <View style={styles.gridText}>
            <Text style={styles.title} numberOfLines={hasThumb ? 1 : 2}>{memo.favorite ? '★ ' : ''}{memoTitle(memo)}</Text>
            {body.length > 0 && <Text style={styles.body} numberOfLines={hasThumb ? 2 : 5}>{body}</Text>}
          </View>
          <View style={styles.foot}>
            <Text style={styles.date} numberOfLines={1}>{dateLabel(memo.updatedAt)}</Text>
            {!!extra && <Text style={styles.extra}>{extra}</Text>}
          </View>
          {!!projectTitle && <Text style={styles.proj} numberOfLines={1}>{projectTitle}</Text>}
          {selecting && <Text style={[styles.check, selected && { color: colors.mintDark }]}>{selected ? '☑' : '☐'}</Text>}
        </>
      ) : (
        <>
          {selecting && <Text style={[styles.checkRow, selected && { color: colors.mintDark }]}>{selected ? '☑' : '☐'}</Text>}
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.title} numberOfLines={1}>{memo.favorite ? '★ ' : ''}{memoTitle(memo)}</Text>
            {body.length > 0 && <Text style={styles.body} numberOfLines={2}>{body}</Text>}
            <View style={styles.metaRow}>
              <Text style={styles.date}>{dateLabel(memo.updatedAt)}</Text>
              {!!extra && <Text style={styles.extra}>{extra}</Text>}
              {!!projectTitle && <Text style={styles.proj} numberOfLines={1}>{projectTitle}</Text>}
            </View>
          </View>
          {hasThumb && <Thumb memo={memo} photoUri={photoUri} style={styles.listThumb} />}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  listCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  gridCard: { width: '48.5%', minHeight: 150 },
  focus: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  on: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  thumbBase: { backgroundColor: colors.line },
  inkBox: { backgroundColor: '#FBFAF4', padding: 4 },
  gridThumb: { width: '100%', height: 104 },
  listThumb: { width: 68, height: 68, borderRadius: radius.sm },
  gridText: { padding: spacing.md, gap: 4, flexGrow: 1 },
  title: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  body: { fontSize: font.body, color: colors.ink, lineHeight: 20, opacity: 0.85 },
  foot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  date: { fontSize: font.caption, color: colors.muted },
  extra: { fontSize: font.caption, color: colors.mintDark, fontWeight: '700' },
  proj: { fontSize: font.caption, fontWeight: '700', color: colors.mintDark, paddingHorizontal: spacing.md, paddingBottom: 2 },
  check: { position: 'absolute', top: 6, right: 8, fontSize: 24, color: colors.muted, textShadowColor: '#fff', textShadowRadius: 4 },
  checkRow: { fontSize: 22, color: colors.muted },
});
