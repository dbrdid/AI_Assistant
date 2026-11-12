// ============================================================
// QuickInputScreen.js — 빠른 입력
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ScreenHeader from '../../../shared/components/ScreenHeader';
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

export default function QuickInputScreen({ navigation }) {
  const tasks = useTasks();
  const projects = useProjects();
  const notice = useNotice();
  const [tab, setTab] = useState('memo');
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
  if (filter === 'all' || filter === 'event') events.forEach((t) => rows.push({ kind: 'task', id: t.id, title: t.title, sub: `${shortDate(t)} · ${tagText(t, todayKey)}` }));
  if (filter === 'all' || filter === 'todo') todos.forEach((t) => rows.push({ kind: 'task', id: t.id, title: t.title, sub: `${shortDate(t)} · ${tagText(t, todayKey)}` }));
  if (filter === 'all' || filter === 'project') projects.forEach((p) => rows.push({ kind: 'project', id: p.id, title: p.title || '(제목 없음)', sub: `${p.due ? `${shortDateKey(p.due)} · ` : ''}${p.priority}` }));
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
    analyzeText({ sourceType: 'memo', sourceId: memo.id, sourceTitle: text.slice(0, 20), text }).then((r) => { if (r && r.added) notice.show(`메모를 저장했어요 · AI 제안 ${r.added}건`); });
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
          const reason = checkAsset(a);
          return { key: `s${keySeq.current}`, asset: a, status: reason ? 'failed' : 'ready', reason, canRetry: false };
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
        ids.push(await addAsset(s.asset, { taskIds }));
        patch(s.key, { status: 'done' });
      } catch (e) {
        patch(s.key, { status: 'failed', reason: '올리지 못했어요', canRetry: true });
      }
    }
    if (projectId && ids.length) linkItems(projectId, 'files', ids);
    return ids.length;
  };
  const saveFiles = async () => {
    const todo = staged.filter((s) => s.status === 'ready');
    if (!todo.length) {
      notice.show(staged.length ? '올릴 수 있는 파일이 없어요' : '사진·파일을 먼저 선택해 주세요');
      return;
    }
    const n = await upload(todo);
    notice.show(n === todo.length ? `${n}개 올렸어요` : `${n}개 올렸고, 실패한 파일이 있어요`);
  };
  const retry = async (s) => {
    const n = await upload([s]);
    if (n) notice.show('올렸어요');
  };

  const onSave = tab === 'memo' ? saveMemo : saveFiles;
  const readyCount = staged.filter((s) => s.status === 'ready').length;

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="빠른 입력"
        onBack={navigation.goBack}
        right={
          <Pressable accessibilityRole="button" accessibilityLabel="저장" onPress={onSave} hitSlop={10}>
            <Text style={styles.saveText}>저장</Text>
          </Pressable>
        }
      />
      <View style={styles.tabs}>
        {[{ id: 'memo', label: '메모' }, { id: 'file', label: '사진 · 문서' }].map((t) => (
          <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: tab === t.id }} onPress={() => setTab(t.id)} style={[styles.tab, tab === t.id && styles.tabOn]}>
            <Text style={[styles.tabText, tab === t.id && { color: colors.white }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {tab === 'memo' ? (
            <>
              <TextInput
                accessibilityLabel="메모 내용"
                style={styles.memo}
                value={body}
                onChangeText={(v) => setBody(v.slice(0, MAX_LEN))}
                placeholder="메모 작성 — 내용만 적으면 돼요"
                placeholderTextColor={colors.muted}
                multiline
                textAlignVertical="top"
                maxLength={MAX_LEN}
                accessibilityLabel_1="메모 내용"
              />
              <Text style={[styles.counter, body.length >= MAX_LEN && { color: colors.coral, fontWeight: '800' }]}>
                {body.length >= MAX_LEN ? `입력할 수 있는 길이를 넘었어요 (${MAX_LEN}자)` : `${body.length}/${MAX_LEN}`}
              </Text>
            </>
          ) : (
            <>
              <Pressable accessibilityRole="button" onPress={pick} style={styles.pick}>
                <Text style={styles.pickText}>＋ 사진 · 파일 선택</Text>
                <Text style={styles.pickSub}>여러 개를 한 번에 고를 수 있어요 (PDF · PPT · 문서 · 이미지, 20MB 이하)</Text>
              </Pressable>
              {staged.map((s) => (
                <View key={s.key} style={styles.file}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.fileName} numberOfLines={1}>{s.asset.name}</Text>
                    <Text style={[styles.fileState, s.status === 'failed' && { color: colors.coral }, s.status === 'done' && { color: colors.mintDark }]}>
                      {s.status === 'ready' ? '올릴 준비됨' : s.status === 'uploading' ? '올리는 중…' : s.status === 'done' ? '업로드 완료' : s.reason}
                    </Text>
                  </View>
                  {s.status === 'failed' && s.canRetry && (
                    <Pressable accessibilityRole="button" onPress={() => retry(s)} style={styles.miniBtn}><Text style={styles.miniText}>다시 올리기</Text></Pressable>
                  )}
                  {(s.status === 'ready' || s.status === 'failed') && (
                    <Pressable accessibilityRole="button" accessibilityLabel={`${s.asset.name} 목록에서 빼기`} onPress={() => setStaged((c) => c.filter((x) => x.key !== s.key))} hitSlop={8}>
                      <Text style={styles.remove}>✕</Text>
                    </Pressable>
                  )}
                </View>
              ))}
              {staged.length > 0 && readyCount > 0 && <Text style={styles.counter}>{readyCount}개를 올릴 준비가 됐어요. [저장]을 눌러 주세요.</Text>}
            </>
          )}

          <Text style={styles.sectionTitle}>{tab === 'memo' ? '메모와 연결' : '파일과 연결'}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
            {FILTERS.map((f) => (
              <Pressable key={f.id} accessibilityRole="button" accessibilityState={{ selected: filter === f.id }} onPress={() => setFilter(f.id)} style={[styles.chip, filter === f.id && styles.chipOn]}>
                <Text style={[styles.chipText, filter === f.id && { color: colors.white }]}>{f.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
          {shown.length === 0 && <Text style={styles.counter}>연결할 항목이 없어요.</Text>}
          {shown.map((r) => {
            const on = checked(r);
            return (
              <Pressable key={`${r.kind}${r.id}`} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${r.title}, ${r.sub}`} onPress={() => toggle(r)} style={[styles.row, on && styles.rowOn]}>
                <Text style={[styles.box, on && { color: colors.mintDark }]}>{on ? '☑' : '☐'}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{r.title}</Text>
                  <Text style={styles.rowSub}>{r.kind === 'project' ? '프로젝트 · ' : ''}{r.sub}</Text>
                </View>
              </Pressable>
            );
          })}
          <Text style={styles.counter}>프로젝트는 하나만, 일정·할 일은 여러 개 연결할 수 있어요.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
      {notice.view}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  saveText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.mintDark },
  tabs: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  tab: { flex: 1, minHeight: 44, borderRadius: 22, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  tabOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  tabText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  memo: { minHeight: 180, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, fontSize: font.bodyLg, color: colors.ink, lineHeight: 24 },
  counter: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  pick: { padding: spacing.xl, borderRadius: radius.md, borderWidth: 2, borderStyle: 'dashed', borderColor: colors.mint, backgroundColor: colors.mintSoft, alignItems: 'center', gap: 4 },
  pickText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.mintDark },
  pickSub: { fontSize: font.caption, color: colors.muted, textAlign: 'center' },
  file: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  fileName: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  fileState: { fontSize: font.caption, color: colors.muted },
  miniBtn: { minHeight: 34, paddingHorizontal: spacing.md, borderRadius: 17, borderWidth: 1, borderColor: colors.mint, alignItems: 'center', justifyContent: 'center' },
  miniText: { fontSize: font.caption, fontWeight: '800', color: colors.mintDark },
  remove: { fontSize: 18, color: colors.muted, paddingHorizontal: 4 },
  sectionTitle: { fontSize: font.caption, fontWeight: '800', color: colors.muted, marginTop: spacing.lg },
  filters: { gap: spacing.sm, paddingVertical: spacing.xs },
  chip: { minHeight: 36, paddingHorizontal: spacing.lg, borderRadius: 18, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, minHeight: 56 },
  rowOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  box: { fontSize: 24, color: colors.muted },
  rowTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  rowSub: { fontSize: font.caption, color: colors.muted },
});
