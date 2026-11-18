// ============================================================
// HomeScreen.js — 하단 탭 '오늘' (홈)
// ============================================================
// 모든 공간(개인 + 팀)을 합쳐서 보여 줍니다. 항목마다 공간 색 점이 붙어요.
// 위에서부터: 나 · 날짜 · AI · 검색 · 알림 / AI 제안 카드 / 팀 공간 요약 / 오늘 일정 / 오늘 할 일
// 맨 아래: 바로 쓰는 입력줄 (어느 공간에 쓸지 고르는 칩 · 글 메모 저장 · 사진 · 카메라 · 녹음)

import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import Bell from '../../notice/components/Bell';
import RecordSheet from '../../record/components/RecordSheet';
import ProposalCard from '../../proposal/components/ProposalCard';
import { useProposalActions } from '../../proposal/useProposalActions';
import { useRecorder } from '../../../services/device/Recorder';
import { analyzeText } from '../../../services/ai/AiAnalyze';
import { addRecording } from '../../../data/files/FileStore';
import { addUsage, useSettings } from '../../../data/settings/SettingsStore';
import { enterSpace, useSpaceInfo, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import { addMemo } from '../../../data/memos/MemoStore';
import { useProposals } from '../../../data/proposals/ProposalStore';
import { classify, lastDate, occursOn, taskIn, useAllTasks } from '../../../data/tasks/TaskStore';
import { WEEKDAYS_LONG, toKey } from '../../calendar/utils/DateUtils';
import { ROUTES } from '../../../navigation/routes';
import Icon from '../../../shared/components/Icon';
import SpaceTag, { SpaceDot } from '../../../shared/components/SpaceTag';
import { CircleButton } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

const MAX_LEN = 2000;
const CAPTURE_HEIGHT = 64; // 입력줄 높이 (안내 띠를 그 위에 띄우는 데 씀)

// 초 → "01:05"
const formatTime = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

function SectionHead({ title, onAdd, addLabel }) {
  return (
    <View style={styles.sectionHead}>
      <Text style={styles.sectionTitle} accessibilityRole="header">{title}</Text>
      {onAdd && (
        <Pressable accessibilityRole="button" accessibilityLabel={addLabel} onPress={onAdd} hitSlop={8} style={({ pressed }) => [styles.addLink, pressed && { opacity: 0.6 }]}>
          <Icon name="plus" size={14} color={colors.mintDark} strokeWidth={2.4} />
          <Text style={styles.addLinkText}>추가</Text>
        </Pressable>
      )}
    </View>
  );
}

export default function HomeScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const go = (route, params) => navigation.navigate(route, params);
  const settings = useSettings();
  const myName = settings.profile?.name?.trim() || '';

  // ---------- 공간 ----------
  const { list: spacesList } = useWorkspaces();
  const spaces = useSpaceInfo();
  const teams = spacesList.filter((w) => !w.personal);
  const personalId = spacesList.find((w) => w.personal)?.id;
  const multi = teams.length > 0; // 팀 공간이 있을 때만 공간 표시를 붙임
  // 그 항목의 공간으로 바꾼 뒤 편집 화면 열기 (편집 화면은 현재 공간의 프로젝트 등을 씀)
  const openTask = (t) => {
    enterSpace(t.workspaceId);
    go(ROUTES.TaskEdit, { taskId: t.id });
  };

  // ---------- AI 제안 (목록에서 바로 처리) + 아래 안내 띠 ----------
  const actions = useProposalActions(navigation, { bottom: CAPTURE_HEIGHT + spacing.sm });
  const snack = actions.snack;
  const waiting = useProposals().filter((p) => p.status === 'pending' && !actions.hidden.has(p.id));

  // ---------- 오늘 일정 / 할 일 (모든 공간) ----------
  const now = new Date();
  const todayKey = toKey(now);
  const tasks = useAllTasks();
  const events = tasks
    .filter((t) => t.kind === 'event' && occursOn(t, todayKey))
    .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
  const todos = tasks
    .filter((t) => t.kind !== 'event' && (occursOn(t, todayKey) || classify(t, todayKey) === 'overdue'))
    .sort((a, b) => (a.status === '완료') - (b.status === '완료') || a.date.localeCompare(b.date));
  const left = todos.filter((t) => t.status !== '완료').length;

  const toggle = (t) => {
    try {
      taskIn(t, 'toggleDone', t.id);
    } catch (e) {
      snack.show(e.code === 'read_only' ? '보기 전용 공간이라 바꿀 수 없어요' : '바꾸지 못했어요');
      return;
    }
    if (t.status !== '완료') snack.show(`“${t.title}” 완료`, { label: '되돌리기', onPress: () => taskIn(t, 'toggleDone', t.id) });
  };

  // 팀 공간 요약: 오늘 일정 수 · 남은 할 일 수 (실제 기록으로 계산)
  const teamSummary = teams.map((w) => {
    const mine = tasks.filter((t) => t.workspaceId === w.id && t.status !== '완료');
    const today = mine.filter((t) => occursOn(t, todayKey)).length;
    const late = mine.filter((t) => lastDate(t) < todayKey).length;
    const week = mine.filter((t) => daysBetween(todayKey, t.date) > 0 && daysBetween(todayKey, t.date) <= 7).length;
    const parts = [today ? `오늘 ${today}` : '', late ? `기한 지남 ${late}` : '', week ? `일주일 안 ${week}` : ''].filter(Boolean);
    return { w, text: parts.length ? parts.join(' · ') : '이번 주 예정 없음', alert: late > 0 };
  });

  // ---------- 입력줄: 어느 공간에 쓸지 + 글 메모 ----------
  const [target, setTarget] = useState(null); // 공간 id (null = 개인 공간)
  const targetId = target && spaces[target] && !spaces[target].readOnly ? target : personalId;
  const [pickSpace, setPickSpace] = useState(false);
  const [text, setText] = useState('');
  const saveMemo = () => {
    const body = text.trim();
    if (!body) return;
    let memo;
    try {
      enterSpace(targetId); // 그 공간에 저장하고, AI 분석 결과(제안)도 그 공간에 쌓임
      memo = addMemo({ title: '', body, taskIds: [] });
    } catch (e) {
      snack.show(e.code === 'read_only' ? '보기 전용 공간에는 쓸 수 없어요' : '메모를 저장하지 못했어요');
      return;
    }
    setText('');
    const where = multi ? `${spaces[targetId]?.name ?? ''}에 ` : '';
    snack.show(`${where}메모를 저장했어요`, { label: '열기', onPress: () => go(ROUTES.MemoEdit, { memoId: memo.id }) });
    // AI 자동 분석이 켜져 있으면 일정·할 일 후보를 찾아 위의 제안 카드로 보여 줌
    analyzeText({ sourceType: 'memo', sourceId: memo.id }).then((r) => {
      if (r && r.added) snack.show(`AI가 일정·할 일 ${r.added}건을 찾았어요`, { label: '확인', onPress: () => go(ROUTES.Proposals) });
    });
  };

  // ---------- 입력줄: 녹음 (끝나면 파일 보관함에 저장하고 안내 창) ----------
  const rec = useRecorder();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [recSheet, setRecSheet] = useState(null); // { state, uri, seconds, fileId }
  const recBusy = useRef(false); // 시작/종료 처리 중에 또 눌러도 무시
  useEffect(() => {
    if (!recording) return undefined;
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);
  const toggleRecording = async () => {
    if (recBusy.current) return;
    recBusy.current = true;
    try {
      if (recording) {
        setRecording(false);
        const uri = await rec.stop();
        if (!uri) return setRecSheet({ state: 'error' });
        // 웹 등 기기 파일로 저장할 수 없는 환경이면 보관 없이 진행 (녹음 듣기·변환은 그대로 됨)
        const saved = await addRecording(uri, seconds).catch(() => null);
        addUsage('voice', Math.max(1, Math.ceil(seconds / 60))); // 녹음 이용량은 분 단위
        setRecSheet({ state: 'saved', uri, seconds, fileId: saved?.id ?? null });
      } else {
        const r = await rec.start();
        if (!r.ok) return setRecSheet({ state: r.reason === 'denied' ? 'denied' : 'error' });
        setSeconds(0);
        setRecording(true);
      }
    } finally {
      recBusy.current = false;
    }
  };

  const dateText = `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEKDAYS_LONG[now.getDay()]}`;
  const targetSpace = spaces[targetId];

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* ---------- 머리: 나 · 날짜 · AI · 검색 · 알림 ---------- */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="나 · 설정" onPress={() => go(ROUTES.More)} hitSlop={6} style={({ pressed }) => [styles.me, pressed && { opacity: 0.7 }]}>
          <Text style={styles.meText}>{myName ? myName.charAt(0) : '나'}</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.date} accessibilityRole="header" numberOfLines={1}>{dateText}</Text>
          {multi && <Text style={styles.scope}>모든 공간 · 개인 + 팀 {teams.length}개</Text>}
        </View>
        <CircleButton icon="sparkles" label="AI 채팅" color={colors.mintDark} onPress={() => go(ROUTES.Ai)} />
        <CircleButton icon="search" label="검색" onPress={() => go(ROUTES.Search)} />
        <Bell onPress={() => go(ROUTES.Notices)} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* ---------- AI 제안: 가장 먼저 확인할 것 하나 ---------- */}
        {waiting.length > 0 && (
          <View style={styles.aiBox}>
            <View style={styles.aiHead}>
              <Icon name="sparkles" size={18} color={colors.mintDark} />
              <Text style={styles.aiTitle}>AI가 찾은 항목 {waiting.length}건</Text>
              <Pressable accessibilityRole="button" onPress={() => go(ROUTES.Proposals)} hitSlop={8} style={styles.addLink}>
                <Text style={styles.aiMore}>모두 보기</Text>
                <Icon name="chevronRight" size={14} color={colors.mintDark} />
              </Pressable>
            </View>
            <ProposalCard p={waiting[0]} actions={actions} showHold={false} tone="soft" />
          </View>
        )}

        {/* ---------- 팀 공간 요약 ---------- */}
        {multi && (
          <View style={styles.teamCard}>
            <Text style={styles.teamTitle}>팀 공간</Text>
            {teamSummary.map(({ w, text: summary, alert }) => (
              <Pressable key={w.id} accessibilityRole="button" accessibilityLabel={`${w.name} 공간, ${summary}`} onPress={() => go(ROUTES.SpaceHome, { workspaceId: w.id })} style={({ pressed }) => [styles.teamRow, pressed && { opacity: 0.6 }]}>
                <SpaceDot color={spaces[w.id]?.color} />
                <Text style={styles.teamName} numberOfLines={1}>{w.name}</Text>
                <Text style={[styles.teamText, alert && { color: colors.coral }]} numberOfLines={1}>{summary}</Text>
                <Icon name="chevronRight" size={14} color={colors.muted} />
              </Pressable>
            ))}
          </View>
        )}

        {/* ---------- 오늘 일정 ---------- */}
        <SectionHead title="오늘 일정" addLabel="오늘 일정 추가" onAdd={() => go(ROUTES.TaskEdit, { date: todayKey, kind: 'event' })} />
        {events.length === 0 ? (
          <Text style={styles.empty}>오늘은 일정이 없어요</Text>
        ) : (
          events.map((t) => {
            const color = spaces[t.workspaceId]?.color ?? colors.mint;
            return (
              <Pressable key={t.id} accessibilityRole="button" accessibilityLabel={`${t.start || '종일'} ${t.title}${multi ? `, ${spaces[t.workspaceId]?.fullName ?? ''}` : ''}`} onPress={() => openTask(t)} style={styles.eventRow}>
                <Text style={[styles.eventTime, { color: multi ? color : colors.mintDark }, !t.start && styles.allDay]}>{t.start || '종일'}</Text>
                <View style={[styles.eventCard, { borderLeftColor: color }, t.status === '완료' && { opacity: 0.55 }]}>
                  <Text style={styles.itemTitle} numberOfLines={1}>{t.title}</Text>
                  <View style={styles.subRow}>
                    {multi && <SpaceTag space={spaces[t.workspaceId]} />}
                    {!!(t.place || t.end || t.endDate) && (
                      <Text style={styles.itemSub} numberOfLines={1}>
                        {[t.place, t.end ? `${t.end}까지` : '', t.endDate ? `${Number(t.endDate.slice(5, 7))}/${Number(t.endDate.slice(8))}까지` : ''].filter(Boolean).join(' · ')}
                      </Text>
                    )}
                  </View>
                </View>
              </Pressable>
            );
          })
        )}

        {/* ---------- 오늘 할 일 (기한 지난 것 포함) ---------- */}
        <SectionHead title={left ? `오늘 할 일 · ${left}개 남음` : '오늘 할 일'} addLabel="오늘 할 일 추가" onAdd={() => go(ROUTES.TaskEdit, { date: todayKey, kind: 'task' })} />
        {todos.length === 0 ? (
          <Text style={styles.empty}>오늘 할 일이 없어요</Text>
        ) : (
          todos.map((t) => {
            const done = t.status === '완료';
            const late = !done && lastDate(t) < todayKey ? daysBetween(lastDate(t), todayKey) : 0;
            const mineTag = !!myName && !!t.assignee && t.assignee.trim() === myName; // 담당자가 내 이름이면 (이름으로만 비교)
            return (
              <View key={t.id} style={styles.todoRow}>
                <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: done }} accessibilityLabel={`${t.title} 완료 표시`} onPress={() => toggle(t)} hitSlop={10}>
                  <Icon name={done ? 'checkSquare' : 'square'} size={22} color={done ? colors.mintDark : colors.muted} />
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => openTask(t)} style={styles.todoBody}>
                  <Text style={[styles.todoTitle, done && styles.todoDone]} numberOfLines={1}>{t.title}</Text>
                  {(multi || mineTag) && (
                    <View style={styles.subRow}>
                      {multi && <SpaceTag space={spaces[t.workspaceId]} />}
                      {mineTag && <Text style={styles.mine}>내 담당</Text>}
                    </View>
                  )}
                </Pressable>
                {late > 0 && <Text style={styles.late}>{late === 1 ? '어제까지' : `${late}일 지남`}</Text>}
                {!late && !!t.start && <Text style={styles.itemSub}>{t.start}</Text>}
              </View>
            );
          })
        )}
      </ScrollView>

      {/* ---------- 입력줄 ---------- */}
      <View style={styles.capture}>
        {recording ? (
          <>
            <View style={styles.recDot} />
            <Text style={styles.recText} accessibilityLiveRegion="polite">녹음 중 {formatTime(seconds)}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="녹음 끝내기" onPress={toggleRecording} style={[styles.round, styles.stop]}>
              <Icon name="stop" size={18} color={colors.white} />
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.inputWrap}>
              {multi && targetSpace && (
                <Pressable accessibilityRole="button" accessibilityLabel={`저장할 공간 ${targetSpace.fullName}, 눌러서 바꾸기`} onPress={() => setPickSpace(true)} hitSlop={6} style={styles.spaceChip}>
                  <SpaceDot color={targetSpace.color} size={7} />
                  <Text style={styles.spaceChipText} numberOfLines={1}>{targetSpace.name}</Text>
                  <Icon name="chevronDown" size={12} color={colors.mintDark} />
                </Pressable>
              )}
              <TextInput
                accessibilityLabel="메모 입력"
                style={styles.input}
                value={text}
                onChangeText={(v) => setText(v.slice(0, MAX_LEN))}
                placeholder="무엇이든 적어 보세요"
                placeholderTextColor={colors.muted}
                multiline
                numberOfLines={1}
                maxLength={MAX_LEN}
              />
            </View>
            {text.trim() ? (
              <Pressable accessibilityRole="button" accessibilityLabel="메모 저장" onPress={saveMemo} style={styles.round}>
                <Icon name="arrowUp" size={20} color={colors.white} strokeWidth={2.4} />
              </Pressable>
            ) : (
              <>
                <CircleButton icon="paperclip" label="사진 · 문서 올리기" size={38} iconSize={18} color={colors.muted} onPress={() => go(ROUTES.QuickInput, { tab: 'file' })} style={styles.ghost} />
                <CircleButton icon="camera" label="카메라" size={38} iconSize={18} color={colors.muted} onPress={() => go(ROUTES.Camera)} style={styles.ghost} />
                <Pressable accessibilityRole="button" accessibilityLabel="녹음 시작" onPress={toggleRecording} style={styles.round}>
                  <Icon name="mic" size={20} color={colors.white} strokeWidth={2} />
                </Pressable>
              </>
            )}
          </>
        )}
      </View>

      {/* ---------- 저장할 공간 고르기 ---------- */}
      <Modal transparent visible={pickSpace} animationType="fade" onRequestClose={() => setPickSpace(false)}>
        <Pressable style={styles.backdrop} onPress={() => setPickSpace(false)} accessibilityLabel="닫기">
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>어느 공간에 저장할까요?</Text>
            {spacesList.map((w) => {
              const s = spaces[w.id];
              const on = w.id === targetId;
              return (
                <Pressable
                  key={w.id}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on, disabled: s.readOnly }}
                  disabled={s.readOnly}
                  onPress={() => { setTarget(w.id); setPickSpace(false); }}
                  style={[styles.sheetRow, on && { backgroundColor: colors.mintSoft }, s.readOnly && { opacity: 0.4 }]}
                >
                  <SpaceDot color={s.color} size={10} />
                  <Text style={styles.sheetText} numberOfLines={1}>{w.name}</Text>
                  {s.readOnly ? <Text style={styles.itemSub}>보기 전용</Text> : on ? <Icon name="check" size={18} color={colors.mintDark} /> : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>

      <RecordSheet
        sheet={recSheet}
        onClose={() => setRecSheet(null)}
        onOpenFiles={() => { setRecSheet(null); go(ROUTES.Files); }}
        onOpenMemo={(memoId) => { setRecSheet(null); go(ROUTES.MemoEdit, { memoId }); }}
        onOpenProposals={() => { setRecSheet(null); go(ROUTES.Proposals); }}
      />
      {snack.view}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  me: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  meText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  date: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  scope: { fontSize: font.caption, color: colors.muted },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xxl * 2, gap: spacing.sm },

  aiBox: { backgroundColor: colors.mintSoft, borderRadius: radius.card, padding: spacing.md, gap: spacing.sm, marginBottom: spacing.xs },
  aiHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  aiTitle: { flex: 1, fontSize: font.body, fontWeight: '800', color: colors.mintDark },
  aiMore: { fontSize: font.caption, fontWeight: '700', color: colors.mintDark },

  teamCard: { backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  teamTitle: { fontSize: font.caption, fontWeight: '800', color: colors.muted, marginBottom: 2 },
  teamRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 38 },
  teamName: { maxWidth: '40%', fontSize: font.body, fontWeight: '800', color: colors.ink },
  teamText: { flex: 1, fontSize: font.caption, color: colors.muted },

  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
  sectionTitle: { fontSize: font.body, fontWeight: '800', color: colors.muted },
  addLink: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 28 },
  addLinkText: { fontSize: font.caption, fontWeight: '800', color: colors.mintDark },
  empty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.xs },

  eventRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  eventTime: { width: 44, fontSize: font.body, fontWeight: '800' },
  allDay: { fontSize: font.caption, color: colors.muted },
  eventCard: { flex: 1, minHeight: 48, justifyContent: 'center', gap: 3, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderLeftWidth: 3, borderRadius: radius.md },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  itemTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  itemSub: { flexShrink: 1, fontSize: font.caption, color: colors.muted },

  todoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, minHeight: 50, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
  todoBody: { flex: 1, minHeight: 46, justifyContent: 'center', gap: 2 },
  todoTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  todoDone: { color: colors.muted, textDecorationLine: 'line-through' },
  mine: { fontSize: font.caption, fontWeight: '800', color: colors.mintDark },
  late: { fontSize: font.caption, fontWeight: '700', color: colors.coral },

  capture: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, minHeight: CAPTURE_HEIGHT, paddingHorizontal: spacing.lg, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  inputWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 42, borderRadius: 21, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingLeft: 6 },
  spaceChip: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 110, height: 30, paddingHorizontal: 8, borderRadius: 15, backgroundColor: colors.mintSoft },
  spaceChipText: { flexShrink: 1, fontSize: font.caption, fontWeight: '800', color: colors.mintDark },
  input: { flex: 1, minHeight: 40, maxHeight: 120, paddingHorizontal: spacing.md, paddingTop: 8, paddingBottom: 8, fontSize: font.bodyLg, lineHeight: 22, color: colors.ink },
  round: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  ghost: { borderWidth: 0, backgroundColor: 'transparent', marginBottom: 2 },
  stop: { backgroundColor: colors.coral },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.coral, alignSelf: 'center' },
  recText: { flex: 1, alignSelf: 'center', fontSize: font.bodyLg, fontWeight: '800', color: colors.coral },

  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.cream, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xs },
  sheetTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink, marginBottom: spacing.sm },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 50, paddingHorizontal: spacing.md, borderRadius: radius.md },
  sheetText: { flex: 1, fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
