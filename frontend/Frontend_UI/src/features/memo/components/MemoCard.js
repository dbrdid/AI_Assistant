// ============================================================
// MemoCard.js — 메모 미리보기
// ============================================================

import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { memoTitle } from '../../../data/memos/MemoStore';
import { pointsToPath } from '../utils/InkUtils';
import Icon from '../../../shared/components/Icon';
import { IconTile, Tag } from '../../../shared/components/Ui';
import SpaceTag from '../../../shared/components/SpaceTag';

// 별 모양 (Icon.js 의 star 와 같은 24x24 경로)
const STAR_D = 'M11.53 2.3a.53.53 0 0 1 .94 0l2.31 4.68a2.12 2.12 0 0 0 1.6 1.16l5.16.76a.53.53 0 0 1 .3.9l-3.74 3.64a2.12 2.12 0 0 0-.61 1.88l.88 5.14a.53.53 0 0 1-.77.56l-4.62-2.43a2.12 2.12 0 0 0-1.97 0L6.4 21.01a.53.53 0 0 1-.77-.56l.88-5.14a2.12 2.12 0 0 0-.61-1.88L2.16 9.8a.53.53 0 0 1 .29-.9l5.17-.76a2.12 2.12 0 0 0 1.6-1.16z';

// "오늘 14:05" / "어제" / "11월 5일" (다른 해는 "2025.11.05")
// yesterdayTime 이 true 면 어제도 시간까지: "어제 10:12" (메모 카드용)
export function dateLabel(ms, now = new Date(), yesterdayTime = false) {
  const d = new Date(ms);
  const p2 = (n) => String(n).padStart(2, '0');
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  if (diff === 0) return `오늘 ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (diff === 1) return yesterdayTime ? `어제 ${p2(d.getHours())}:${p2(d.getMinutes())}` : '어제';
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

// 채운 별 (즐겨찾기 표시). Icon 의 star 는 선만 있어서 여기서 채워 그림
export function FilledStar({ size = 16, color = colors.coral }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={STAR_D} fill={color} stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </Svg>
  );
}

// 선택 모드 체크 상자
function Check({ on, style }) {
  return (
    <View style={style} pointerEvents="none">
      <Icon name={on ? 'checkSquare' : 'square'} size={24} color={on ? colors.mintDark : colors.muted} strokeWidth={on ? 2.2 : 1.8} />
    </View>
  );
}

export default function MemoCard({ memo, mode, selecting, selected, highlighted, projectTitle, space, photoUri, onPress, onLongPress, onLayout }) {
  const hasInk = !!(memo.strokes && memo.strokes.length > 0);
  const hasThumb = !!photoUri || hasInk;
  const body = (memo.body || '').trim();
  const photoCount = (memo.photos || []).length;
  const base = [styles.card, mode === 'grid' ? styles.gridCard : styles.listCard, highlighted && styles.focus, selected && styles.on];

  // 제목 줄: (즐겨찾기면 코랄 별) + 굵은 제목
  const titleRow = (lines) => (
    <View style={styles.titleRow}>
      {memo.favorite && <FilledStar size={16} />}
      <Text style={styles.title} numberOfLines={lines}>{memoTitle(memo)}</Text>
    </View>
  );
  // 정보 줄: 시간 · 사진 수 · 손글씨(격자 보기) · 프로젝트 꼬리표
  const meta = (showInk) => (
    <View style={styles.metaRow}>
      <Text style={styles.date} numberOfLines={1}>{dateLabel(memo.updatedAt, new Date(), true)}</Text>
      {photoCount > 0 && (
        <View style={styles.count} accessibilityLabel={`사진 ${photoCount}장`}>
          <Icon name="image" size={13} color={colors.muted} />
          <Text style={styles.date}>{photoCount}</Text>
        </View>
      )}
      {showInk && hasInk && <Icon name="pencil" size={13} color={colors.muted} />}
      {!!projectTitle && <Tag label={projectTitle} style={styles.tag} />}
      {space && <SpaceTag space={space} />}
    </View>
  );

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
            {titleRow(hasThumb ? 1 : 2)}
            {body.length > 0 && <Text style={styles.body} numberOfLines={hasThumb ? 2 : 5}>{body}</Text>}
          </View>
          <View style={styles.foot}>{meta(true)}</View>
          {selecting && <Check on={selected} style={styles.check} />}
        </>
      ) : (
        <>
          {selecting && <Check on={selected} />}
          <View style={styles.listText}>
            {titleRow(1)}
            {body.length > 0 && <Text style={styles.body} numberOfLines={1}>{body}</Text>}
            {meta(false)}
          </View>
          {/* 오른쪽 타일: 사진이 있으면 사진 아이콘, 손글씨만 있으면 연필 아이콘 */}
          {hasThumb && <IconTile icon={photoCount > 0 || photoUri ? 'image' : 'pencil'} size={68} iconSize={26} style={styles.listTile} />}
        </>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  listCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, minHeight: 100 },
  gridCard: { width: '48.5%', minHeight: 150 },
  focus: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  on: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  thumbBase: { backgroundColor: colors.mintSoft },
  inkBox: { backgroundColor: '#FBFAF4', padding: 4 },
  gridThumb: { width: '100%', height: 104 },
  listTile: { borderRadius: radius.md },
  listText: { flex: 1, gap: 6 },
  gridText: { padding: spacing.md, gap: 4, flexGrow: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { flexShrink: 1, fontSize: font.header, fontWeight: '800', color: colors.ink },
  body: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  foot: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  count: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  date: { fontSize: font.caption, color: colors.muted },
  tag: { maxWidth: 160 },
  check: { position: 'absolute', top: 8, right: 8, backgroundColor: colors.white, borderRadius: 6 },
});
