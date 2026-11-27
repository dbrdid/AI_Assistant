// ============================================================
// QuickInputScreen.js — 빠른 입력
// ============================================================

import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { useScreenEntry } from '../../../navigation/ScreenEntry';
import { BarAction, BottomBar } from '../../../shared/components/Ui';
import Icon from '../../../shared/components/Icon';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { shortDateKey } from '../../agenda/utils/AgendaUtils';
import { toKey } from '../../calendar/utils/DateUtils';
import { addMemo } from '../../../data/memos/MemoStore';
import { analyzeText } from '../../../services/ai/AiAnalyze';
import { addAsset, checkAsset, pickAssets } from '../../../data/files/FileStore';
import { linkItems, setItemProject, useProjects } from '../../../data/projects/ProjectStore';
import { shortDate, tagText, useTasks } from '../../../data/tasks/TaskStore';
import { scopedKey } from '../../../data/workspaces/WorkspaceStore';
import { useNotice } from '../../../shared/components/SettingsUi';

const MAX_LEN = 2000;
const DRAFT_KEY = 'myapp.quickinput.draft.v1';
const FILTERS = [
  { id: 'all', label: '전체' },
  { id: 'event', label: '일정' },
  { id: 'todo', label: '할 일' },
  { id: 'project', label: '프로젝트' },
];

export default function QuickInputScreen({ navigation, route }) {
  const tasks = useTasks();
  const projects = useProjects();
  const notice = useNotice();
  const [tab, setTab] = useState(route?.params?.tab === 'file' ? 'file' : 'memo');
  const [body, setBody] = useState('');
  const [taskIds, setTaskIds] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [staged, setStaged] = useState([]); // [{ key, asset, status:'ready'|'uploading'|'done'|'failed', reason, canRetry }]
  const [loaded, setLoaded] = useState(false);
  const leaving = useRef(null);
  const keySeq = useRef(0);
  const todayKey = toKey(new Date());

  // 임시 보존된 내용 불러오기
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(scopedKey(DRAFT_KEY))
      .then((raw) => {
        if (!alive || !raw) return;
        const d = JSON.parse(raw);
        if (typeof d.body === 'string') setBody(d.body.slice(0, MAX_LEN));
        if (Array.isArray(d.taskIds)) setTaskIds(d.taskIds);
        if (d.projectId) setProjectId(d.projectId);
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
      clearTimeout(leaving.current);
    };
  }, []);
  // 바뀔 때마다 임시 저장 (불러오기가 끝난 뒤부터)
  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(scopedKey(DRAFT_KEY), JSON.stringify({ body, taskIds, projectId })).catch(() => {});
  }, [body, taskIds, projectId, loaded]);

  // 연결 후보: 끝나지 않은 일정/할 일, 프로젝트
  const open = tasks.filter((t) => t.status !== '완료');
  const events = open.filter((t) => !!t.start);
  const todos = open.filter((t) => !t.start);
  const rows = [];
  if (filter === 'all' || filter === 'event') events.forEach((t) => rows.push({ kind: 'task', id: t.id, title: t.title, sub: `${shortDate(t)}, ${tagText(t, todayKey)}` }));
  if (filter === 'all' || filter === 'todo') todos.forEach((t) => rows.push({ kind: 'task', id: t.id, title: t.title, sub: `${shortDate(t)}, ${tagText(t, todayKey)}` }));
  if (filter === 'all' || filter === 'project') projects.forEach((p) => rows.push({ kind: 'project', id: p.id, title: p.title || '(제목 없음)', sub: `${p.due ? `${shortDateKey(p.due)}, ` : ''}${p.priority}` }));
  const shown = rows.slice(0, 40);

  const toggle = (r) => {
    if (r.kind === 'project') setProjectId((cur) => (cur === r.id ? null : r.id));
    else setTaskIds((cur) => (cur.includes(r.id) ? cur.filter((x) => x !== r.id) : [...cur, r.id]));
  };
  const checked = (r) => (r.kind === 'project' ? projectId === r.id : taskIds.includes(r.id));

  // ---------- 메모 저장 ----------
  const saveMemo = () => {
    const text = body.trim();
    if (!text) {
      notice.show('내용을 입력해 주세요');
      return;
    }
    const memo = addMemo({ title: '', body: text, taskIds });
    if (projectId) setItemProject('memos', memo.id, projectId);
    setBody('');
    setTaskIds([]);
    setProjectId(null);
    AsyncStorage.removeItem(scopedKey(DRAFT_KEY)).catch(() => {});
    analyzeText({ sourceType: 'memo', sourceId: memo.id, sourceTitle: text.slice(0, 20), text }).then((r) => {
      if (!r?.added) return;
      notice.show(r.saved > 0 ? `메모를 저장했어요. ${r.saved}건 자동 저장${r.pending ? `, ${r.pending}건 확인 필요` : ''}` : `메모를 저장했어요. AI 제안 ${r.pending ?? r.added}건`);
    });
    notice.show('메모를 저장했어요');
    leaving.current = setTimeout(navigation.goBack, 700);
  };

  // ---------- 사진·문서 ----------
  const pick = async () => {
    try {
      const assets = await pickAssets();
      if (!assets.length) return;
      setStaged((cur) => [
        ...cur,
        ...assets.map((a) => {
          keySeq.current += 1;
          const check = checkAsset(a); // { ok, reason }
          return { key: `s${keySeq.current}`, asset: a, status: check.ok ? 'ready' : 'failed', reason: check.reason ?? '', canRetry: false };
        }),
      ]);
    } catch (e) {
      notice.show('파일을 불러오지 못했어요');
    }
  };
  const patch = (key, p) => setStaged((cur) => cur.map((s) => (s.key === key ? { ...s, ...p } : s)));
  const upload = async (list) => {
    const ids = [];
    for (const s of list) {
      patch(s.key, { status: 'uploading', reason: '' });
      try {
        ids.push(await addAsset(s.asset, { taskIds }, { referenceOnly: true }));   // 원본은 그대로 두고 연결만
        patch(s.key, { status: 'done' });
      } catch (e) {
        patch(s.key, { status: 'failed', reason: '연결하지 못했어요', canRetry: true });
      }
    }
    if (projectId && ids.length) linkItems(projectId, 'files', ids);
    return ids.length;
  };
  const saveFiles = async () => {
    const todo = staged.filter((s) => s.status === 'ready');
    if (!todo.length) {
      notice.show(staged.length ? '연결할 수 있는 파일이 없어요' : '사진이나 파일을 먼저 선택해 주세요');
      return;
    }
    const n = await upload(todo);
    notice.show(n === todo.length ? `${n}개 파일을 연결했어요` : `${n}개 파일을 연결했고, 실패한 파일이 있어요`);
  };
  const retry = async (s) => {
    const n = await upload([s]);
    if (n) notice.show('파일을 연결했어요');
  };

  const onSave = tab === 'memo' ? saveMemo : saveFiles;
  const { embedded } = useScreenEntry();
  const readyCount = staged.filter((s) => s.status === 'ready').length;

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="빠른 입력"
        onBack={navigation.goBack}
        // 탭 안에서는 아래가 공통 하단(검색, AI, 새로 만들기)이라 저장은 위 오른쪽에
        right={embedded ? <BarAction label="저장" onPress={onSave} /> : undefined}
      />
      <View style={styles.tabs}>
        {[{ id: 'memo', label: '메모' }, { id: 'file', label: '사진과 문서' }].map((t) => (
          <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: tab === t.id }} onPress={() => setTab(t.id)} style={[styles.tab, tab === t.id && styles.tabOn]}>
            <Text style={[styles.tabText, tab === t.id && { color: colors.onPrimary }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {tab === 'memo' ? (
            <>
              <TextInput
                accessibilityLabel="메모 내용"
                style={styles.memo}
                value={body}
                onChangeText={(v) => setBody(v.slice(0, MAX_LEN))}
                placeholder="메모"
                placeholderTextColor={colors.muted}
                multiline
                textAlignVertical="top"
                maxLength={MAX_LEN}
                accessibilityLabel_1="메모 내용"
              />
            </>
          ) : (
            <>
              <Pressable accessibilityRole="button" onPress={pick} style={styles.pick}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Icon name="plus" size={18} color={colors.mintDark} />
                  <Text style={styles.pickText}>사진이나 파일 선택</Text>
                </View>
                <Text style={styles.pickSub}>여러 개를 한 번에 고를 수 있어요 (PDF, PPT, 문서, 이미지, 20MB 이하)</Text>
              </Pressable>
              {staged.map((s) => (
                <View key={s.key} style={styles.file}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.fileName} numberOfLines={1}>{s.asset.name}</Text>
                    <Text style={[styles.fileState, s.status === 'failed' && { color: colors.coral }, s.status === 'done' && { color: colors.mintDark }]}>
                      {s.status === 'ready' ? '연결할 준비됨' : s.status === 'uploading' ? '연결 중…' : s.status === 'done' ? '연결 완료' : s.reason}
                    </Text>
                  </View>
                  {s.status === 'failed' && s.canRetry && (
                    <Pressable accessibilityRole="button" onPress={() => retry(s)} style={styles.miniBtn}><Text style={styles.miniText}>다시 연결</Text></Pressable>
                  )}
                  {(s.status === 'ready' || s.status === 'failed') && (
                    <Pressable accessibilityRole="button" accessibilityLabel={`${s.asset.name} 목록에서 빼기`} onPress={() => setStaged((c) => c.filter((x) => x.key !== s.key))} hitSlop={8}>
                      <Icon name="x" size={18} color={colors.muted} />
                    </Pressable>
                  )}
                </View>
              ))}
            </>
          )}

          <Text style={styles.sectionTitle}>{tab === 'memo' ? '메모와 연결' : '파일과 연결'}</Text>
          <ScrollView showsVerticalScrollIndicator={false} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
            {FILTERS.map((f) => (
              <Pressable key={f.id} accessibilityRole="button" accessibilityState={{ selected: filter === f.id }} onPress={() => setFilter(f.id)} style={[styles.chip, filter === f.id && styles.chipOn]}>
                <Text style={[styles.chipText, filter === f.id && { color: colors.onPrimary }]}>{f.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {shown.length === 0 && <Text style={styles.counter}>연결할 항목이 없어요.</Text>}
          {shown.map((r) => {
            const on = checked(r);
            return (
              <Pressable key={`${r.kind}${r.id}`} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${r.title}, ${r.sub}`} onPress={() => toggle(r)} style={[styles.row, on && styles.rowOn]}>
                <Icon name={on ? 'checkSquare' : 'square'} size={22} color={on ? colors.mintDark : colors.muted} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{r.title}</Text>
                  <Text style={styles.rowSub}>{r.kind === 'project' ? '프로젝트, ' : ''}{r.sub}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
        {/* 하단 줄: 홈 개요 도크와 같은 자리. 왼쪽 상태, 오른쪽 저장 */}
        {!embedded && <BottomBar style={{ justifyContent: 'space-between' }}>
          <Text style={[styles.counter, tab === 'memo' && body.length >= MAX_LEN && { color: colors.coral }]}>
            {tab === 'memo' ? (body.length >= MAX_LEN * 0.9 ? `${body.length}/${MAX_LEN}` : '') : readyCount > 0 ? `${readyCount}개 선택` : ''}
          </Text>
          <BarAction label="저장" onPress={onSave} />
        </BottomBar>}
      </KeyboardAvoidingView>
      {notice.view}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  // 메모 / 사진 문서 전환: 밝은 채움 대신 Stella 필터처럼 밑줄로 선택을 표시
  tabs: { flexDirection: 'row', gap: 20, marginHorizontal: 20, marginBottom: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  tab: { minHeight: 44, alignItems: 'center', justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabOn: { borderBottomColor: colors.ink },
  tabText: { fontSize: 13, fontWeight: '500', color: colors.ink },
  content: { paddingHorizontal: 20, paddingBottom: spacing.xxl, gap: spacing.sm },
  memo: { minHeight: 180, paddingVertical: 8, paddingHorizontal: 2, fontSize: 16, color: colors.ink, lineHeight: 24 },
  counter: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  pick: { padding: spacing.xl, borderRadius: radius.card, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.actionBorder, backgroundColor: 'transparent', alignItems: 'center', gap: 4 },
  pickText: { fontSize: 15, fontWeight: '500', color: colors.ink },
  pickSub: { fontSize: font.caption, color: colors.muted, textAlign: 'center' },
  file: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: 14, borderRadius: radius.lg, backgroundColor: colors.card },
  fileName: { fontSize: 15, fontWeight: '500', color: colors.ink },
  fileState: { fontSize: font.caption, color: colors.muted },
  miniBtn: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: 17, borderWidth: 0, borderColor: colors.hairline, alignItems: 'center', justifyContent: 'center' },
  miniText: { fontSize: font.caption, fontWeight: '500', color: colors.ink },
  remove: { fontSize: 18, color: colors.muted, paddingHorizontal: 4 },
  sectionTitle: { fontSize: 12, fontWeight: '400', color: colors.muted, marginTop: spacing.lg },
  filters: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: { minHeight: 44, paddingHorizontal: 14, borderRadius: 17, backgroundColor: 'transparent', borderWidth: 0, borderColor: colors.hairline, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.raised, borderColor: colors.raised },
  chipText: { fontSize: 13, fontWeight: '500', color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: 14, paddingVertical: 12, borderRadius: radius.lg, backgroundColor: colors.card, minHeight: 52 },
  rowOn: { backgroundColor: colors.raised },
  box: { fontSize: 24, color: colors.muted },
  rowTitle: { fontSize: 15, fontWeight: '500', color: colors.ink },
  rowSub: { fontSize: font.caption, color: colors.muted },
});
