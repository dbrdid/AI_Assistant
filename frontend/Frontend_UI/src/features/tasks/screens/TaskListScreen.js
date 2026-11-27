// ============================================================
// TaskListScreen.js — 할 일 목록 (하단 탭 '할 일')
// ============================================================
// 진행 중인 항목을 날짜별로 묶어 보여 줍니다: 기한 지남 · 오늘 · 내일 · 이번 주 · 나중에
// 왼쪽으로 밀면 내일(또는 하루 뒤)로 미루고, 완료·미루기는 '되돌리기'로 취소할 수 있어요.

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { useScreenEntry } from '../../../navigation/ScreenEntry';
import { styles as st } from '../../stella/theme';
import Icon from '../../../shared/components/Icon';
import { SheetModal } from '../../../shared/components/Motion';
import { BottomCreate, Tag } from '../../../shared/components/Ui';
import { useSnackbar } from '../../../shared/components/Snackbar';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { toKey } from '../../calendar/utils/DateUtils';
import { lastDate, occursOn, shiftKey, shortDate, taskIn, useAllTasks } from '../../../data/tasks/TaskStore';
import { enterSpace, useSpaceInfo, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import { useSettings } from '../../../data/settings/SettingsStore';
import SpaceTag from '../../../shared/components/SpaceTag';
import { projectOf, useProjects } from '../../../data/projects/ProjectStore';
import SwipeRow from '../components/SwipeRow';

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// 진행 중 항목이 들어갈 묶음
function groupOf(t, today) {
  if (lastDate(t) < today) return 'overdue';
  if (occursOn(t, today)) return 'today';
  const d = daysBetween(today, t.date);
  if (d === 1) return 'tomorrow';
  return d <= 7 ? 'week' : 'later';
}
const GROUPS = [
  { id: 'overdue', label: '기한 지남' },
  { id: 'today', label: '오늘' },
  { id: 'tomorrow', label: '내일' },
  { id: 'week', label: '일주일 안' },
  { id: 'later', label: '나중에' },
];

// 오른쪽 작은 글자: '2일 지남' / '금' / '11/28' / 시간
function whenText(t, today, group) {
  if (group === 'overdue') {
    const n = daysBetween(lastDate(t), today);
    return n === 1 ? '어제까지' : `${n}일 지남`;
  }
  if (group === 'today' || group === 'tomorrow') return t.start || '';
  if (group === 'week') return ['일', '월', '화', '수', '목', '금', '토'][new Date(`${t.date}T00:00:00`).getDay()] + (t.start ? ` ${t.start}` : '');
  return shortDate(t);
}

export default function TasksScreen({ navigation }) {
  const { embedded } = useScreenEntry();
  const allTasks = useAllTasks(); // 모든 공간
  useProjects(); // 프로젝트 이름이 바뀌면 꼬리표도 다시 그리기
  const snack = useSnackbar();
  const [tab, setTab] = useState('open'); // 'open' 진행 중 | 'done' 완료
  // 걸러 보기: 공간('all' 또는 공간 id) · 내 담당 (담당자 이름이 내 이름과 같은 것. 담당자는 이름 글자로만 저장돼요)
  const { list: spaceList } = useWorkspaces();
  const spaces = useSpaceInfo();
  const multi = spaceList.length > 1;
  const [space, setSpace] = useState('all');
  const [mineOnly, setMineOnly] = useState(false);
  const myName = (useSettings().profile?.name ?? '').trim();
  const tasks = useMemo(
    () => allTasks.filter((t) => (space === 'all' || t.workspaceId === space) && (!mineOnly || (!!myName && (t.assignee || '').trim() === myName))),
    [allTasks, space, mineOnly, myName],
  );
  const today = toKey(new Date());
  const tomorrow = shiftKey(today, 1);

  const open = useMemo(() => tasks.filter((t) => t.status !== '완료'), [tasks]);
  const done = useMemo(() => tasks.filter((t) => t.status === '완료').sort((a, b) => b.updatedAt - a.updatedAt), [tasks]);
  const groups = useMemo(() => {
    const g = Object.fromEntries(GROUPS.map((x) => [x.id, []]));
    open.forEach((t) => g[groupOf(t, today)].push(t));
    return g;
  }, [open, today]);

  // 그 항목의 공간에서 고침 (보기 전용 공간이면 안내)
  const run = (t, ...args) => {
    try {
      taskIn(t, ...args);
      return true;
    } catch (e) {
      snack.show(e.code === 'read_only' ? '보기 전용 공간이라 바꿀 수 없어요' : '바꾸지 못했어요');
      return false;
    }
  };
  const complete = (t) => {
    if (!run(t, 'toggleDone', t.id)) return;
    if (t.status !== '완료') snack.show(`“${t.title}” 완료`, { label: '되돌리기', onPress: () => run(t, 'toggleDone', t.id) });
  };
  // 미루기: 오늘 이전·오늘 항목은 내일로, 이후 항목은 하루 뒤로 (여러 날 일정은 끝 날짜도 같이)
  const postpone = (t) => {
    const before = { date: t.date, endDate: t.endDate };
    const date = t.date <= today ? tomorrow : shiftKey(t.date, 1);
    const shift = daysBetween(t.date, date);
    if (!run(t, 'updateTask', t.id, { date, endDate: t.endDate ? shiftKey(t.endDate, shift) : '' })) return;
    snack.show(date === tomorrow ? `“${t.title}” 내일로 옮겼어요` : `“${t.title}” 하루 미뤘어요`, { label: '되돌리기', onPress: () => run(t, 'updateTask', t.id, before) });
  };

  const row = (t, group) => {
    const isDone = t.status === '완료';
    const proj = projectOf('tasks', t.id);
    const when = isDone ? shortDate(t) : whenText(t, today, group);
    const body = (
      <View style={styles.item}>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: isDone }} accessibilityLabel={`${t.title} 완료 표시`} onPress={() => complete(t)} hitSlop={8}>
          <Icon name={isDone ? 'checkSquare' : 'square'} size={22} color={isDone ? colors.mintDark : colors.muted} />
        </Pressable>
        <Pressable style={styles.body} accessibilityRole="button" onPress={() => { enterSpace(t.workspaceId); navigation.navigate(ROUTES.TaskEdit, { taskId: t.id }); }}>
          <Text style={[styles.title, isDone && styles.titleDone]} numberOfLines={1}>{t.title}</Text>
          {(t.kind === 'event' || !!proj || multi) && (
            <View style={styles.tags}>
              {multi && <SpaceTag space={spaces[t.workspaceId]} />}
              {t.kind === 'event' && <Tag label="일정" tone="outline" />}
              {!!proj && <Tag label={proj.title} style={{ maxWidth: 140 }} />}
            </View>
          )}
        </Pressable>
        {!!when && <Text style={[styles.when, group === 'overdue' && { color: colors.coral, fontWeight: '500' }]}>{when}</Text>}
      </View>
    );
    if (isDone) return <View key={t.id}>{body}</View>;
    return (
      <SwipeRow key={t.id} actionLabel={t.date <= today ? '내일로' : '하루 미루기'} onAction={() => postpone(t)}>
        {body}
      </SwipeRow>
    );
  };

  const [picker, setPicker] = useState(null); // 'status' | 'space'
  const spaceOptions = [{ id: 'all', name: '모든 공간' }, ...spaceList.map((w) => ({ id: w.id, name: spaces[w.id]?.name, color: spaces[w.id]?.color }))];
  const addTask = () => navigation.navigate(ROUTES.TaskEdit, { date: today, kind: 'task', ...(space !== 'all' ? { workspaceId: space } : {}) });
  return (
    <View style={styles.root}>
      <ScreenHeader
        title="할 일"
        onBack={navigation.goBack}
      />
      {/* 한 줄: 상태(진행 중, 완료)와 공간은 눌러서 목록에서 고른다. 오른쪽 끝에 추가 */}
      <View style={[st.filters, styles.filterRow]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`보기: ${tab === 'open' ? '진행 중' : '완료'}, 눌러서 고르기`} onPress={() => setPicker('status')} hitSlop={6} style={styles.spacePick}>
          <Text style={[st.filterText, { color: colors.ink }]}>{tab === 'open' ? '진행 중' : '완료'}</Text>
          <Icon name="chevronDown" size={12} color={colors.muted} />
        </Pressable>
        {!!myName && (
          <Pressable accessibilityRole="tab" accessibilityState={{ selected: mineOnly }} onPress={() => setMineOnly((v) => !v)} style={[st.filter, mineOnly && st.filterOn]}>
            <Text style={[st.filterText, mineOnly && { color: colors.ink }]}>내 담당</Text>
          </Pressable>
        )}
        <View style={{ flex: 1 }} />
        {multi && (
          <Pressable accessibilityRole="button" accessibilityLabel={`공간 ${spaceOptions.find((o) => o.id === space)?.name ?? '모든 공간'}, 눌러서 고르기`} onPress={() => setPicker('space')} hitSlop={6} style={styles.spacePick}>
            <Text style={st.filterText} numberOfLines={1}>{spaceOptions.find((o) => o.id === space)?.name ?? '모든 공간'}</Text>
            <Icon name="chevronDown" size={12} color={colors.muted} />
          </Pressable>
        )}
        {embedded && (
          <Pressable accessibilityRole="button" accessibilityLabel="할 일 추가" onPress={addTask} hitSlop={6} style={styles.spacePick}>
            <Icon name="plus" size={14} color={colors.muted} />
            <Text style={st.filterText}>추가</Text>
          </Pressable>
        )}
      </View>
      <SheetModal visible={!!picker} onClose={() => setPicker(null)} label={picker === 'space' ? '공간 고르기' : '보기 고르기'}>
        <View style={st.handle} />
        {(picker === 'space' ? spaceOptions : [{ id: 'open', name: '진행 중' }, { id: 'done', name: '완료' }]).map((o) => {
          const on = picker === 'space' ? o.id === space : o.id === tab;
          return (
            <Pressable key={o.id} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => { (picker === 'space' ? setSpace : setTab)(o.id); setPicker(null); }} style={st.menuRow}>
              <Text style={[st.menuLabel, { flex: 1 }]}>{o.name}</Text>
              {on && <Icon name="check" size={16} color={colors.ink} />}
            </Pressable>
          );
        })}
      </SheetModal>

      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.list}>
        {tab === 'open' ? (
          open.length === 0 ? (
            <Text style={styles.empty}>남은 할 일이 없어요</Text>
          ) : (
            <>
              {GROUPS.filter((g) => groups[g.id].length).map((g) => (
                <View key={g.id} style={styles.group}>
                  <Text style={[styles.groupTitle, g.id === 'overdue' && { color: colors.coral }]} accessibilityRole="header">
                    {g.label} {groups[g.id].length}
                  </Text>
                  {groups[g.id].map((t) => row(t, g.id))}
                </View>
              ))}
              <Text style={styles.hint}>왼쪽으로 밀면 내일로 미룰 수 있어요</Text>
            </>
          )
        ) : done.length === 0 ? (
          <Text style={styles.empty}>아직 완료한 항목이 없어요</Text>
        ) : (
          <View style={styles.group}>{done.map((t) => row(t, 'done'))}</View>
        )}
      </ScrollView>
      {!embedded && <BottomCreate label="할 일 추가" onPress={addTask} />}
      {snack.view}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  filterRow: { marginTop: 0, marginHorizontal: 20, alignItems: 'center' },
  spacePick: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44, maxWidth: 140 },
  list: {paddingHorizontal:20,paddingBottom:96,gap:20},
  group: { gap: spacing.sm },
  groupTitle: {fontSize:13,fontWeight:'500',color:colors.muted,marginLeft:4},
  item: {flexDirection:'row',alignItems:'center',gap:spacing.md,paddingHorizontal:0,paddingVertical:12,borderRadius:0,backgroundColor:colors.cream,borderWidth:0,borderColor:colors.line,borderBottomWidth:1},
  body: { flex: 1, minHeight: 40, justifyContent: 'center', gap: 4 },
  title: {fontSize:15,fontWeight:'500',color:colors.ink},
  titleDone: { color: colors.muted, textDecorationLine: 'line-through' },
  tags: { flexDirection: 'row', gap: 6 },
  when: { fontSize: font.caption, color: colors.muted },
  empty: { fontSize: 13, color: colors.subtle ?? colors.muted, paddingVertical: spacing.sm },
  hint: { fontSize: font.caption, color: colors.muted, textAlign: 'center' },
});
