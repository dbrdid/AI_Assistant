// ============================================================
// ProjectDetailScreen.js — 프로젝트 화면 (스토리보드 69~70장)
// ============================================================
// route.params: { projectId }
// 위: 프로젝트 이름 + 정보 줄(상태·마감·담당자)   오른쪽 위 👥 = 팀원 초대
// 가운데 "연결된 항목": 메모 / 할 일 / 파일 / 일정 / 팀원  (누르면 펼쳐져서 목록이 보임. 항목을 누르면 열림)
//     각 구역의 "＋ 연결"로 이미 있는 메모·할 일·파일·일정을 이 프로젝트에 붙임
// 아래: [프로젝트 편집] → 편집 모드(체크박스로 여러 개 선택 → 이동 / 편집 / 연결 해제), [정보 수정]
// 항목을 꾹 눌러도 편집 모드가 켜지고 그 항목이 선택됩니다.
// ※ 연결 해제 = 프로젝트에서만 빼는 것(항목은 그대로).
// ※ 삭제 = 메모는 휴지통으로(복구하면 이 프로젝트로 자동 복구), 할 일·일정·파일은 완전히 삭제.

import React, { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { memoTitle, trashMemos, useMemos } from '../../../data/memos/MemoStore';
import { deleteTask, useTasks } from '../../../data/tasks/TaskStore';
import { deleteFile, useFiles } from '../../../data/files/FileStore';
import { getProject, linkItems, unlinkItems, useProjects } from '../../../data/projects/ProjectStore';

export default function ProjectDetailScreen({ navigation, route }) {
  const projectId = route?.params?.projectId;
  const projects = useProjects(); // 바뀌면 다시 그리기 위해 구독
  const project = getProject(projectId);
  const memos = useMemos();
  const tasks = useTasks();
  const files = useFiles();

  const [open, setOpen] = useState({ memos: true, todos: false, files: false, events: false });
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState([]);       // 편집 모드에서 체크한 항목 키 ('kind:id')
  const [adding, setAdding] = useState(null);      // 연결 추가 창: 'memos' | 'todos' | 'files' | 'events' | null
  const [addPicked, setAddPicked] = useState([]);
  const [moving, setMoving] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 구역별 "연결된 항목" / "연결할 수 있는 후보" 계산
  const sections = useMemo(() => {
    if (!project) return [];
    const L = project.links;
    const inL = (kind, id) => L[kind].includes(id);
    const taskKind = (t) => (t.start ? 'events' : 'todos');
    return [
      { key: 'memos', kind: 'memos', label: '메모', unit: '개', all: memos.map((m) => ({ id: m.id, title: memoTitle(m), sub: `수정 ${new Date(m.updatedAt).getMonth() + 1}/${new Date(m.updatedAt).getDate()}` })) },
      { key: 'todos', kind: 'tasks', label: '할 일', unit: '개', all: tasks.filter((t) => taskKind(t) === 'todos').map((t) => ({ id: t.id, title: t.title, sub: `${t.date.slice(5).replace('-', '/')} · ${t.status}` })) },
      { key: 'files', kind: 'files', label: '파일', unit: '개', all: files.map((f) => ({ id: f.id, title: f.name, sub: `${f.kind} · ${f.size}` })) },
      { key: 'events', kind: 'tasks', label: '일정', unit: '개', all: tasks.filter((t) => taskKind(t) === 'events').map((t) => ({ id: t.id, title: t.title, sub: `${t.date.slice(5).replace('-', '/')} ${t.start}` })) },
    ].map((s) => ({ ...s, items: s.all.filter((x) => inL(s.kind, x.id)), candidates: s.all.filter((x) => !inL(s.kind, x.id)) }));
  }, [project, memos, tasks, files]);

  if (!project) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="프로젝트" onBack={navigation.goBack} />
        <Text style={styles.gone}>프로젝트를 찾을 수 없어요.</Text>
      </View>
    );
  }

  const otherProjects = projects.filter((p) => p.id !== project.id);
  const keyOf = (s, id) => `${s.key}:${id}`;
  const allKeys = sections.flatMap((s) => s.items.map((x) => keyOf(s, x.id)));
  const toggle = (k) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
  const pickedBySection = (fn) =>
    sections.forEach((s) => {
      const ids = s.items.filter((x) => picked.includes(keyOf(s, x.id))).map((x) => x.id);
      if (ids.length) fn(s, ids);
    });
  const exitEdit = () => {
    setEditing(false);
    setPicked([]);
  };

  const openItem = (s, id) => {
    if (s.kind === 'memos') navigation.navigate(ROUTES.MemoEdit, { memoId: id });
    else if (s.kind === 'tasks') navigation.navigate(ROUTES.TaskEdit, { taskId: id });
    else navigation.navigate(ROUTES.Files, { focusId: id });
  };
  const editPicked = () => {
    if (picked.length !== 1) return;
    const [key, id] = [picked[0].split(':')[0], picked[0].slice(picked[0].indexOf(':') + 1)];
    openItem(sections.find((s) => s.key === key), id);
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title={project.title}
        onBack={navigation.goBack}
        right={
          <Pressable accessibilityRole="button" accessibilityLabel="팀원 초대" onPress={() => navigation.navigate(ROUTES.ProjectInvite, { projectId })} hitSlop={10}>
            <Text style={styles.headIcon}>👥＋</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.info}>
          <Text style={styles.infoLine}>
            {project.status}{project.due ? ` · 마감 ${project.due}` : ''}{project.assignee ? ` · 담당 ${project.assignee}` : ''}{project.place ? ` · ${project.place}` : ''}
          </Text>
          {!!project.desc && <Text style={styles.desc}>{project.desc}</Text>}
        </View>

        <Text style={styles.heading}>연결된 항목</Text>

        {sections.map((s) => {
          const isOpen = open[s.key] || editing;
          return (
            <View key={s.key} style={styles.section}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: isOpen }} onPress={() => setOpen((o) => ({ ...o, [s.key]: !o[s.key] }))} style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>{s.label} {s.items.length}{s.unit}</Text>
                <Text style={styles.chev}>{isOpen ? '▴' : '▾'}</Text>
              </Pressable>
              {isOpen && (
                <View style={{ gap: spacing.sm }}>
                  {s.items.length === 0 && <Text style={styles.none}>연결된 {s.label}이(가) 없어요</Text>}
                  {s.items.map((x) => {
                    const k = keyOf(s, x.id);
                    const on = picked.includes(k);
                    return (
                      <Pressable
                        key={x.id}
                        accessibilityRole={editing ? 'checkbox' : 'button'}
                        accessibilityState={editing ? { checked: on } : undefined}
                        onPress={() => (editing ? toggle(k) : openItem(s, x.id))}
                        onLongPress={() => {
                          if (!editing) {
                            setEditing(true);
                            setPicked([k]);
                          }
                        }}
                        delayLongPress={350}
                        style={[styles.item, on && styles.itemOn]}
                      >
                        {editing && <Text style={[styles.check, on && { color: colors.mintDark }]}>{on ? '☑' : '☐'}</Text>}
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text style={styles.itemTitle} numberOfLines={1}>{x.title}</Text>
                          <Text style={styles.itemSub} numberOfLines={1}>{x.sub}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                  {!editing && (
                    <Pressable accessibilityRole="button" onPress={() => { setAdding(s.key); setAddPicked([]); }} style={styles.linkBtn}>
                      <Text style={styles.linkText}>＋ {s.label} 연결</Text>
                    </Pressable>
                  )}
                </View>
              )}
            </View>
          );
        })}

        {/* 팀원: 누르면 팀원 관리 화면 */}
        <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.ProjectTeam, { projectId })} style={[styles.section, styles.sectionHead]}>
          <Text style={styles.sectionTitle}>팀원 {project.members.length}명</Text>
          <Text style={styles.chev}>›</Text>
        </Pressable>

        {!editing && (
          <View style={styles.bottomRow}>
            <Pressable accessibilityRole="button" onPress={() => setEditing(true)} style={[styles.bigBtn, styles.primary]}>
              <Text style={styles.primaryText}>프로젝트 편집</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.ProjectEdit, { projectId })} style={[styles.bigBtn, styles.ghost]}>
              <Text style={styles.ghostText}>정보 수정</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      {/* 편집 모드 아래 바: 취소 / 전체 / 이동 / 편집 / 연결 해제 */}
      {editing && (
        <View style={styles.bar}>
          <Text style={styles.barCount}>{picked.length}개 선택</Text>
          <View style={styles.barRow}>
            <Pressable accessibilityRole="button" onPress={exitEdit} style={styles.barBtn}><Text style={styles.barText}>취소</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => setPicked(picked.length === allKeys.length ? [] : allKeys)} style={styles.barBtn}>
              <Text style={styles.barText}>{picked.length === allKeys.length && allKeys.length > 0 ? '해제' : '전체'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={picked.length === 0 || otherProjects.length === 0} onPress={() => setMoving(true)} style={[styles.barBtn, (picked.length === 0 || otherProjects.length === 0) && styles.off]}>
              <Text style={styles.barText}>이동</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={picked.length !== 1} onPress={editPicked} style={[styles.barBtn, picked.length !== 1 && styles.off]}>
              <Text style={styles.barText}>편집</Text>
            </Pressable>
          </View>
          <View style={styles.barRow}>
            <Pressable accessibilityRole="button" disabled={picked.length === 0} onPress={() => setConfirmUnlink(true)} style={[styles.barBtn, picked.length === 0 && styles.off]}>
              <Text style={styles.barText}>연결 해제</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={picked.length === 0} onPress={() => setConfirmDelete(true)} style={[styles.barBtn, styles.barDanger, picked.length === 0 && styles.off]}>
              <Text style={[styles.barText, { color: colors.white }]}>삭제</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* 연결 추가 창 */}
      <Modal transparent visible={adding !== null} animationType="fade" onRequestClose={() => setAdding(null)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>{sections.find((s) => s.key === adding)?.label} 연결</Text>
            <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: spacing.sm }}>
              {(sections.find((s) => s.key === adding)?.candidates || []).length === 0 && <Text style={styles.none}>연결할 수 있는 항목이 없어요</Text>}
              {(sections.find((s) => s.key === adding)?.candidates || []).map((x) => {
                const on = addPicked.includes(x.id);
                const s = sections.find((q) => q.key === adding);
                const owner = projects.find((p) => p.id !== project.id && p.links[s.kind].includes(x.id));
                return (
                  <Pressable key={x.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => setAddPicked((a) => (a.includes(x.id) ? a.filter((i) => i !== x.id) : [...a, x.id]))} style={[styles.item, on && styles.itemOn]}>
                    <Text style={[styles.check, on && { color: colors.mintDark }]}>{on ? '☑' : '☐'}</Text>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.itemTitle} numberOfLines={1}>{x.title}</Text>
                      <Text style={styles.itemSub} numberOfLines={1}>{x.sub}{owner ? ` · 「${owner.title}」에서 이동` : ''}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
            <View style={styles.dialogRow}>
              <Pressable accessibilityRole="button" onPress={() => setAdding(null)} style={[styles.bigBtn, styles.ghost, { flex: 1 }]}><Text style={styles.ghostText}>취소</Text></Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={addPicked.length === 0}
                onPress={() => {
                  const s = sections.find((q) => q.key === adding);
                  linkItems(project.id, s.kind, addPicked);
                  setAdding(null);
                }}
                style={[styles.bigBtn, styles.primary, { flex: 1 }, addPicked.length === 0 && styles.off]}
              >
                <Text style={styles.primaryText}>연결 {addPicked.length || ''}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 이동할 프로젝트 고르기 */}
      <Modal transparent visible={moving} animationType="fade" onRequestClose={() => setMoving(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>어느 프로젝트로 옮길까요?</Text>
            <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ gap: spacing.sm }}>
              {otherProjects.map((p) => (
                <Pressable
                  key={p.id}
                  accessibilityRole="button"
                  onPress={() => {
                    pickedBySection((s, ids) => linkItems(p.id, s.kind, ids));
                    setMoving(false);
                    exitEdit();
                  }}
                  style={styles.item}
                >
                  <Text style={styles.itemTitle}>{p.title}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable accessibilityRole="button" onPress={() => setMoving(false)} style={[styles.bigBtn, styles.ghost]}><Text style={styles.ghostText}>취소</Text></Pressable>
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={confirmDelete}
        title={`선택한 ${picked.length}개를 삭제할까요?`}
        sub="메모는 휴지통으로 이동하고(복구하면 이 프로젝트로 돌아와요), 할 일·일정·파일은 완전히 삭제돼요."
        confirmText="삭제"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          pickedBySection((s, ids) => {
            if (s.kind === 'memos') trashMemos(ids);
            else if (s.kind === 'tasks') ids.forEach((id) => deleteTask(id));
            else ids.forEach((id) => deleteFile(id));
          });
          setConfirmDelete(false);
          exitEdit();
        }}
      />

      <ConfirmDialog
        visible={confirmUnlink}
        title={`선택한 ${picked.length}개의 연결을 해제할까요?`}
        sub="프로젝트에서만 빠지고, 메모·할 일·파일은 지워지지 않아요."
        confirmText="연결 해제"
        danger
        onCancel={() => setConfirmUnlink(false)}
        onConfirm={() => {
          pickedBySection((s, ids) => unlinkItems(s.kind, ids));
          setConfirmUnlink(false);
          exitEdit();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  gone: { padding: spacing.xl, fontSize: font.bodyLg, color: colors.muted, textAlign: 'center' },
  headIcon: { fontSize: 15, color: colors.mintDark, fontWeight: '800', textAlign: 'right' },
  content: { padding: spacing.lg, gap: spacing.md, paddingBottom: 140 },
  info: { gap: 4 },
  infoLine: { fontSize: font.body, color: colors.muted },
  desc: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  heading: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink, marginTop: spacing.sm },
  section: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: spacing.lg, gap: spacing.sm },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 },
  sectionTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  chev: { fontSize: 18, color: colors.muted },
  none: { fontSize: font.body, color: colors.muted },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.cream, borderWidth: 1, borderColor: colors.line, minHeight: 48 },
  itemOn: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  check: { fontSize: 22, color: colors.muted },
  itemTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  itemSub: { fontSize: font.caption, color: colors.muted },
  linkBtn: { minHeight: 40, borderRadius: radius.md, borderWidth: 1, borderColor: colors.mint, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.mintSoft },
  linkText: { fontSize: font.body, fontWeight: '800', color: colors.mintDark },
  bottomRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  bigBtn: { minHeight: 50, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg },
  primary: { flex: 1, backgroundColor: colors.mintDark },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  ghost: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  off: { opacity: 0.4 },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.line, padding: spacing.md, gap: spacing.sm },
  barCount: { fontSize: font.body, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  barRow: { flexDirection: 'row', gap: spacing.sm },
  barBtn: { flex: 1, minHeight: 44, borderRadius: radius.md, backgroundColor: colors.cream, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  barDanger: { backgroundColor: colors.coral, borderColor: colors.coral, flex: 1.4 },
  barText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  dialogTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  dialogRow: { flexDirection: 'row', gap: spacing.sm },
});
