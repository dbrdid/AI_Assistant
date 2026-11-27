// ============================================================
// TeamScreen.js — 팀원 관리
// ============================================================

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Icon from '../../../shared/components/Icon';
import { Chip, CircleButton, InlineDeletePrompt, Tag } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import {
  GROUP_ACCESS, deleteGroup, getProject, moveMembers, removeMembers, saveGroup, setGroupMember, updateMember, useProjects,
} from '../../../data/projects/ProjectStore';

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
  const [notice, setNotice] = useState('');
  // 그룹 창 (색 없이 이름·인원으로 구분): null(닫힘) · { id: null } 새 그룹 · { id } 기존 그룹
  const [groupEdit, setGroupEdit] = useState(null);
  const [groupName, setGroupName] = useState('');
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupError, setGroupError] = useState('');
  const [confirmGroupDel, setConfirmGroupDel] = useState(false);

  if (!project) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="팀원 관리" onBack={navigation.goBack} />
        <Text style={styles.gone}>프로젝트를 찾을 수 없어요.</Text>
      </View>
    );
  }

  const members = project.members;
  const groups = project.groups ?? [];
  const editingGroup = groupEdit?.id ? groups.find((g) => g.id === groupEdit.id) : null;
  const openGroup = (g) => {
    setGroupEdit({ id: g?.id ?? null });
    setGroupName(g?.name ?? '');
    setGroupError('');
  };
  // 서버에 바로 저장 (서버가 권한 확인). 실패하면 창 안에 이유를 보여 줌
  const runGroup = async (fn) => {
    setGroupBusy(true); setGroupError('');
    try { return (await fn()) ?? true; } catch (e) { setGroupError(e?.message ?? '저장하지 못했어요'); return null; } finally { setGroupBusy(false); }
  };
  const accessOf = (memberId) => editingGroup?.members.find((x) => x.memberId === memberId)?.access ?? null;
  const others = projects.filter((p) => p.id !== project.id);
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const exit = () => {
    setSelecting(false);
    setPicked([]);
    setNotice('');
  };
  const startEdit = (m) => {
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
        right={<CircleButton icon="userPlus" label="팀원 초대" onPress={() => navigation.navigate(ROUTES.ProjectInvite, { projectId })} />}
      />
      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
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
              accessibilityRole={selecting ? 'checkbox' : 'button'}
              accessibilityState={selecting ? { checked: on } : undefined}
              onPress={() => selecting ? toggle(m.id) : startEdit(m)}
              onLongPress={() => {
                setSelecting(true);
                setPicked([m.id]);
              }}
              delayLongPress={350}
              style={[styles.row, on && styles.rowOn]}
            >
              {selecting && <Icon name={on ? 'checkSquare' : 'square'} size={22} color={on ? colors.ink : colors.muted} />}
              <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
              <Tag label={m.role} tone={m.role === '팀장' ? 'mint' : 'outline'} style={styles.roleTag} />
            </Pressable>
          );
        })}

        {project.invites.length > 0 && (
          <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
            <Text style={styles.sub}>초대 대기 {project.invites.length}</Text>
            {project.invites.map((i) => (
              <View key={i.id} style={styles.invite}>
                <Icon name={i.email ? 'mail' : 'globe'} size={16} color={colors.muted} />
                <Text style={styles.inviteText} numberOfLines={1}>{i.email || '링크 초대'}</Text>
                <Text style={styles.inviteMeta}>{i.method}</Text>
              </View>
            ))}
          </View>
        )}

        {/* 그룹: 그룹별로 볼 수 있는 문서·할 일과 권한(보기·편집·관리)을 나눔 */}
        {!selecting && (
          <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
            <View style={styles.topRow}>
              <Text style={styles.count}>그룹 {groups.length}개</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="그룹 추가" onPress={() => openGroup(null)} hitSlop={8}>
                <Text style={styles.selectText}>+ 그룹</Text>
              </Pressable>
            </View>
            {groups.map((g) => (
              <Pressable key={g.id} accessibilityRole="button" accessibilityLabel={`${g.name} 그룹, ${g.members.length}명`} onPress={() => openGroup(g)} style={styles.row}>
                <Icon name="users" size={18} color={colors.muted} />
                <Text style={styles.name} numberOfLines={1}>{g.name}</Text>
                <Text style={styles.inviteMeta}>{g.members.length}명</Text>
                <Icon name="chevronRight" size={18} color={colors.muted} />
              </Pressable>
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
          </View>
          {picked.length > 0 && <InlineDeletePrompt
            question={`선택한 ${picked.length}명을 삭제할까요?`}
            hint="이 프로젝트에서 팀원이 빠져요."
            onDelete={() => {
              if (wouldRemoveAllLeaders()) { setNotice('팀장은 모두 삭제할 수 없어요'); return; }
              try { removeMembers(project.id, picked); exit(); }
              catch (error) { setNotice(error.message || '팀원을 삭제하지 못했어요.'); }
            }}
          />}
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
                <Chip key={r} label={r} active={role === r} onPress={() => setRole(r)} />
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
                style={[styles.dBtn, { backgroundColor: colors.action }, (!name.trim() || !role.trim()) && styles.off]}
              >
                <Text style={[styles.barText, { color: colors.onPrimary }]}>수정</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 이동할 프로젝트 고르기 */}
      <Modal transparent visible={moving} animationType="fade" onRequestClose={() => setMoving(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>옮길 프로젝트</Text>
            {others.map((p) => (
              <Pressable key={p.id} accessibilityRole="button" onPress={() => { moveMembers(project.id, p.id, picked); setMoving(false); exit(); }} style={styles.row}>
                <Text style={styles.name}>{p.title}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setMoving(false)} style={[styles.dBtn, styles.ghost]}><Text style={styles.barText}>취소</Text></Pressable>
          </View>
        </View>
      </Modal>

      {/* 그룹 만들기·고치기: 이름·색은 저장 버튼으로, 멤버 권한은 고르면 바로 저장 */}
      <Modal transparent visible={groupEdit !== null && !confirmGroupDel} animationType="fade" onRequestClose={() => setGroupEdit(null)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>{groupEdit?.id ? '그룹' : '새 그룹'}</Text>
            <TextInput style={styles.input} value={groupName} onChangeText={setGroupName} placeholder="그룹 이름 (예: 디자인팀)" placeholderTextColor={colors.muted} accessibilityLabel="그룹 이름" maxLength={20} />
            {editingGroup && (
              <ScrollView style={{ maxHeight: 280 }} contentContainerStyle={{ gap: spacing.sm }}>
                {members.map((m) => {
                  const access = accessOf(m.id);
                  return (
                    <View key={m.id} style={{ gap: 6 }}>
                      <Text style={styles.label} numberOfLines={1}>{m.name}{m.accountId ? '' : ' (계정 없음)'}</Text>
                      <View style={styles.chipRow}>
                        {[[null, '없음'], ...GROUP_ACCESS].map(([key, label]) => (
                          <Chip key={label} label={label} active={access === key}
                            onPress={() => !groupBusy && access !== key && runGroup(() => setGroupMember(editingGroup.id, m.id, key))} />
                        ))}
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
            )}
            {!!groupError && <Text style={[styles.sub, { color: colors.coral }]}>{groupError}</Text>}
            <View style={styles.dialogRow}>
              {editingGroup && (
                <Pressable accessibilityRole="button" onPress={() => setConfirmGroupDel(true)} style={[styles.dBtn, styles.ghost]}>
                  <Text style={[styles.barText, { color: colors.coral }]}>삭제</Text>
                </Pressable>
              )}
              <Pressable accessibilityRole="button" onPress={() => setGroupEdit(null)} style={[styles.dBtn, styles.ghost]}><Text style={styles.barText}>닫기</Text></Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={groupBusy || !groupName.trim()}
                onPress={async () => {
                  const saved = await runGroup(() => saveGroup(project.id, { id: groupEdit?.id ?? null, name: groupName.trim() }));
                  if (saved && !groupEdit?.id) setGroupEdit({ id: saved.id });   // 새 그룹이면 이어서 멤버를 고르게
                }}
                style={[styles.dBtn, { backgroundColor: colors.action }, (groupBusy || !groupName.trim()) && styles.off]}
              >
                <Text style={[styles.barText, { color: colors.onPrimary }]}>{groupBusy ? '저장 중' : '저장'}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <ConfirmDialog
        visible={confirmGroupDel}
        title={`'${editingGroup?.name ?? ''}' 그룹을 삭제할까요?`}
        sub="이 그룹에만 공개한 문서와 할 일은 다시 프로젝트 모두에게 보여요."
        confirmText="삭제"
        danger
        onCancel={() => setConfirmGroupDel(false)}
        onConfirm={async () => {
          const id = editingGroup?.id;
          setConfirmGroupDel(false);
          if (id && (await runGroup(() => deleteGroup(id))) !== null) setGroupEdit(null);
        }}
      />

    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  gone: { padding: spacing.xl, fontSize: font.bodyLg, color: colors.muted, textAlign: 'center' },
  content: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, gap: spacing.md, paddingBottom: 140 },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  count: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  selectText: { fontSize: font.body, fontWeight: '500', color: colors.mintDark },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: 4, borderWidth: 1, borderColor: 'transparent', minHeight: 56 },
  rowOn: { borderColor: '#fff' },
  name: { flex: 1, fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  roleTag: { alignSelf: 'center' },
  sub: { fontSize: font.body, fontWeight: '500', color: colors.muted },
  invite: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, borderStyle: 'dashed', backgroundColor: colors.card },
  inviteText: { flex: 1, fontSize: font.body, color: colors.ink },
  inviteMeta: { fontSize: font.caption, color: colors.muted },
  ok: { minHeight: 52, borderRadius: radius.card, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  okText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.cream, borderTopWidth: 1, borderTopColor: colors.line, paddingHorizontal: 16, paddingTop: 6, paddingBottom: spacing.md, gap: 2 },
  barCount: { fontSize: 13, color: colors.muted, textAlign: 'center', paddingTop: 4 },
  barRow: { flexDirection: 'row', gap: 4 },
  barBtn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  barText: { fontSize: 15, fontWeight: '500', color: colors.ink },
  off: { opacity: 0.4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.card, padding: spacing.lg, gap: spacing.md },
  dialogTitle: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  label: { fontSize: font.body, fontWeight: '500', color: colors.ink },
  input: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, paddingHorizontal: spacing.lg, fontSize: font.bodyLg, color: colors.ink },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  dialogRow: { flexDirection: 'row', gap: spacing.sm },
  dBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  ghost: { backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line },
});
