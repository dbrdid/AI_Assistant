// ============================================================
// ProjectListScreen.js — 프로젝트 목록 
// ============================================================


import React, { useState } from 'react';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { deleteProject, useProjects } from '../../../data/projects/ProjectStore';

export default function ProjectsScreen({ navigation }) {
  const menuSwipe = useSwipeToOpenMenu();
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState([]);
  const [confirm, setConfirm] = useState(false);
  const ids = selected.filter((id) => projects.some((p) => p.id === id));
  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const exitSelect = () => {
    setSelecting(false);
    setSelected([]);
  };
  const allSelected = projects.length > 0 && ids.length === projects.length;
  const done = projects.filter((p) => p.status === '완료').length;
  const doing = projects.length - done;

  return (
    <View style={styles.root} {...menuSwipe}>
      <ScreenHeader
        title={selecting ? `${ids.length}개 선택` : '프로젝트'}
        onBack={selecting ? exitSelect : undefined}
      />
      <ScrollView contentContainerStyle={[styles.list, selecting && { paddingBottom: 110 }]}>
        <View style={styles.summary}>
          <Text style={styles.sumText}>진행 중 : {doing}개</Text>
          <Text style={styles.sumText}>완료 : {done}개</Text>
        </View>
        {!selecting && projects.length > 0 && <Text style={styles.hint}>꾹 누르면 여러 개를 선택해 삭제할 수 있어요</Text>}

        {projects.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>아직 프로젝트가 없어요</Text>
            <Text style={styles.emptySub}>프로젝트를 만들면 메모, 할 일, 파일을 한곳에 모아 둘 수 있어요.</Text>
          </View>
        )}

        {projects.map((p) => {
          const isDone = p.status === '완료';
          const on = selected.includes(p.id);
          return (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityState={selecting ? { checked: on } : undefined}
              accessibilityLabel={`${p.title}, ${p.status}, ${p.members.length}명`}
              onPress={() => (selecting ? toggle(p.id) : navigation.navigate(ROUTES.ProjectDetail, { projectId: p.id }))}
              onLongPress={() => {
                if (!selecting) {
                  setSelecting(true);
                  setSelected([p.id]);
                }
              }}
              delayLongPress={350}
              style={({ pressed }) => [styles.card, on && styles.cardOn, pressed && { backgroundColor: colors.mintSoft }]}
            >
              {selecting && <Text style={[styles.check, on && { color: colors.mintDark }]}>{on ? '☑' : '☐'}</Text>}
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={[styles.title, isDone && styles.titleDone]} numberOfLines={1}>{p.title}</Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {p.status}{p.due ? ` · 마감 ${p.due.slice(5).replace('-', '/')}` : ''}
                </Text>
              </View>
              <Text style={styles.people}>👥 {p.members.length}명</Text>
            </Pressable>
          );
        })}

        {!selecting && (
          <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.ProjectEdit)} style={styles.add}>
            <Text style={styles.addText}>＋ 프로젝트 생성</Text>
          </Pressable>
        )}
      </ScrollView>

      {/* 선택 모드 아래 줄: 취소 · 전체/해제 · 삭제 */}
      {selecting && (
        <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.sm }]}>
          <Pressable accessibilityRole="button" onPress={exitSelect} style={styles.barBtn}>
            <Text style={styles.barText}>취소</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={() => setSelected(allSelected ? [] : projects.map((p) => p.id))} style={styles.barBtn}>
            <Text style={styles.barText}>{allSelected ? '해제' : '전체'}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={ids.length === 0} onPress={() => setConfirm(true)} style={[styles.barBtn, ids.length === 0 && { opacity: 0.4 }]}>
            <Text style={[styles.barText, { color: colors.coral }]}>삭제</Text>
          </Pressable>
        </View>
      )}

      <ConfirmDialog
        visible={confirm}
        title={`프로젝트 ${ids.length}개를 삭제할까요?`}
        sub="프로젝트만 삭제돼요. 안에 있던 메모·할 일·파일은 지워지지 않고 프로젝트에서만 빠져요."
        confirmText="삭제"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          ids.forEach((id) => deleteProject(id));
          setConfirm(false);
          exitSelect();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  summary: { flexDirection: 'row', gap: spacing.lg },
  sumText: { fontSize: font.body, fontWeight: '700', color: colors.muted },
  empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  emptySub: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  hint: { fontSize: font.caption, color: colors.muted },
  cardOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  check: { fontSize: 24, color: colors.muted },
  bar: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, backgroundColor: colors.cream, borderTopWidth: 1, borderTopColor: colors.line },
  barBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  barText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, minHeight: 64 },
  title: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  titleDone: { color: colors.muted, textDecorationLine: 'line-through' },
  meta: { fontSize: font.caption, color: colors.muted },
  people: { fontSize: font.body, color: colors.mintDark, fontWeight: '700' },
  add: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm },
  addText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
});
