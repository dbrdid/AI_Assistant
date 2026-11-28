// ============================================================
// ProjectListScreen.js — 프로젝트 목록 
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { useScreenEntry } from '../../../navigation/ScreenEntry';
import Icon from '../../../shared/components/Icon';
import { BottomCreate, InlineDeletePrompt, Tag } from '../../../shared/components/Ui';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { deleteProject, useProjects } from '../../../data/projects/ProjectStore';
import { useClaimSwipeGesture } from '../../../shared/hooks/useClaimSwipeGesture';
import { projectsInDragRange } from '../projectDragSelection.mjs';

// 상태 → 꼬리표 모양 (진행 중: 민트, 완료: 흐림, 그 외: 테두리)
const toneOf = (status) => (status === '진행 중' ? 'mint' : status === '완료' ? 'muted' : 'outline');

export default function ProjectsScreen({ navigation }) {
  const { embedded } = useScreenEntry();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const claimSwipe = useClaimSwipeGesture();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState([]);
  const [dragging, setDragging] = useState(false);
  const viewport = useRef(null);
  const scroll = useRef(null);
  const offset = useRef(0);
  const contentHeight = useRef(0);
  const layouts = useRef(new Map());
  const drag = useRef(null);
  const edgeFrame = useRef(null);
  const ids = selected.filter((id) => projects.some((p) => p.id === id));
  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const finishDrag = () => {
    drag.current = null;
    cancelAnimationFrame(edgeFrame.current);
    edgeFrame.current = null;
    setDragging(false);
  };
  useEffect(() => () => cancelAnimationFrame(edgeFrame.current), []);
  const startDrag = (id, event) => {
    claimSwipe();
    const startY = event.nativeEvent.pageY;
    const gesture = { id, startY, currentY: startY, base: selected, projectIds: projects.map(project => project.id) };
    drag.current = gesture;
    setSelecting(true);
    setDragging(true);
    setSelected([...new Set([...selected, id])]);
    viewport.current?.measure((_, __, ___, height, ____, pageY) => {
      if (drag.current === gesture) Object.assign(gesture, { pageY, height });
    });
  };
  const updateRange = (gesture) => {
    if (gesture.pageY == null) return;
    const y = Math.max(0, Math.min(gesture.height, gesture.currentY - gesture.pageY));
    const range = projectsInDragRange(gesture.projectIds, layouts.current, gesture.id, y + offset.current);
    const next = [...new Set([...gesture.base, ...range])];
    setSelected(previous => previous.length === next.length && previous.every((id, i) => id === next[i]) ? previous : next);
  };
  const scrollAtEdge = () => {
    edgeFrame.current = null;
    const gesture = drag.current;
    if (!gesture || gesture.pageY == null) return;
    const edge = 36;
    const y = gesture.currentY - gesture.pageY;
    const direction = y < edge ? -1 : y > gesture.height - edge ? 1 : 0;
    const next = Math.max(0, Math.min(contentHeight.current - gesture.height, offset.current + direction * 8));
    if (next === offset.current || !direction) return;
    offset.current = next;
    scroll.current?.scrollTo({ y: next, animated: false });
    updateRange(gesture);
    edgeFrame.current = requestAnimationFrame(scrollAtEdge);
  };
  const moveDrag = event => {
    const gesture = drag.current;
    if (!gesture) return;
    if (event.nativeEvent.touches?.length > 1) { finishDrag(); return; }
    gesture.currentY = event.nativeEvent.pageY;
    if (Math.abs(gesture.currentY - gesture.startY) < 7 && !gesture.moved) return;
    gesture.moved = true;
    updateRange(gesture);
    if (edgeFrame.current == null) edgeFrame.current = requestAnimationFrame(scrollAtEdge);
  };
  const exitSelect = () => {
    finishDrag();
    setSelecting(false);
    setSelected([]);
  };
  const allSelected = projects.length > 0 && ids.length === projects.length;

  return (
    <View style={[styles.root, !embedded && styles.listEnd]}>
      <ScreenHeader
        title={selecting ? `${ids.length}개 선택` : '프로젝트'}
        onBack={selecting ? exitSelect : navigation.goBack}
        // 탭 안에서는 큰 제목 대신 오른쪽 동작만: 추가 (선택 중이면 선택 개수). 아래 '+' 줄은 두지 않음
        right={embedded ? (selecting
          ? <Text style={styles.hint}>{ids.length}개 선택</Text>
          : <Pressable accessibilityRole="button" accessibilityLabel="프로젝트 생성" onPress={() => navigation.navigate(ROUTES.ProjectEdit)} hitSlop={6} style={styles.addRow}>
              <Icon name="plus" size={14} color={colors.muted} /><Text style={styles.addText}>추가</Text>
            </Pressable>) : undefined}
      />
      <View ref={viewport} collapsable={false} style={styles.viewport} onTouchMove={moveDrag}
        onTouchEnd={() => { if (drag.current) finishDrag(); }} onTouchCancel={() => { if (drag.current) finishDrag(); }}>
      <ScrollView ref={scroll} scrollEnabled={!dragging} onScroll={event => { offset.current = event.nativeEvent.contentOffset.y; }}
        scrollEventThrottle={16} onContentSizeChange={(_, height) => { contentHeight.current = height; }}
        showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.list, selecting && { paddingBottom: 110 }]}>
        {projects.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>아직 프로젝트가 없어요</Text>
          </View>
        )}

        {projects.map((p) => {
          const isDone = p.status === '완료';
          const on = selected.includes(p.id);
          return (
            <Pressable
              key={p.id}
              accessibilityRole={selecting ? 'checkbox' : 'button'}
              accessibilityState={selecting ? { checked: on } : undefined}
              accessibilityLabel={`${p.title}, ${p.status}, ${p.members.length}명`}
              accessibilityHint="길게 누르고 끌면 여러 프로젝트를 선택할 수 있어요."
              onLayout={event => { layouts.current.set(p.id, event.nativeEvent.layout); }}
              onPress={() => (selecting ? toggle(p.id) : navigation.navigate(ROUTES.ProjectDetail, { projectId: p.id }))}
              onLongPress={event => startDrag(p.id, event)}
              delayLongPress={350}
              style={({ pressed }) => [styles.card, on && styles.cardOn, pressed && !on && { opacity: 0.75 }]}
            >
              {selecting && <Icon name={on ? 'checkSquare' : 'square'} size={22} color={on ? colors.ink : colors.muted} />}
              <View style={{ flex: 1, gap: spacing.sm }}>
                <View style={styles.titleRow}>
                  <Text style={[styles.title, isDone && styles.titleDone]} numberOfLines={1}>{p.title}</Text>
                  <Tag label={p.status} tone={toneOf(p.status)} style={styles.tag} />
                </View>
                {/* 마감일, 인원 (있는 값만) */}
                <View style={styles.metaRow}>
                  {!!p.due && (
                    <View style={styles.metaItem}>
                      <Icon name="calendar" size={15} color={colors.muted} />
                      <Text style={styles.meta}>마감 {p.due.slice(5).replace('-', '/')}</Text>
                    </View>
                  )}
                  <View style={styles.metaItem}>
                    <Icon name="users" size={15} color={colors.muted} />
                    <Text style={styles.meta}>{p.members.length}명</Text>
                  </View>
                </View>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
      </View>

      {selecting && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.sm }]}>
          <View style={styles.barRow}>
          <Pressable accessibilityRole="button" onPress={exitSelect} style={styles.barBtn}>
            <Text style={styles.barText}>취소</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setSelected(allSelected ? [] : projects.map((p) => p.id))} style={styles.barBtn}>
            <Text style={styles.barText}>{allSelected ? '해제' : '전체'}</Text>
          </Pressable>
          </View>
          {ids.length > 0 && <InlineDeletePrompt
            question={`프로젝트 ${ids.length}개를 삭제할까요?`}
            hint="프로젝트 안의 메모, 할 일, 파일은 보존됩니다."
            onDelete={() => { ids.forEach(deleteProject); exitSelect(); }}
          />}
        </View>
      )}
      {!selecting && !embedded && <BottomCreate label="프로젝트 생성" onPress={() => navigation.navigate(ROUTES.ProjectEdit)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  viewport: { flex: 1 },
  list: {paddingHorizontal:20,paddingTop:spacing.xs,gap:4,paddingBottom:spacing.xxl},
  empty: { paddingVertical: spacing.sm, gap: spacing.sm },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 44 },
  addText: { fontSize: 12, color: colors.muted },
  emptyTitle: { fontSize: 13, fontWeight: '400', color: colors.subtle },
  hint: { fontSize: font.caption, color: colors.muted },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 12, paddingHorizontal: spacing.sm, borderRadius: 4, borderWidth: 1, borderColor: 'transparent' },
  cardOn: { borderColor: colors.actionBorder, backgroundColor: colors.card },
  listEnd: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: {flex:1,fontSize:17,fontWeight:'500',color:colors.ink},
  titleDone: { color: colors.muted },
  tag: { alignSelf: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta: { fontSize: 13, color: colors.muted },
  bar: { paddingHorizontal: 20, paddingTop: 6, backgroundColor: colors.cream },
  barRow: { flexDirection: 'row', gap: 4 },
  barBtn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  barText: { fontSize: 15, fontWeight: '500', color: colors.ink },
});
