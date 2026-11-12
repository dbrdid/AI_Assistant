// ============================================================
// TeamScreen.js — 팀원 관리 (스토리보드 71~73장)
// ============================================================
// route.params: { projectId }
// 위: "팀원 N명" + 오른쪽 위 👥＋(팀원 초대)   목록: 이름 / 역할(팀장·팀원)
// [선택]을 누르거나 팀원을 꾹 누르면 선택 모드: 취소 / 전체 / 이동(다른 프로젝트로) / 편집(이름·역할 팝업) / 삭제
// 초대만 해 둔 사람(아직 수락 전)은 아래 "초대 대기" 에 이메일로 보입니다. (실제 발송은 서버 연결 후)

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { getProject, moveMembers, removeMembers, updateMember, useProjects } from '../../../data/projects/ProjectStore';

export default function TeamScreen({ navigation, route }) {
  const projectId = route?.params?.projectId;
  const projects = useProjects();
  const project = getProject(projectId);

  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState([]);
  const [editId, setEditId] = useState(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [moving, setMoving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const [notice, setNotice] = useState('');

  if (!project) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="팀원 관리" onBack={navigation.goBack} />
        <Text style={styles.gone}>프로젝트를 찾을 수 없어요.</Text>
      </View>
    );
  }

  const members = project.members;
  const others = projects.filter((p) => p.id !== project.id);
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const exit = () => {
    setSelecting(false);
    setPicked([]);
    setNotice('');
  };
  const startEdit = () => {
    const m = members.find((x) => x.id === picked[0]);
    if (!m) return;
    setEditId(m.id);
    setName(m.name);
    setRole(m.role);
  };
  // 팀장이 한 명도 안 남게 되는 삭제는 막음
  const wouldRemoveAllLeaders = () => {
    const leaders = members.filter((m) => m.role === '팀장');
    return leaders.length > 0 && leaders.every((m) => picked.includes(m.id));
  };

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="팀원 관리"
        onBack={navigation.goBack}
        right={
          <Pressable accessibilityRole="button" accessibilityLabel="팀원 초대" onPress={() => navigation.navigate(ROUTES.ProjectInvite, { projectId })} hitSlop={10}>
            <Text style={styles.headIcon}>👥＋</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topRow}>
          <Text style={styles.count}>팀원 {members.length}명</Text>
          {!selecting && members.length > 0 && (
            <Pressable accessibilityRole="button" onPress={() => setSelecting(true)} hitSlop={8}>
              <Text style={styles.selectText}>선택</Text>
            </Pressable>
          )}
        </View>

        {members.map((m) => {
          const on = picked.includes(m.id);
          return (
            <Pressable
              key={m.id}
              accessibilityRole={selecting ? 'checkbox' : 'text'}
              accessibilityState={selecting ? { checked: on } : undefined}
              onPress={() => selecting && toggle(m.id)}
              onLongPress={() => {
                setSelecting(true);
                setPicked([m.id]);
              }}
              delayLongPress={350}
              style={[styles.row, on && styles.rowOn]}
            >
              {selecting && <Text style={[styles.check, on && { color: colors.mintDark }]}>{on ? '☑' : '☐'}</Text>}
              <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
              <Text style={[styles.role, m.role === '팀장' && styles.roleLead]}>{m.role}</Text>
            </Pressable>
          );
        })}

        {project.invites.length > 0 && (
          <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
            <Text style={styles.sub}>초대 대기 {project.invites.length}</Text>
            {project.invites.map((i) => (
              <View key={i.id} style={styles.invite}>
                <Text style={styles.inviteText} numberOfLines={1}>{i.email || '링크 초대'}</Text>
                <Text style={styles.inviteMeta}>{i.method}</Text>
              </View>
            ))}
          </View>
        )}

        {!selecting && (
          <Pressable accessibilityRole="button" onPress={navigation.goBack} style={styles.ok}>
            <Text style={styles.okText}>확인</Text>
          </Pressable>
        )}
      </ScrollView>

      {selecting && (
        <View style={styles.bar}>
          <Text style={styles.barCount}>{notice || `${picked.length}명 선택`}</Text>
          <View style={styles.barRow}>
            <Pressable accessibilityRole="button" onPress={exit} style={styles.barBtn}><Text style={styles.barText}>취소</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => setPicked(picked.length === members.length ? [] : members.map((m) => m.id))} style={styles.barBtn}>
              <Text style={styles.barText}>{picked.length === members.length ? '해제' : '전체'}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={picked.length === 0 || others.length === 0} onPress={() => setMoving(true)} style={[styles.barBtn, (picked.length === 0 || others.length === 0) && styles.off]}>
              <Text style={styles.barText}>이동</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={picked.length !== 1} onPress={startEdit} style={[styles.barBtn, picked.length !== 1 && styles.off]}>
              <Text style={styles.barText}>편집</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={picked.length === 0}
              onPress={() => (wouldRemoveAllLeaders() ? setNotice('팀장은 모두 삭제할 수 없어요') : setConfirmDel(true))}
              style={[styles.barBtn, styles.barDanger, picked.length === 0 && styles.off]}
            >
              <Text style={[styles.barText, { color: colors.white }]}>삭제</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* 이름·역할 수정 팝업 */}
      <Modal transparent visible={editId !== null} animationType="fade" onRequestClose={() => setEditId(null)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>팀원 수정</Text>
            <Text style={styles.label}>이름</Text>
            <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="이름" placeholderTextColor={colors.muted} accessibilityLabel="이름" maxLength={20} />
            <Text style={styles.label}>역할</Text>
            <View style={styles.chipRow}>
              {['팀장', '팀원'].map((r) => (
                <Pressable key={r} accessibilityRole="button" accessibilityState={{ selected: role === r }} onPress={() => setRole(r)} style={[styles.chip, role === r && styles.chipOn]}>
                  <Text style={[styles.chipText, role === r && { color: colors.white, fontWeight: '800' }]}>{r}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput style={styles.input} value={role} onChangeText={setRole} placeholder="직접 입력 (예: 디자이너)" placeholderTextColor={colors.muted} accessibilityLabel="역할 직접 입력" maxLength={12} />
            <View style={styles.dialogRow}>
              <Pressable accessibilityRole="button" onPress={() => setEditId(null)} style={[styles.dBtn, styles.ghost]}><Text style={styles.barText}>취소</Text></Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!name.trim() || !role.trim()}
                onPress={() => {
                  updateMember(project.id, editId, { name: name.trim(), role: role.trim() });
                  setEditId(null);
                  exit();
                }}
                style={[styles.dBtn, { backgroundColor: colors.mintDark }, (!name.trim() || !role.trim()) && styles.off]}
              >
                <Text style={[styles.barText, { color: colors.white }]}>수정</Text>
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
            {others.map((p) => (
              <Pressable key={p.id} accessibilityRole="button" onPress={() => { moveMembers(project.id, p.id, picked); setMoving(false); exit(); }} style={styles.row}>
                <Text style={styles.name}>{p.title}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setMoving(false)} style={[styles.dBtn, styles.ghost]}><Text style={styles.barText}>취소</Text></Pressable>
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={confirmDel}
        title={`선택한 ${picked.length}명을 삭제할까요?`}
        sub="이 프로젝트에서 팀원이 빠져요."
        confirmText="삭제"
        danger
        onCancel={() => setConfirmDel(false)}
        onConfirm={() => {
          removeMembers(project.id, picked);
          setConfirmDel(false);
          exit();
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
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  count: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  selectText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, minHeight: 56 },
  rowOn: { borderColor: colors.mint, backgroundColor: colors.mintSoft },
  check: { fontSize: 22, color: colors.muted },
  name: { flex: 1, fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  role: { fontSize: font.body, color: colors.muted, fontWeight: '600' },
  roleLead: { color: colors.mintDark, fontWeight: '800' },
  sub: { fontSize: font.body, fontWeight: '700', color: colors.muted },
  invite: { flexDirection: 'row', justifyContent: 'space-between', padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, borderStyle: 'dashed' },
  inviteText: { flex: 1, fontSize: font.body, color: colors.ink },
  inviteMeta: { fontSize: font.caption, color: colors.muted },
  ok: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  okText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.white, borderTopWidth: 1, borderTopColor: colors.line, padding: spacing.md, gap: spacing.sm },
  barCount: { fontSize: font.body, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  barRow: { flexDirection: 'row', gap: spacing.sm },
  barBtn: { flex: 1, minHeight: 44, borderRadius: radius.md, backgroundColor: colors.cream, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  barDanger: { backgroundColor: colors.coral, borderColor: colors.coral },
  barText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  off: { opacity: 0.4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.lg, gap: spacing.md },
  dialogTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  label: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  input: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: spacing.lg, fontSize: font.bodyLg, color: colors.ink },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  chip: { minHeight: 38, paddingHorizontal: spacing.lg, borderRadius: 19, justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.body, fontWeight: '600', color: colors.ink },
  dialogRow: { flexDirection: 'row', gap: spacing.sm },
  dBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  ghost: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
});
