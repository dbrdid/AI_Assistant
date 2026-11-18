// ============================================================
// ProjectListScreen.js — 프로젝트 목록 
// ============================================================


import React, { useState } from 'react';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import Icon from '../../../shared/components/Icon';
import { CircleButton, DashedButton, StatBox, Tag } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { deleteProject, useProjects } from '../../../data/projects/ProjectStore';

// 상태 → 꼬리표 모양 (진행 중: 민트, 완료: 흐림, 그 외: 테두리)
const toneOf = (status) => (status === '진행 중' ? 'mint' : status === '완료' ? 'muted' : 'outline');

export default function ProjectsScreen({ navigation }) {
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
    <View style={styles.root}>
      <ScreenHeader
        title={selecting ? `${ids.length}개 선택` : '프로젝트'}
        onBack={selecting ? exitSelect : navigation.goBack}
        right={!selecting && <CircleButton icon="plus" label="프로젝트 생성" onPress={() => navigation.navigate(ROUTES.ProjectEdit)} />}
      />
      <ScrollView contentContainerStyle={[styles.list, selecting && { paddingBottom: 110 }]}>
        <View style={styles.summary}>
          <StatBox icon="clock" label="진행 중" value={doing} style={styles.stat} />
          <StatBox icon="checkCircle" label="완료" value={done} style={styles.stat} />
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
              style={({ pressed }) => [styles.card, on && styles.cardOn, pressed && !on && { backgroundColor: '#F7FBF9' }]}
            >
              {selecting && <Icon name={on ? 'checkSquare' : 'square'} size={22} color={on ? colors.mintDark : colors.muted} />}
              <View style={{ flex: 1, gap: spacing.sm }}>
                <View style={styles.titleRow}>
                  <Text style={[styles.title, isDone && styles.titleDone]} numberOfLines={1}>{p.title}</Text>
                  <Tag label={p.status} tone={toneOf(p.status)} style={styles.tag} />
                </View>
                {/* 마감일 · 인원 (있는 값만) */}
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

        {!selecting && <DashedButton label="프로젝트 생성" onPress={() => navigation.navigate(ROUTES.ProjectEdit)} style={{ marginTop: 2 }} />}
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
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, gap: spacing.md, paddingBottom: spacing.xxl },
  summary: { flexDirection: 'row', gap: spacing.sm },
  stat: { backgroundColor: colors.white },
  empty: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  emptySub: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  hint: { fontSize: font.caption, color: colors.muted },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  cardOn: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, fontSize: font.header, fontWeight: '800', color: colors.ink },
  titleDone: { color: colors.muted },
  tag: { alignSelf: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta: { fontSize: 13, color: colors.muted },
  bar: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, backgroundColor: colors.cream, borderTopWidth: 1, borderTopColor: colors.line },
  barBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  barText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
