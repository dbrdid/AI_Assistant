// ============================================================
// QuickInputScreen.js — 빠른 입력
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { useScreenEntry } from '../../../navigation/ScreenEntry';
import { ROUTES } from '../../../navigation/routes';
import { BarAction, BottomBar } from '../../../shared/components/Ui';
import Icon from '../../../shared/components/Icon';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { toKey } from '../../calendar/utils/DateUtils';
import { addMemo, memoTitle, useMemos } from '../../../data/memos/MemoStore';
import { analyzeText } from '../../../services/ai/AiAnalyze';
import { addAsset, checkAsset, pickAssets } from '../../../data/files/FileStore';
import { linkItems, projectOf, setItemProject, useProjects } from '../../../data/projects/ProjectStore';
import { shortDate, tagText, useTasks } from '../../../data/tasks/TaskStore';
import { scopedKey, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import { useNotice } from '../../../shared/components/SettingsUi';
import { useClaimSwipeGesture } from '../../../shared/hooks/useClaimSwipeGesture';
import { canLinkProjectItems, canManageProjectItems } from '../../project/projectPermissions';
import { maybeRuntime } from '../../../data/hooks';
import { isProjectLeader } from '../../../lib/stella/project-team';

const MAX_LEN = 2000;
const DRAFT_KEY = 'myapp.quickinput.draft.v1';
const FILTERS = [
  { id: 'all', label: '전체' },
  { id: 'event', label: '일정' },
  { id: 'todo', label: '할 일' },
  { id: 'memo', label: '메모' },
];
const LINK_ICONS = { event: 'calendar', todo: 'checkSquare', memo: 'file', file: 'paperclip' };
const LINK_HOLD_MS = 280;
const DRAG_THRESHOLD = 6;
const UNLINK_TARGET = Symbol('unlink');
const PROJECT_PANEL_MIN_HEIGHT = 44;
const PROJECT_PANEL_STEP = 56;
const ProjectResizeHandle = Platform.OS === 'web' ? 'div' : View;

function insideDropArea(bounds, x, y) {
  return bounds && x >= bounds.x && x <= bounds.x + bounds.width && y >= bounds.y && y <= bounds.y + bounds.height;
}

function dragPoint(event) {
  const touch = event.nativeEvent ?? event;
  return Platform.OS === 'web' ? { x: touch.clientX ?? touch.pageX - window.scrollX, y: touch.clientY ?? touch.pageY - window.scrollY } : { x: touch.pageX, y: touch.pageY };
}

function measureDragArea(view, measured) {
  if (Platform.OS === 'web') {
    const bounds = view?.getBoundingClientRect();
    if (bounds) measured(bounds);
    return;
  }
  view?.measure((_, __, width, height, x, y) => measured({ x, y, width, height }));
}

export default function QuickInputScreen({ navigation, route }) {
  const tasks = useTasks();
  const projects = useProjects();
  const memos = useMemos();
  const { current: workspace } = useWorkspaces();
  const canLink = canLinkProjectItems(workspace);
  const notice = useNotice();
  const [tab, setTab] = useState(route?.params?.tab === 'file' ? 'file' : 'memo');
  const [body, setBody] = useState('');
  const [taskIds, setTaskIds] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [filter, setFilter] = useState('all');
  const [staged, setStaged] = useState([]); // [{ key, asset, status:'ready'|'uploading'|'done'|'failed', reason, canRetry }]
  const [loaded, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [picked, setPicked] = useState(null);
  const [hoveredTarget, setHoveredTarget] = useState(null);
  const [availableHeight, setAvailableHeight] = useState(0);
  const [panelHeight, setPanelHeight] = useState(null);
  const [laidOutPanelHeight, setLaidOutPanelHeight] = useState(0);
  const panelResize = useRef(null);
  const claimSwipe = useClaimSwipeGesture();
  const screenRef = useRef(null);
  const sourceViewport = useRef(null);
  const unlinkedArea = useRef(null);
  const projectArea = useRef(null);
  const projectTargets = useRef(new Map());
  const linkDrag = useRef(null);
  const dragPosition = useRef(new Animated.ValueXY()).current;
  const leaving = useRef(null);
  const keySeq = useRef(0);
  const todayKey = toKey(new Date());
  const maxPanelHeight = Math.max(PROJECT_PANEL_MIN_HEIGHT, Math.floor(availableHeight * 0.68));
  const defaultPanelHeight = Math.max(PROJECT_PANEL_MIN_HEIGHT, Math.floor(availableHeight * 0.28));
  const clampPanelHeight = height => Math.round(Math.max(PROJECT_PANEL_MIN_HEIGHT, Math.min(maxPanelHeight, height)));
  const resizePanel = height => setPanelHeight(clampPanelHeight(height));
  const beginPanelResize = (event) => {
    if (linkDrag.current) return false;
    claimSwipe();
    panelResize.current = { startY: dragPoint(event).y, height: laidOutPanelHeight, moved: false };
    return true;
  };
  const movePanelResize = (event) => {
    const gesture = panelResize.current;
    if (!gesture) return;
    const distance = gesture.startY - dragPoint(event).y;
    if (!gesture.moved && Math.abs(distance) < DRAG_THRESHOLD) return;
    gesture.moved = true;
    resizePanel(gesture.height + distance);
  };
  const togglePanel = () => resizePanel(laidOutPanelHeight <= PROJECT_PANEL_MIN_HEIGHT + 2 ? defaultPanelHeight : PROJECT_PANEL_MIN_HEIGHT);
  const finishPanelResize = () => {
    const gesture = panelResize.current;
    panelResize.current = null;
    if (gesture && !gesture.moved) togglePanel();
  };
  const cancelPanelResize = () => { panelResize.current = null; };
  const panelHandleProps = Platform.OS === 'web'
    ? {
      role: 'slider', tabIndex: 0, 'aria-label': '프로젝트 높이 조절', 'aria-orientation': 'vertical',
      'aria-valuemin': PROJECT_PANEL_MIN_HEIGHT, 'aria-valuemax': maxPanelHeight,
      'aria-valuenow': clampPanelHeight(laidOutPanelHeight),
      onPointerDown: event => {
        if (!event.isPrimary || event.button !== 0 || !beginPanelResize(event)) return;
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: movePanelResize, onPointerUp: finishPanelResize, onLostPointerCapture: cancelPanelResize,
      onKeyDown: event => {
        if (event.key === 'ArrowUp') resizePanel(laidOutPanelHeight + PROJECT_PANEL_STEP);
        else if (event.key === 'ArrowDown') resizePanel(laidOutPanelHeight - PROJECT_PANEL_STEP);
        else if (event.key === 'Home') resizePanel(PROJECT_PANEL_MIN_HEIGHT);
        else if (event.key === 'End') resizePanel(maxPanelHeight);
        else if (event.key === 'Enter' || event.key === ' ') togglePanel();
        else return;
        event.preventDefault();
      },
    }
    : {
      accessible: true, accessibilityRole: 'adjustable', accessibilityLabel: '프로젝트 높이 조절',
      accessibilityHint: '위아래로 끌어 높이를 조절하거나 눌러 접으세요',
      accessibilityValue: { min: PROJECT_PANEL_MIN_HEIGHT, max: maxPanelHeight, now: clampPanelHeight(laidOutPanelHeight) },
      accessibilityActions: [{ name: 'increment' }, { name: 'decrement' }, { name: 'activate' }],
      onAccessibilityAction: ({ nativeEvent }) => {
        if (nativeEvent.actionName === 'activate') togglePanel();
        else resizePanel(laidOutPanelHeight + (nativeEvent.actionName === 'increment' ? PROJECT_PANEL_STEP : -PROJECT_PANEL_STEP));
      },
      onStartShouldSetResponder: () => !linkDrag.current,
      onTouchStart: event => { event.stopPropagation(); claimSwipe(); },
      onResponderGrant: beginPanelResize, onResponderMove: movePanelResize,
      onResponderRelease: finishPanelResize, onResponderTerminate: cancelPanelResize,
      onResponderTerminationRequest: () => false,
    };

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

  const taskRows = tasks.map(task => ({
    id: task.id,
    kind: 'task',
    category: (task.kind ? task.kind === 'event' : !!task.start) ? 'event' : 'todo',
    title: task.title,
    sub: `${shortDate(task)}, ${tagText(task, todayKey)}`,
    available: task.status !== '완료',
  }));
  const memoRows = memos.map(memo => ({ id: memo.id, kind: 'memo', category: 'memo', title: memoTitle(memo), available: true }));
  const draft = tab === 'memo'
    ? { id: 'draft', kind: 'draft', category: 'memo', title: body.trim().split('\n')[0].slice(0, 60) || '작성 중인 메모' }
    : { id: 'draft', kind: 'draft', category: 'file', title: '선택한 파일' };
  const itemKey = row => `${row.kind}-${row.id}`;
  const tasksById = new Map(taskRows.map(row => [row.id, row]));
  const memosById = new Map(memoRows.map(row => [row.id, row]));
  const grouped = new Map(projects.map(project => {
    const children = [
      ...project.links.tasks.map(id => tasksById.get(id)),
      ...project.links.memos.map(id => memosById.get(id)),
    ].filter(Boolean)
      .map(row => ({ ...row, projectId: project.id }));
    if (projectId === project.id) children.unshift(draft);
    return [project.id, children];
  }));
  const linked = new Set([...grouped.values()].flat().map(itemKey));
  const candidates = [...(projectId ? [] : [draft]), ...[...taskRows, ...memoRows]
    .filter(row => row.available && !linked.has(itemKey(row)) && (filter === 'all' || filter === row.category)).slice(0, 40)];

  const canMoveFrom = project => {
    if (!project) return true;
    const members = project.members.map(member => ({ account_id: member.accountId ?? null, role: member.role, deleted_at: null }));
    return canManageProjectItems({ workspace, projectLeader: isProjectLeader(members, maybeRuntime()?.session.id) });
  };

  const isProjectLinked = row => Boolean(row && (row.kind === 'draft' ? projectId : row.projectId));

  const changeProjectLink = (row, targetId, toggleDraft = false) => {
    setPicked(null);
    if (!row || !canLink) return;
    if (targetId === null ? !isProjectLinked(row) : !projects.some(project => project.id === targetId)) return;
    if (row.kind === 'draft') {
      setProjectId(current => toggleDraft && current === targetId ? null : targetId);
      return;
    }
    const currentProject = projectOf(row.kind, row.id);
    const currentId = currentProject?.id ?? null;
    if (currentId !== (row.projectId ?? null) || !canMoveFrom(currentProject) || currentId === targetId) return;
    if (!setItemProject(row.kind, row.id, targetId)) return;
    if (targetId === null) setFilter(current => current === 'all' ? current : row.category);
    if (!workspace.personal && row.kind === 'memo') {
      notice.show(targetId === null ? '연결 해제를 요청했어요' : '연결을 요청했어요');
    }
  };

  const beginLinkDrag = (row, event) => {
    if (!canLink || !projects.length) return;
    claimSwipe();
    const drag = { row, canUnlink: isProjectLinked(row), start: dragPoint(event), targets: new Map(), moved: false };
    linkDrag.current = drag;
    setPicked(row);
    setDragging(row);
    measureDragArea(screenRef.current, (bounds) => { drag.screen = bounds; });
    measureDragArea(projectArea.current, (bounds) => { drag.viewport = bounds; });
    for (const [id, view] of projectTargets.current) {
      measureDragArea(view, (bounds) => { drag.targets.set(id, bounds); });
    }
  };

  const targetAt = (drag, { x, y }) => {
    if (!drag.viewport) return null;
    if (!insideDropArea(drag.viewport, x, y)) return drag.canUnlink ? UNLINK_TARGET : null;
    for (const [id, bounds] of drag.targets) if (insideDropArea(bounds, x, y)) return id;
    return null;
  };

  const endLinkDrag = (event) => {
    const drag = linkDrag.current;
    if (!drag) return;
    linkDrag.current = null;
    setDragging(null);
    setHoveredTarget(null);
    if (!drag.moved && event) return;
    setPicked(null);
    const target = event && targetAt(drag, dragPoint(event));
    if (target) changeProjectLink(drag.row, target === UNLINK_TARGET ? null : target);
  };

  const moveLinkDrag = (event) => {
    const drag = linkDrag.current;
    if (!drag) return;
    if (event.nativeEvent?.touches?.length > 1) { endLinkDrag(); return; }
    const point = dragPoint(event);
    if (!drag.moved && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < DRAG_THRESHOLD) return;
    if (drag.screen) {
      const x = Math.min(Math.max(8, point.x - drag.screen.x - 76), Math.max(8, drag.screen.width - 168));
      dragPosition.setValue({ x, y: Math.max(0, point.y - drag.screen.y - 44) });
    }
    if (!drag.moved) setDragging({ ...drag.row });
    drag.moved = true;
    setHoveredTarget(targetAt(drag, point));
  };

  const dragHandlers = useRef(null);
  dragHandlers.current = { moveLinkDrag, endLinkDrag };
  useEffect(() => {
    if (!dragging || Platform.OS !== 'web') return;
    const move = event => dragHandlers.current.moveLinkDrag(event);
    const release = event => dragHandlers.current.endLinkDrag(event);
    const cancel = () => dragHandlers.current.endLinkDrag();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [dragging]);

  const changeTab = next => {
    endLinkDrag();
    setPicked(null);
    setTab(next);
  };

  const chooseLinkSource = row => setPicked(current => current && itemKey(current) === itemKey(row) ? null : row);
  const linkRowContent = row => (
    <>
      <Icon name={LINK_ICONS[row.category]} size={17} color={colors.muted} />
      <View style={styles.rowCopy}>
        <Text style={styles.rowTitle} numberOfLines={1}>{row.title}</Text>
        {!!row.sub && <Text style={styles.rowSub}>{row.sub}</Text>}
      </View>
    </>
  );
  const sourceRow = (row, nested = false) => {
    const selected = picked && itemKey(picked) === itemKey(row);
    const canMove = canLink && projects.length > 0 && canMoveFrom(projects.find(project => project.id === row.projectId));
    if (!canMove) return <View key={itemKey(row)} style={[styles.row, nested && styles.childRow]}>{linkRowContent(row)}</View>;
    return (
      <Pressable key={itemKey(row)} accessibilityRole="button" accessibilityState={{ selected: Boolean(selected) }}
        accessibilityLabel={row.title}
        accessibilityHint={nested ? '길게 눌러 프로젝트 밖으로 끌어 놓으면 연결이 해제돼요' : '길게 눌러 프로젝트로 끌거나, 항목을 누른 뒤 프로젝트를 선택하세요'}
        onPress={() => chooseLinkSource(row)} onLongPress={event => beginLinkDrag(row, event)} delayLongPress={LINK_HOLD_MS}
        style={[styles.row, nested && styles.childRow, selected && styles.rowOn]}>
        {linkRowContent(row)}
      </Pressable>
    );
  };

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
  const canSave = tab === 'memo' ? body.trim().length > 0 : readyCount > 0;

  return (
    <View ref={screenRef} collapsable={false} style={styles.root}
      onTouchMove={Platform.OS !== 'web' ? moveLinkDrag : undefined}
      onTouchEnd={Platform.OS !== 'web' ? endLinkDrag : undefined}
      onTouchCancel={() => endLinkDrag()}>
      {!embedded && <ScreenHeader title="빠른 입력" onBack={navigation.goBack} />}
      <View style={styles.tabs}>
        {[{ id: 'memo', label: '메모' }, { id: 'file', label: '사진과 문서' }].map((t) => (
          <Pressable key={t.id} accessibilityRole="tab" accessibilityState={{ selected: tab === t.id }} onPress={() => changeTab(t.id)} style={[styles.tab, tab === t.id && styles.tabOn]}>
            <Text style={[styles.tabText, tab === t.id && { color: colors.ink, fontWeight: '700' }]}>{t.label}</Text>
          </Pressable>
        ))}
        {embedded && (
          <View style={styles.embeddedSave}>
            <BarAction label="저장" onPress={onSave} style={!canSave ? { opacity: 0.45 } : undefined} />
          </View>
        )}
      </View>

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}
        onLayout={event => setAvailableHeight(Math.floor(event.nativeEvent.layout.height))}>
        <View ref={sourceViewport} collapsable={false} style={styles.sourceViewport}>
          <ScrollView scrollEnabled={!dragging} showsVerticalScrollIndicator={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
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

          <View ref={unlinkedArea} collapsable={false} style={styles.unlinkedArea}>
            <Pressable accessibilityRole={isProjectLinked(picked) ? 'button' : 'header'}
              accessibilityLabel={isProjectLinked(picked) ? '프로젝트 연결 해제' : '연결할 항목'}
              disabled={!isProjectLinked(picked)} onPress={() => changeProjectLink(picked, null)} style={styles.unlinkedHeading}>
              <Text style={styles.sectionTitle}>연결할 항목</Text>
            </Pressable>
            {canLink && (
              <Text style={styles.counter}>
                {isProjectLinked(picked) ? '프로젝트 밖으로 끌어 놓으면 연결이 해제돼요' : !projects.length ? '아래 프로젝트에서 + 를 눌러 만든 뒤 항목을 연결하세요' : '항목을 길게 눌러 프로젝트로 끌어 놓으세요'}
              </Text>
            )}
            <ScrollView showsHorizontalScrollIndicator={false} horizontal contentContainerStyle={styles.filters}>
              {FILTERS.map((f) => (
                <Pressable key={f.id} accessibilityRole="button" accessibilityState={{ selected: filter === f.id }} onPress={() => { setPicked(null); setFilter(f.id); }} style={styles.chip}>
                  <Text style={[styles.chipText, filter === f.id && { color: colors.ink, fontWeight: '700' }]}>{f.label}</Text>
                </Pressable>
              ))}
            </ScrollView>
            {candidates.length ? candidates.map(row => sourceRow(row)) : <Text style={styles.counter}>연결할 항목이 없어요</Text>}
          </View>
          </ScrollView>
        </View>
        <View ref={projectArea} collapsable={false}
          onLayout={event => setLaidOutPanelHeight(Math.floor(event.nativeEvent.layout.height))}
          style={[styles.projectArea, panelHeight === null
            ? { maxHeight: availableHeight ? defaultPanelHeight : '28%' }
            : { height: clampPanelHeight(panelHeight) }]}>
          <View style={styles.projectHeader}>
            <ProjectResizeHandle {...panelHandleProps} style={Platform.OS === 'web'
              ? { ...styles.panelHandle, display: 'flex', flexDirection: 'column', touchAction: 'none', cursor: 'ns-resize', userSelect: 'none' }
              : styles.panelHandle}>
              <View style={styles.panelHandleMark} />
              <View style={styles.projectTitleRow}>
                <Text style={styles.projectTitle}>프로젝트</Text>
              </View>
            </ProjectResizeHandle>
            {canLink && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="프로젝트 추가"
                onPress={() => navigation.navigate(ROUTES.ProjectEdit)}
                hitSlop={8}
                style={({ pressed }) => [styles.projectAddBtn, pressed && { opacity: 0.6 }]}
              >
                <Icon name="plus" size={16} color={colors.muted} />
              </Pressable>
            )}
          </View>
          <ScrollView scrollEnabled={!dragging} showsVerticalScrollIndicator persistentScrollbar={Platform.OS === 'android'}
            keyboardShouldPersistTaps="handled">
            {projects.length === 0 ? (
              <Text style={styles.projectEmpty}>아직 프로젝트가 없어요</Text>
            ) : projects.map(project => (
              <View key={project.id}>
                <View ref={view => {
                  if (view) projectTargets.current.set(project.id, view);
                  else projectTargets.current.delete(project.id);
                }} collapsable={false}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`${project.title}, 연결할 프로젝트`}
                    accessibilityState={{ disabled: !picked }} disabled={!picked}
                    onPress={() => changeProjectLink(picked, project.id, true)}
                    style={[styles.row, hoveredTarget === project.id && styles.rowOn]}>
                    <Icon name="folder" size={18} color={colors.muted} />
                    <Text numberOfLines={1} style={styles.rowTitle}>{project.title}</Text>
                  </Pressable>
                </View>
                {grouped.get(project.id).map(row => sourceRow(row, true))}
              </View>
            ))}
          </ScrollView>
        </View>
        {/* 하단 줄: 홈 개요 도크와 같은 자리. 왼쪽 상태, 오른쪽 저장 */}
        {!embedded && <BottomBar style={{ justifyContent: 'space-between' }}>
          <Text style={[styles.counter, tab === 'memo' && body.length >= MAX_LEN && { color: colors.coral }]}>
            {tab === 'memo' ? (body.length >= MAX_LEN * 0.9 ? `${body.length}/${MAX_LEN}` : '') : readyCount > 0 ? `${readyCount}개 선택` : ''}
          </Text>
          <BarAction label="저장" onPress={onSave} />
        </BottomBar>}
      </KeyboardAvoidingView>
      {dragging && linkDrag.current?.moved && (
        <Animated.View pointerEvents="none" accessible={false} style={[styles.dragPreview, { transform: dragPosition.getTranslateTransform() }]}>
          <Text numberOfLines={1} style={styles.rowTitle}>{dragging.title}</Text>
        </Animated.View>
      )}
      {notice.view}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  // 메모 / 사진 문서 전환: 밝은 채움 대신 Stella 필터처럼 밑줄로 선택을 표시
  tabs: { flexDirection: 'row', alignItems: 'center', gap: 20, marginHorizontal: 20, marginTop: spacing.xs, marginBottom: spacing.sm },
  embeddedSave: { marginLeft: 'auto' },
  createProjectLink: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, alignSelf: 'flex-start' },
  createProjectText: { fontSize: 13, fontWeight: '600', color: colors.ink },
  tab: { minHeight: 44, justifyContent: 'center' },
  tabOn: {},
  tabText: { fontSize: 12, color: colors.muted },
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
  sourceViewport: { flex: 1 },
  unlinkedArea: { marginTop: spacing.lg, gap: spacing.sm },
  unlinkedHeading: { minHeight: 28, justifyContent: 'center' },
  sectionTitle: { fontSize: 12, fontWeight: '400', color: colors.muted },
  filters: { gap: 20 },
  chip: { minHeight: 44, justifyContent: 'center' },
  chipOn: {},
  chipText: { fontSize: 12, color: colors.muted },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: 'transparent', borderRadius: radius.sm, minHeight: 44 },
  rowOn: { borderColor: colors.ink },
  rowCopy: { flex: 1, gap: 2 },
  childRow: { marginLeft: 18, minHeight: 42 },
  projectArea: { marginHorizontal: 20, marginBottom: spacing.sm, borderTopWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  projectHeader: { position: 'relative' },
  panelHandle: { flexShrink: 0, paddingTop: 10, gap: 10 },
  panelHandleMark: { alignSelf: 'center', width: 30, height: 3, borderRadius: 2, backgroundColor: colors.muted },
  projectTitleRow: { height: 28, justifyContent: 'center', paddingHorizontal: 10 },
  projectTitle: { fontSize: font.caption, color: colors.muted },
  projectAddBtn: { position: 'absolute', right: 0, bottom: 0, width: 36, height: 28, alignItems: 'center', justifyContent: 'center' },
  projectEmpty: { fontSize: font.caption, color: colors.muted, paddingHorizontal: 10, paddingVertical: 8 },
  dragPreview: { position: 'absolute', top: 0, left: 0, zIndex: 10, width: 160, paddingHorizontal: 10, paddingVertical: 9, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.ink, backgroundColor: colors.card },
  rowTitle: { fontSize: 15, fontWeight: '500', color: colors.ink },
  rowSub: { fontSize: font.caption, color: colors.muted },
});
