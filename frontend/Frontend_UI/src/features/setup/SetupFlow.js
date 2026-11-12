// ============================================================
// SetupFlow.js — 최초 설정 (처음 로그인했을 때 한 번)  스토리보드 16~22장
// ============================================================
// 순서:  소개(정보 입력 → AI 분석 → 사용자 확인 → 저장)  →  기본 정보 1/3(사용 목적·시간대)
//        →  AI 설정 2/3(찾을 항목·자동 요약·외부 AI 안내)  →  브리핑 설정 3/3(내용·상황 맞춤·받는 방법·미리보기)
//        →  권한 안내(마이크·카메라·알림)  →  [허용 및 시작] → 홈
// 알림(필수)이 거부돼도 [취소 (알림 없이 시작)] 으로 앱을 시작할 수 있어요 (웹 테스트 화면에서 막히지 않도록).
// 위쪽 [건너뛰기] 는 그 단계를 저장하지 않고 넘어가요. 끝내면 설정이 저장되고 다시 묻지 않아요.
// props: user, onDone()

import React, { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../shared/hooks/useInsets';
import { colors, font, radius, spacing } from '../../shared/theme/theme';
import { toKey } from '../calendar/utils/DateUtils';
import { AuthButton } from '../auth/components/AuthUi';
import { getTasks, tagText } from '../../data/tasks/TaskStore';
import { getMemos } from '../../data/memos/MemoStore';
import { updateSettings } from '../../data/settings/SettingsStore';
import { PURPOSES, TIMEZONES, createStarterMemos, deviceTimezone, hasPurpose, markSetupDone, timezoneLabel, togglePurpose } from '../../data/setup/SetupStore';
import { requestPermission } from '../../services/device/Permissions';
import { ToggleRow } from '../../shared/components/SettingsUi';

const STEPS = ['intro', 'basic', 'ai', 'brief', 'perm'];

export default function SetupFlow({ user, onDone }) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState(0);
  const name = STEPS[step];

  // ---- 고른 값들 ----
  const [purpose, setPurpose] = useState('');
  const [tz, setTz] = useState(deviceTimezone());
  const [tzOpen, setTzOpen] = useState(false);
  const [targets, setTargets] = useState({ schedule: true, task: true, person: true, place: true });
  const [autoSummary, setAutoSummary] = useState(true);
  const [items, setItems] = useState({ schedule: true, task: true, due: true, note: true });
  const [contextual, setContextual] = useState(true);
  const [channels, setChannels] = useState({ app: true, voice: false, external: false });
  const [perm, setPerm] = useState({ mic: 'idle', camera: 'idle', notification: 'idle' }); // idle | granted | denied
  const [denied, setDenied] = useState(null);
  const [busy, setBusy] = useState(false);

  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));

  const saveBasic = () => {
    updateSettings('setup', { purpose, timezone: tz });
    next();
  };
  const saveAi = () => {
    updateSettings('ai', { targets, autoSummary });
    next();
  };
  const saveBrief = () => {
    updateSettings('brief', { items, contextual, channels });
    next();
  };

  const finish = async () => {
    if (purpose) createStarterMemos(purpose);
    await markSetupDone(user && user.email);
    onDone();
  };

  const start = async () => {
    setBusy(true);
    const r = {};
    for (const k of ['mic', 'camera', 'notification']) r[k] = await requestPermission(k);
    setPerm(r);
    setBusy(false);
    if (r.notification === 'denied') {
      setDenied('알림'); // 필수 권한이 거부됨
      return;
    }
    await finish();
  };

  const header = (title, canSkip, canBack) => (
    <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.hSide}>
        {canBack && (
          <Pressable accessibilityRole="button" accessibilityLabel="이전 단계" onPress={back} hitSlop={12}><Text style={styles.back}>‹</Text></Pressable>
        )}
      </View>
      <Text style={styles.hTitle}>{title}</Text>
      <View style={[styles.hSide, { alignItems: 'flex-end' }]}>
        {canSkip && (
          <Pressable accessibilityRole="button" onPress={next} hitSlop={10}><Text style={styles.skip}>건너뛰기</Text></Pressable>
        )}
      </View>
    </View>
  );
  const footer = (label, onPress, opts = {}) => (
    <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
      <AuthButton label={label} onPress={onPress} busy={opts.busy} />
      {opts.extra}
    </View>
  );

  // ---------- 소개 (19장) ----------
  if (name === 'intro') {
    const flow = [
      ['1', '정보 입력', '메모 · 녹음 · 사진 · 문서'],
      ['2', 'AI 분석', '일정 · 할 일 후보 추출'],
      ['3', '사용자 확인', '추출 내용 확인'],
      ['4', '저장', '캘린더 · 할 일에 저장'],
    ];
    return (
      <View style={styles.root}>
        {header('시작하기', false, false)}
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.big}>일정 및 할 일 모두{'\n'}AI가 정리해 드려요</Text>
          {flow.map(([n, t, s]) => (
            <View key={n} style={styles.flowRow}>
              <View style={styles.flowNum}><Text style={styles.flowNumText}>{n}</Text></View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.flowTitle}>{t}</Text>
                <Text style={styles.flowSub}>{s}</Text>
              </View>
            </View>
          ))}
          <Text style={styles.note}>AI가 찾은 내용은 사용자가 직접 확인한 뒤에만 반영돼요.</Text>
        </ScrollView>
        {footer('다음', next, { extra: <Pressable accessibilityRole="button" onPress={() => setStep(1)} style={styles.textBtn}><Text style={styles.textBtnText}>소개 건너뛰기</Text></Pressable> })}
      </View>
    );
  }

  // ---------- 기본 정보 1/3 (20장) ----------
  if (name === 'basic') {
    return (
      <View style={styles.root}>
        {header('기본 정보 (1/3)', true, false)}
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.q}>앱의 사용 목적을 선택해주세요</Text>
          <Text style={styles.note}>여러 개를 고를 수 있어요. 선택하지 않아도 넘어갈 수 있어요. 고른 만큼 시작용 메모 템플릿을 만들어 드려요.</Text>
          {PURPOSES.map((p) => {
            const on = hasPurpose(purpose, p.id);
            return (
              <Pressable key={p.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => setPurpose(togglePurpose(purpose, p.id))} style={[styles.card, on && styles.cardOn]}>
                <Text style={styles.cardIcon}>{p.icon}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.cardTitle}>{p.label}</Text>
                  <Text style={styles.cardSub}>{p.sub}</Text>
                </View>
                <Text style={[styles.radio, on && { color: colors.mintDark }]}>{on ? '☑' : '☐'}</Text>
              </Pressable>
            );
          })}
          <Text style={[styles.q, { marginTop: spacing.lg }]}>시간대 설정</Text>
          <Pressable accessibilityRole="button" onPress={() => setTzOpen(true)} style={styles.card}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.cardTitle}>{timezoneLabel(tz)}</Text>
              <Text style={styles.cardSub}>{tz === deviceTimezone() ? '기기 시간대' : '직접 선택한 시간대'} · 일정과 브리핑에 적용돼요</Text>
            </View>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        </ScrollView>
        {footer('다음', saveBasic)}
        <Modal transparent visible={tzOpen} animationType="fade" onRequestClose={() => setTzOpen(false)}>
          <View style={styles.backdrop}>
            <View style={styles.sheet} accessibilityViewIsModal>
              <Text style={styles.sheetTitle}>시간대 선택</Text>
              <ScrollView style={{ maxHeight: 360 }} contentContainerStyle={{ gap: spacing.sm }}>
                {TIMEZONES.map((t) => (
                  <Pressable key={t.id} accessibilityRole="button" accessibilityState={{ selected: t.id === tz }} onPress={() => { setTz(t.id); setTzOpen(false); }} style={[styles.opt, t.id === tz && styles.cardOn]}>
                    <Text style={styles.optText}>{t.label} ({t.gmt})</Text>
                    {t.id === deviceTimezone() && <Text style={styles.optTag}>기기</Text>}
                  </Pressable>
                ))}
              </ScrollView>
              <AuthButton kind="ghost" label="닫기" onPress={() => setTzOpen(false)} />
            </View>
          </View>
        </Modal>
      </View>
    );
  }

  // ---------- AI 설정 2/3 (21장) ----------
  if (name === 'ai') {
    const KEYS = [['schedule', '일정'], ['task', '할 일'], ['person', '인물'], ['place', '장소']];
    const all = KEYS.every(([k]) => targets[k]);
    const chip = (label, on, onPress) => (
      <Pressable key={label} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
        <Text style={[styles.chipText, on && { color: colors.white }]}>{label}</Text>
      </Pressable>
    );
    return (
      <View style={styles.root}>
        {header('AI 설정 (2/3)', true, true)}
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.q}>AI가 자동으로 찾을 항목</Text>
          <Text style={styles.note}>선택한 항목만 분석 결과에 포함돼요. 권장값이 미리 선택되어 있어요.</Text>
          <View style={styles.chipRow}>
            {chip('전체', all, () => setTargets(all ? { schedule: false, task: false, person: false, place: false } : { schedule: true, task: true, person: true, place: true }))}
            {KEYS.map(([k, l]) => chip(l, targets[k], () => setTargets((t) => ({ ...t, [k]: !t[k] }))))}
          </View>
          <ToggleRow label="AI 자동 요약" sub="메모·녹음·회의 내용을 AI가 자동으로 요약해 드려요" value={autoSummary} onValueChange={setAutoSummary} />
          <View style={styles.info}>
            <Text style={styles.infoTitle}>외부 AI로 전달되는 정보</Text>
            <Text style={styles.infoText}>분석 요청한 메모 · 녹음 · 텍스트가 전달돼요. 설정에서 기기 내 처리로 바꿀 수 있어요.</Text>
          </View>
        </ScrollView>
        {footer('다음', saveAi)}
      </View>
    );
  }

  // ---------- 브리핑 설정 3/3 (22장) ----------
  if (name === 'brief') {
    const todayKey = toKey(new Date());
    const open = getTasks().filter((t) => t.status !== '완료');
    const nEvents = open.filter((t) => t.date === todayKey && t.start).length;
    const nTodos = open.filter((t) => !t.start).length;
    const nDue = open.filter((t) => ['오늘', '임박', '초과'].includes(tagText(t, todayKey))).length;
    const nNotes = getMemos().filter((m) => m.favorite).length;
    const parts = [];
    if (items.schedule) parts.push(`오늘 일정 ${nEvents}건`);
    if (items.task) parts.push(`남은 할 일 ${nTodos}건`);
    if (items.due) parts.push(`마감 임박 ${nDue}건`);
    if (items.note) parts.push(`중요 메모 ${nNotes}건`);
    const via = [channels.app && '앱 알림', channels.voice && '음성', channels.external && '외부 채널'].filter(Boolean).join(' · ');
    const KEYS = [['schedule', '일정'], ['task', '할 일'], ['due', '마감 임박'], ['note', '중요 메모']];
    const allItems = KEYS.every(([k]) => items[k]);
    const chip = (label, on, onPress) => (
      <Pressable key={label} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
        <Text style={[styles.chipText, on && { color: colors.white }]}>{label}</Text>
      </Pressable>
    );
    return (
      <View style={styles.root}>
        {header('브리핑 설정 (3/3)', false, true)}
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.q}>브리핑에 포함할 내용</Text>
          <View style={styles.chipRow}>
            {chip('전체', allItems, () => setItems(allItems ? { schedule: false, task: false, due: false, note: false } : { schedule: true, task: true, due: true, note: true }))}
            {KEYS.map(([k, l]) => chip(l, items[k], () => setItems((t) => ({ ...t, [k]: !t[k] }))))}
          </View>
          <ToggleRow label="상황 맞춤 브리핑" sub="하루 시작·회의 직전 등 상황에 따라 길이와 전달 방식이 달라져요" value={contextual} onValueChange={setContextual} />
          <Text style={styles.q}>브리핑 받는 방법</Text>
          <View style={styles.chipRow}>
            {chip('앱 알림', channels.app, () => setChannels((c) => ({ ...c, app: !c.app })))}
            {chip('음성', channels.voice, () => setChannels((c) => ({ ...c, voice: !c.voice })))}
            {chip('외부 채널', channels.external, () => setChannels((c) => ({ ...c, external: !c.external })))}
          </View>
          {channels.external && <Text style={styles.note}>외부 채널은 동의한 경우에만 쓸 수 있어요. 실제 연결은 서버가 준비되면 시작돼요.</Text>}
          <View style={styles.preview}>
            <Text style={styles.previewLabel}>미리 보기</Text>
            <Text style={styles.previewText}>{parts.length ? parts.join(' · ') : '브리핑에 포함할 내용을 선택해 주세요'}</Text>
            {contextual && <Text style={styles.previewSub}>회의 직전에는 짧게 요약해 드려요</Text>}
            {!!via && <Text style={styles.previewSub}>받는 방법: {via}</Text>}
          </View>
        </ScrollView>
        {footer('끝내기', saveBrief)}
      </View>
    );
  }

  // ---------- 권한 안내 (17~18장) ----------
  const PERMS = [
    ['mic', '마이크 (선택)', '음성 메모 및 음성 인식'],
    ['camera', '카메라 (선택)', '문서 스캔 및 텍스트 자동 추출'],
    ['notification', '알림 (필수)', '일정 마감 및 브리핑 알림'],
  ];
  const stateText = { idle: '', granted: '허용됨', denied: '거부됨' };
  return (
    <View style={styles.root}>
      {header('설정 (마무리)', false, true)}
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.big}>앱 기능 이용 권한 안내</Text>
        <Text style={styles.note}>원활한 서비스 제공을 위해 아래 권한이 필요합니다</Text>
        {PERMS.map(([k, t, s]) => (
          <View key={k} style={styles.card}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.cardTitle}>{t}</Text>
              <Text style={styles.cardSub}>{s}</Text>
            </View>
            {!!stateText[perm[k]] && <Text style={[styles.permState, perm[k] === 'denied' && { color: colors.coral }]}>{stateText[perm[k]]}</Text>}
          </View>
        ))}
        <Text style={styles.note}>선택 권한은 거부해도 앱을 쓸 수 있고, 나중에 설정 &gt; 보안 및 권한에서 바꿀 수 있어요.</Text>
      </ScrollView>
      {footer('허용 및 시작', start, { busy })}
      <Modal transparent visible={!!denied} animationType="fade" onRequestClose={() => setDenied(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>⚠  권한 거부</Text>
            <Text style={styles.cardSub}>원활한 이용을 위해 {denied} 권한을 허용해 주세요</Text>
            <AuthButton label="이동" onPress={() => { setDenied(null); Linking.openSettings().catch(() => {}); }} />
            <AuthButton kind="ghost" label="취소 (알림 없이 시작)" onPress={async () => { setDenied(null); await finish(); }} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, minHeight: 56 },
  hSide: { width: 72 },
  hTitle: { flex: 1, textAlign: 'center', fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  back: { fontSize: 32, color: colors.ink, marginTop: -4 },
  skip: { fontSize: font.body, fontWeight: '700', color: colors.muted },
  body: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl, gap: spacing.md },
  footer: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, gap: spacing.xs, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  big: { fontSize: 26, fontWeight: '800', color: colors.ink, lineHeight: 34 },
  q: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  note: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  textBtn: { alignSelf: 'center', minHeight: 40, justifyContent: 'center' },
  textBtnText: { fontSize: font.body, fontWeight: '700', color: colors.muted },
  flowRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  flowNum: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  flowNumText: { color: colors.white, fontWeight: '800' },
  flowTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  flowSub: { fontSize: font.body, color: colors.muted },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, minHeight: 64 },
  cardOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  cardIcon: { fontSize: 26 },
  cardTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  cardSub: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  radio: { fontSize: 22, color: colors.muted },
  chev: { fontSize: 24, color: colors.muted },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { minHeight: 40, paddingHorizontal: spacing.lg, borderRadius: 20, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  info: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.mintSoft, gap: 4 },
  infoTitle: { fontSize: font.body, fontWeight: '800', color: colors.mintDark },
  infoText: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  preview: { padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.mint, gap: 4 },
  previewLabel: { fontSize: font.caption, fontWeight: '800', color: colors.muted },
  previewText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink, lineHeight: 24 },
  previewSub: { fontSize: font.body, color: colors.muted },
  permState: { fontSize: font.body, fontWeight: '800', color: colors.mintDark },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  sheet: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  sheetTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  opt: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 48, paddingHorizontal: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  optText: { fontSize: font.bodyLg, color: colors.ink, fontWeight: '600' },
  optTag: { fontSize: font.caption, fontWeight: '800', color: colors.mintDark },
});
