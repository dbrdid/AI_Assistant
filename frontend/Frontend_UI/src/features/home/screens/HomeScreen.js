// ============================================================
// HomeScreen.js — 하단 탭 '오늘' (홈)
// ============================================================
// 모든 공간(개인 + 팀)을 합쳐서 보여 줍니다. 항목마다 공간 색 점이 붙어요.
// 위에서부터: 나 · 날짜 · AI · 검색 · 알림 / AI 제안 카드 / 팀 공간 요약 / 오늘 일정 / 오늘 할 일
// 맨 아래: 바로 쓰는 입력줄 (어느 공간에 쓸지 고르는 칩 · 글 메모 저장 · 사진 · 카메라 · 녹음)

import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { useKeyboardHeight } from '../../../shared/hooks/useKeyboardHeight';
import { useScreenEntry } from '../../../navigation/ScreenEntry';
import Bell from '../../notice/components/Bell';
import RecordSheet from '../../record/components/RecordSheet';
import { styles as st } from '../../stella/theme';
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
import { selectHomeScheduleEvents } from '../utils/HomeSchedule.mjs';
import { MAX_RECORDING_SECONDS } from '../../../lib/stella/recordings';

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

export default function HomeScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight(); // 메모 입력줄을 키보드 위로
  // 상단 탭 안의 '오늘'에서는 탭 줄의 S 버튼과 겹치는 '나' 버튼과 상단 여백을 빼고 날짜를 제목으로 쓴다.
  const { embedded } = useScreenEntry();
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
  const [reviewOpen, setReviewOpen] = useState(false);
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
  // 지금 진행 중인 일정과 바로 다음 일정 (완료한 일정 제외)
  const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const scheduleHighlights = selectHomeScheduleEvents(events.filter((t) => t.status !== '완료'), nowHM);

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
    return { w, text: parts.length ? parts.join(', ') : '이번 주 예정 없음', alert: late > 0 };
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
      if (r && r.added) snack.show(`AI가 일정과 할 일 ${r.added}건을 찾았어요`, { label: '확인', onPress: () => go(ROUTES.Proposals) });
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
  // 서버가 받는 최대 길이(3시간)가 되면 녹음을 끝내고 정리 창을 띄움
  const toggleRef = useRef(null);
  useEffect(() => {
    if (recording && seconds >= MAX_RECORDING_SECONDS) void toggleRef.current?.();
  }, [recording, seconds]);
  // 하단 새로 만들기 > AI 노트: 오늘 화면으로 와서 바로 녹음 시작 (값은 누를 때마다 바뀌는 시각)
  const startRequest = route?.params?.startRecording;
  useEffect(() => { if (startRequest && !recording) toggleRecording(); }, [startRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleRecording = async () => {
    if (recBusy.current) return;
    recBusy.current = true;
    try {
      if (recording) {
        setRecording(false);
        const uri = await rec.stop();
        if (!uri) return setRecSheet({ state: 'error' });
        // 저장하지 못해도 녹음 듣기와 변환은 그대로 됨. 실패 이유를 보여 주고 다시 저장할 수 있게 함
        let saved = null;
        let saveError = '';
        try { saved = await addRecording(uri, seconds); }
        catch (error) { saveError = error?.message || '녹음 파일을 저장하지 못했어요.'; }
        addUsage('voice', Math.max(1, Math.ceil(seconds / 60))); // 녹음 이용량은 분 단위
        setRecSheet({ state: saved ? 'saved' : 'save_error', uri: saved?.uri || uri, seconds, fileId: saved?.id ?? null, saveError });
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

  toggleRef.current = toggleRecording;
  const retrySaveRecording = async () => {
    const current = recSheet;
    if (current?.state !== 'save_error' || current.saving) return;
    setRecSheet({ ...current, saving: true, saveError: '' });
    try {
      const saved = await addRecording(current.uri, current.seconds);
      setRecSheet({ ...current, state: 'saved', uri: saved.uri || current.uri, fileId: saved.id, saving: false, saveError: '' });
    } catch (error) {
      setRecSheet({ ...current, saving: false, saveError: error?.message || '녹음 파일을 저장하지 못했어요.' });
    }
  };

  const dateText = `${now.getMonth() + 1}월 ${now.getDate()}일 ${WEEKDAYS_LONG[now.getDay()]}`;
  const targetSpace = spaces[targetId];

  return (
    <KeyboardAvoidingView style={styles.root}>
      {/* ---------- 머리: 나, 날짜, AI, 검색, 알림 ---------- */}
      <View style={[styles.header, { paddingTop: embedded ? 18 : insets.top + spacing.sm }]}>
        {!embedded && <Pressable accessibilityRole="button" accessibilityLabel="나, 설정" onPress={() => go(ROUTES.More)} hitSlop={6} style={({ pressed }) => [styles.me, pressed && { opacity: 0.7 }]}>
          <Text style={styles.meText}>{myName ? myName.charAt(0) : '나'}</Text>
        </Pressable>}
        <View style={{ flex: 1 }}>
          <Text style={styles.date} accessibilityRole="header" numberOfLines={1}>{dateText}</Text>
          {multi && <Text style={styles.scope}>모든 공간, 개인 + 팀 {teams.length}개</Text>}
        </View>
        <CircleButton icon="search" label="검색" onPress={() => go(ROUTES.Search)} />
        <Bell onPress={() => go(ROUTES.Notices)} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* ---------- AI 제안: 가장 먼저 확인할 것 하나 ---------- */}
        {/* 홈 개요와 같은 한 줄 (카드 안 카드, 강조색 버튼 없이). 추가, 수정, 무시는 작업 검토 화면에서 */}
        {waiting.length > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel={`검토할 작업 ${waiting.length}개`} accessibilityState={{ expanded: reviewOpen }} onPress={() => setReviewOpen((v) => !v)} style={({ pressed }) => [st.homeReview, pressed && { opacity: 0.6 }]}>
            <Icon name="checkSquare" size={18} color={colors.muted} />
            <Text style={[st.rowTitle, { flex: 1 }]} numberOfLines={1}>검토할 작업</Text>
            <Text style={st.linkText}>{waiting.length}</Text>
            <Icon name={reviewOpen ? 'chevronUp' : 'chevronDown'} size={14} color={colors.subtle ?? colors.muted} />
          </Pressable>
        )}
        {/* 따로 페이지 대신 이 자리에서 펼쳐 저장, 보류, 무시 */}
        {reviewOpen && waiting.map((p) => <ProposalCard key={p.id} p={p} actions={actions} tone="soft" />)}

        {/* ---------- 팀 공간 요약 (섹션 이름 + 줄, 상자 없이) ---------- */}
        {multi && (
          <View>
            <Text style={[styles.sectionTitle, { marginTop: spacing.md }]} accessibilityRole="header">팀 공간</Text>
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
        {scheduleHighlights.map(({ event, state }) => (
          <Text key={'now:' + event.id} accessibilityLiveRegion="polite" style={styles.highlight} numberOfLines={1}>
            {`${state === 'ongoing' ? '진행 중' : '다음 일정'}, ${event.start}${event.end ? `~${event.end}` : ''} ${event.title}`}
          </Text>
        ))}
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
                        {[t.place, t.end ? `${t.end}까지` : '', t.endDate ? `${Number(t.endDate.slice(5, 7))}/${Number(t.endDate.slice(8))}까지` : ''].filter(Boolean).join(', ')}
                      </Text>
                    )}
                  </View>
                </View>
              </Pressable>
            );
          })
        )}

        {/* ---------- 오늘 할 일 (기한 지난 것 포함) ---------- */}
        <SectionHead title={left ? `오늘 할 일, ${left}개 남음` : '오늘 할 일'} addLabel="오늘 할 일 추가" onAdd={() => go(ROUTES.TaskEdit, { date: todayKey, kind: 'task' })} />
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
      <View style={[styles.capture, { paddingBottom: keyboard ? keyboard + insets.bottom + 6 : 10 + insets.bottom }]}>
        {recording ? (
          <>
            <View style={styles.recDot} />
            <Text style={styles.recText} accessibilityLiveRegion="polite">녹음 중 {formatTime(seconds)}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="녹음 끝내기" onPress={toggleRecording} style={styles.iconBtn}>
              <Icon name="stop" size={20} color={colors.coral} />
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.inputWrap}>
              {multi && targetSpace && (
                <Pressable accessibilityRole="button" accessibilityLabel={`저장할 공간 ${targetSpace.fullName}, 눌러서 바꾸기`} onPress={() => setPickSpace(true)} hitSlop={6} style={styles.spaceChip}>
                  <SpaceDot color={targetSpace.color} size={7} />
                  <Text style={styles.spaceChipText} numberOfLines={1}>{targetSpace.name}</Text>
                  <Icon name="chevronDown" size={12} color={colors.muted} />
                </Pressable>
              )}
              <TextInput
                accessibilityLabel="메모 입력"
                style={styles.input}
                value={text}
                onChangeText={(v) => setText(v.slice(0, MAX_LEN))}
                placeholder="메모"
                placeholderTextColor={colors.muted}
                multiline
                maxLength={MAX_LEN}
              />
            </View>
            {text.trim() ? (
              <Pressable accessibilityRole="button" accessibilityLabel="메모 저장" onPress={saveMemo} style={styles.iconBtn}>
                <Icon name="arrowUp" size={21} color={colors.ink} strokeWidth={2.2} />
              </Pressable>
            ) : (
              <>
                <CircleButton icon="paperclip" label="사진이나 문서 올리기" size={44} iconSize={20} color={colors.muted} onPress={() => go(ROUTES.QuickInput, { tab: 'file' })} style={styles.ghost} />
                <CircleButton icon="camera" label="카메라" size={44} iconSize={20} color={colors.muted} onPress={() => go(ROUTES.Camera)} style={styles.ghost} />
                <Pressable accessibilityRole="button" accessibilityLabel="녹음 시작" onPress={toggleRecording} style={styles.iconBtn}>
                  <Icon name="mic" size={21} color={colors.ink} strokeWidth={2} />
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
            <Text style={styles.sheetTitle}>저장할 공간</Text>
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
        onRetrySave={retrySaveRecording}
      />
      {snack.view}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: 20, paddingBottom: spacing.sm },
  me: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center' },
  meText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  date: { fontSize: 24, fontWeight: '600', letterSpacing: -0.4, color: colors.ink },
  scope: { fontSize: font.caption, color: colors.muted },
  content: { paddingHorizontal: 20, paddingTop: spacing.sm, paddingBottom: spacing.xxl * 2, gap: spacing.sm },


  teamRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 38 },
  teamName: { maxWidth: '40%', fontSize: font.body, fontWeight: '600', color: colors.ink },
  teamText: { flex: 1, fontSize: font.caption, color: colors.muted },

  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.md },
  sectionTitle: { fontSize: 12, fontWeight: '400', color: colors.muted },
  addLink: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 44 },
  addLinkText: { fontSize: font.caption, fontWeight: '500', color: colors.muted },
  empty: { fontSize: 13, color: colors.subtle ?? colors.muted, paddingVertical: spacing.xs },

  eventRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  eventTime: { width: 44, fontSize: font.body, fontWeight: '600' },
  allDay: { fontSize: font.caption, color: colors.muted },
  eventCard: { flex: 1, minHeight: 44, justifyContent: 'center', gap: 3, paddingHorizontal: spacing.md, paddingVertical: 6, borderLeftWidth: 2 },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  itemTitle: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  itemSub: { flexShrink: 1, fontSize: font.caption, color: colors.muted },
  highlight: { fontSize: font.body, color: colors.ink, lineHeight: 20, marginBottom: spacing.xs },

  todoRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, minHeight: 50, backgroundColor: colors.card, borderRadius: radius.lg },
  todoBody: { flex: 1, minHeight: 46, justifyContent: 'center', gap: 2 },
  todoTitle: { fontSize: 15, fontWeight: '500', color: colors.ink },
  todoDone: { color: colors.muted, textDecorationLine: 'line-through' },
  mine: { fontSize: font.caption, fontWeight: '600', color: colors.mintDark },
  late: { fontSize: font.caption, fontWeight: '500', color: colors.coral },

  capture: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: CAPTURE_HEIGHT, paddingHorizontal: 16, paddingTop: 6, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  inputWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  spaceChip: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 110, minHeight: 44, paddingRight: 8 },
  spaceChipText: { flexShrink: 1, fontSize: 14, color: colors.muted },
  input: { flex: 1, minHeight: 44, maxHeight: 120, paddingHorizontal: 8, paddingVertical: 10, fontSize: 15, lineHeight: 22, color: colors.ink, textAlignVertical: 'center' },
  iconBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  round: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center' },
  ghost: { borderWidth: 0, backgroundColor: 'transparent', marginBottom: 2 },
  stop: { backgroundColor: colors.coralSoft },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.coral, alignSelf: 'center' },
  recText: { flex: 1, alignSelf: 'center', fontSize: font.bodyLg, fontWeight: '600', color: colors.coral },

  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.48)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.cream, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.xs },
  sheetTitle: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink, marginBottom: spacing.sm },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 50, paddingHorizontal: spacing.md, borderRadius: radius.md },
  sheetText: { flex: 1, fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
});
