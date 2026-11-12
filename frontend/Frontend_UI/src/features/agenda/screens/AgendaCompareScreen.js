// ============================================================
// AgendaCompareScreen.js — 안건 비교
// ============================================================

import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { toKey } from '../../calendar/utils/DateUtils';
import { TYPE_INFO, openParams, useMemos } from '../../../data/memos/MemoStore';
import { captureNow, computeChanges, daysFor, subscribeAgenda } from '../../../data/agenda/AgendaStore';
import { useFiles } from '../../../data/files/FileStore';
import { useProjects } from '../../../data/projects/ProjectStore';
import { useTasks } from '../../../data/tasks/TaskStore';
import { judgeDiscussion } from '../../../services/ai/AgendaJudge';
import { diffExcerpt, longDateKey, shortDateKey } from '../utils/AgendaUtils';

const STATUS = {
  added: { label: '추가됨', color: '#2A6858', bg: '#DCEBE6' },
  changed: { label: '내용 바뀜', color: '#9A6A00', bg: '#FFF1CC' },
  removed: { label: '삭제됨', color: '#C2494B', bg: '#FDE3E3' },
};
const JUDGE = {
  discussed: { label: '논의됨', color: '#2A6858', bg: '#DCEBE6' },
  open: { label: '미논의', color: '#C2494B', bg: '#FDE3E3' },
};
const KIND = { memo: '메모', task: '일정/할 일', file: '파일' };

function useAgendaTick() {
  const [, setN] = useState(0);
  useEffect(() => subscribeAgenda(() => setN((n) => n + 1)), []);
}

export default function AgendaCompareScreen({ navigation, route }) {
  const projects = useProjects();
  const memos = useMemos();
  const tasks = useTasks();
  const files = useFiles();
  useAgendaTick();

  const today = toKey(new Date());
  const ordered = useMemo(
    () => projects.slice().sort((a, b) => (b.members.length >= 2) - (a.members.length >= 2) || b.updatedAt - a.updatedAt),
    [projects],
  );
  const [pid, setPid] = useState(route?.params?.projectId || null);
  const project = ordered.find((p) => p.id === pid) || ordered[0] || null;
  const [day, setDay] = useState(today);
  const [open, setOpen] = useState({}); // 펼친 항목 key
  const [judged, setJudged] = useState({});

  // 화면을 열 때 오늘 기록을 한 번 갱신
  useEffect(() => {
    captureNow();
  }, []);

  const days = project ? daysFor(project.id) : [today];
  const idx = Math.max(0, days.indexOf(day));
  const result = useMemo(
    () => computeChanges(project, day),
    // 메모·할 일·파일·프로젝트가 바뀌면 다시 계산
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [project, day, memos, tasks, files, projects],
  );
  const { changes, basis, prevDay } = result;

  // AI 판단 (지금은 비어 있음 → 표시 없음)
  useEffect(() => {
    let alive = true;
    setJudged({});
    if (changes.length) {
      judgeDiscussion(changes)
        .then((r) => alive && setJudged(r || {}))
        .catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [project?.id, day, changes.length]);

  const count = { added: 0, changed: 0, removed: 0 };
  changes.forEach((c) => (count[c.status] += 1));
  const judgedVals = Object.values(judged);
  const nDiscussed = judgedVals.filter((v) => v === 'discussed').length;
  const nOpen = judgedVals.filter((v) => v === 'open').length;

  const move = (n) => {
    const i = idx + n;
    if (i >= 0 && i < days.length) setDay(days[i]);
  };

  const order = { added: 0, changed: 1, removed: 2 };
  const sorted = changes.slice().sort((a, b) => order[a.status] - order[b.status]);

  return (
    <View style={styles.root}>
      <ScreenHeader title="안건 비교" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        {!project ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>비교할 프로젝트가 없어요</Text>
            <Text style={styles.emptySub}>프로젝트를 만들고 메모·할 일·파일을 연결하면{'\n'}하루 단위로 달라진 점을 알려드려요.</Text>
          </View>
        ) : (
          <>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {ordered.map((p) => (
                <Pressable
                  key={p.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: p.id === project.id }}
                  onPress={() => { setPid(p.id); setDay(today); setOpen({}); }}
                  style={[styles.chip, p.id === project.id && styles.chipOn]}
                >
                  <Text style={[styles.chipText, p.id === project.id && { color: colors.white }]} numberOfLines={1}>
                    {p.members.length >= 2 ? '👥 ' : ''}{p.title || '(제목 없음)'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.dayRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="이전 기록 날짜" disabled={idx <= 0} onPress={() => move(-1)} style={[styles.arrow, idx <= 0 && { opacity: 0.3 }]}>
                <Text style={styles.arrowText}>‹</Text>
              </Pressable>
              <View style={{ alignItems: 'center', flex: 1 }}>
                <Text style={styles.dayText}>{longDateKey(day)}{day === today ? ' (오늘)' : ''}</Text>
                <Text style={styles.daySub}>{prevDay ? `${shortDateKey(prevDay)} 기록과 비교` : basis === 'timestamp' ? '이전 기록 없음 · 작성/수정 시각 기준' : ' '}</Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="다음 기록 날짜" disabled={idx >= days.length - 1} onPress={() => move(1)} style={[styles.arrow, idx >= days.length - 1 && { opacity: 0.3 }]}>
                <Text style={styles.arrowText}>›</Text>
              </Pressable>
            </View>

            <View style={styles.summary} accessibilityLabel={`추가 ${count.added}, 내용 바뀜 ${count.changed}, 삭제 ${count.removed}`}>
              <Text style={styles.summaryText}>추가 {count.added} · 내용 바뀜 {count.changed} · 삭제 {count.removed}</Text>
              {judgedVals.length > 0 && <Text style={styles.summarySub}>논의됨 {nDiscussed} · 미논의 {nOpen}</Text>}
            </View>

            {changes.length === 0 && (
              <Text style={styles.hint}>
                {Object.keys(project.links.memos).length + project.links.tasks.length + project.links.files.length === 0
                  ? '이 프로젝트에 연결된 메모·할 일·파일이 아직 없어요.'
                  : '이 날은 달라진 내용이 없어요.'}
              </Text>
            )}

            {sorted.map((c) => {
              const st = STATUS[c.status];
              const j = JUDGE[judged[c.key]];
              const isOpen = !!open[c.key];
              const title = diffExcerpt(c.titleBefore, c.title);
              const body = diffExcerpt(c.bodyBefore, c.bodyAfter);
              const canOpen = c.status !== 'removed';
              return (
                <View key={c.key} style={styles.card}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${KIND[c.kind]} ${c.title}, ${st.label}, ${isOpen ? '접기' : '자세히 보기'}`}
                    onPress={() => setOpen((o) => ({ ...o, [c.key]: !o[c.key] }))}
                    style={styles.cardHead}
                  >
                    <Text style={styles.icon}>{TYPE_INFO[c.kind].icon}</Text>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.cardTitle} numberOfLines={isOpen ? 3 : 1}>{c.title || '(제목 없음)'}</Text>
                      <Text style={styles.cardKind}>{KIND[c.kind]}</Text>
                    </View>
                    <View style={{ gap: 4, alignItems: 'flex-end' }}>
                      <View style={[styles.badge, { backgroundColor: st.bg }]}><Text style={[styles.badgeText, { color: st.color }]}>{st.label}</Text></View>
                      {j && <View style={[styles.badge, { backgroundColor: j.bg }]}><Text style={[styles.badgeText, { color: j.color }]}>{j.label}</Text></View>}
                    </View>
                  </Pressable>

                  {isOpen && (
                    <View style={styles.detail}>
                      {c.status === 'changed' && c.hasBefore && (
                        <>
                          {c.titleChanged && <Diff label="제목" before={title.before} after={title.after} />}
                          {c.bodyChanged && <Diff label="내용" before={body.before} after={body.after} />}
                        </>
                      )}
                      {c.status === 'changed' && !c.hasBefore && <Text style={styles.detailText}>이 날 수정됐어요. (이전 내용 기록이 없어 비교는 어려워요)</Text>}
                      {c.status === 'added' && <Text style={styles.detailText} numberOfLines={6}>{c.bodyAfter ? c.bodyAfter : '내용이 없어요.'}</Text>}
                      {c.status === 'removed' && <Text style={styles.detailText}>이 항목은 프로젝트에서 빠졌어요(삭제되었거나 연결이 해제됨).</Text>}
                      {canOpen && (
                        <Pressable
                          accessibilityRole="button"
                          onPress={() => navigation.navigate(TYPE_INFO[c.kind].route, openParams(c.kind, c.id))}
                          style={styles.openBtn}
                        >
                          <Text style={styles.openText}>열기</Text>
                        </Pressable>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
            <Text style={styles.foot}>
              논의됨 / 미논의 표시는 AI 가 연결되면 자동으로 나타나요. 미논의 안건은 알림 기능에서 확인 · 보류로 다룰 수 있게 할 예정이에요.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Diff({ label, before, after }) {
  return (
    <View style={styles.diff}>
      <Text style={styles.diffLabel}>{label}</Text>
      <View style={[styles.diffBox, { backgroundColor: '#FDE3E3' }]}><Text style={styles.diffText}>이전  {before || '(비어 있음)'}</Text></View>
      <View style={[styles.diffBox, { backgroundColor: '#DCEBE6' }]}><Text style={styles.diffText}>이후  {after || '(비어 있음)'}</Text></View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  chips: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: { maxWidth: 220, paddingHorizontal: spacing.lg, minHeight: 40, borderRadius: 20, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  arrow: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  arrowText: { fontSize: 24, color: colors.ink, marginTop: -2 },
  dayText: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  daySub: { fontSize: font.caption, color: colors.muted },
  summary: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.mintSoft, alignItems: 'center', gap: 4 },
  summaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.mintDark },
  summarySub: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  hint: { fontSize: font.body, color: colors.muted, textAlign: 'center', paddingVertical: spacing.lg },
  empty: { padding: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, gap: spacing.sm, alignItems: 'center' },
  emptyTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  emptySub: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  card: { borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, minHeight: 60 },
  icon: { fontSize: 20 },
  cardTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  cardKind: { fontSize: font.caption, color: colors.muted },
  badge: { paddingHorizontal: spacing.md, minHeight: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: font.caption, fontWeight: '800' },
  detail: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, gap: spacing.sm },
  detailText: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  diff: { gap: 4 },
  diffLabel: { fontSize: font.caption, fontWeight: '800', color: colors.muted },
  diffBox: { padding: spacing.md, borderRadius: radius.sm || 8 },
  diffText: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  openBtn: { alignSelf: 'flex-start', minHeight: 40, paddingHorizontal: spacing.lg, borderRadius: radius.md, borderWidth: 1, borderColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  openText: { fontSize: font.body, fontWeight: '800', color: colors.mintDark },
  foot: { fontSize: font.caption, color: colors.muted, lineHeight: 18, marginTop: spacing.sm },
});
