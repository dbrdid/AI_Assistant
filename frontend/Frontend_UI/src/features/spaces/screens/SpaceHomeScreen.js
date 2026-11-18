// ============================================================
// SpaceHomeScreen.js — 공간 하나의 홈 (노션의 팀스페이스처럼)
// ============================================================
// 위에서부터: 멤버 · 초대 / 회의 안건 · 파일 · AI에게 묻기 / 진행 중 프로젝트 / 다가오는 일정·할 일 / 최근 메모
// 들어오면 이 공간을 "현재 공간"으로 바꿔서, 프로젝트·파일·안건처럼 공간별 화면이 이 공간 것을 보여 줍니다.

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import Icon from '../../../shared/components/Icon';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { deleteWorkspace, enterSpace, listMembers, useSpaceInfo, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { lastDate, shiftKey, shortDate, taskIn, useAllTasks } from '../../../data/tasks/TaskStore';
import { memoTitle, useAllMemos } from '../../../data/memos/MemoStore';
import { useProjects } from '../../../data/projects/ProjectStore';
import { createInvite, inviteUrl } from '../../../lib/stella/workspaces';
import { toKey } from '../../calendar/utils/DateUtils';
import { SpaceTile } from './SpacesScreen';

const ROLE = { OWNER: '관리자', EDITOR: '멤버', VIEWER: '보기 전용' };
const AVATAR_BG = ['#E1F5EE', '#EEEDFE', '#FAEEDA', '#E6F1FB', '#FBEAF0'];
const AVATAR_FG = ['#085041', '#3C3489', '#633806', '#0C447C', '#72243E'];

function Avatar({ name, i, size = 30 }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: AVATAR_BG[i % 5], marginLeft: i ? -8 : 0 }]}>
      <Text style={[styles.avatarText, { color: AVATAR_FG[i % 5] }]}>{(name || '?').trim().charAt(0)}</Text>
    </View>
  );
}

function Section({ title, onAdd, addLabel, children }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle} accessibilityRole="header">{title}</Text>
        {onAdd && (
          <Pressable accessibilityRole="button" accessibilityLabel={addLabel} onPress={onAdd} hitSlop={8} style={styles.addLink}>
            <Icon name="plus" size={14} color={colors.mintDark} strokeWidth={2.4} />
            <Text style={styles.addLinkText}>추가</Text>
          </Pressable>
        )}
      </View>
      {children}
    </View>
  );
}

export default function SpaceHomeScreen({ navigation, route }) {
  const id = route?.params?.workspaceId;
  const { list, current } = useWorkspaces();
  const ws = list.find((w) => w.id === id);
  const space = useSpaceInfo()[id];

  // 이 공간을 현재 공간으로 (프로젝트·파일·안건 화면이 이 공간 것을 보여 주도록)
  useEffect(() => {
    if (ws) enterSpace(id);
  }, [id, ws]); // eslint-disable-line react-hooks/exhaustive-deps
  const ready = current.id === id;
  const projects = useProjects();

  // ---------- 멤버 (팀 공간만, 서버에서 받아 옴) ----------
  const [members, setMembers] = useState({ list: [], loading: false, error: '' });
  useEffect(() => {
    if (!ws || ws.personal || !ws.serverId) return undefined;
    let alive = true;
    setMembers((m) => ({ ...m, loading: true, error: '' }));
    listMembers(ws.serverId)
      .then((r) => alive && setMembers({ list: r, loading: false, error: '' }))
      .catch(() => alive && setMembers({ list: [], loading: false, error: '멤버 목록을 불러오지 못했어요' }));
    return () => { alive = false; };
  }, [ws?.serverId, ws?.personal]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 초대 (관리자만) ----------
  const [invite, setInvite] = useState(null); // { code, url } | { error } | 'loading'
  const makeInvite = async () => {
    setInvite('loading');
    try {
      const r = await createInvite(ws.serverId);
      setInvite({ code: r.code, url: inviteUrl(r.code) });
    } catch (e) {
      setInvite({ error: e.message || '초대 코드를 만들지 못했어요' });
    }
  };
  const shareInvite = () =>
    Share.share({ message: `「${ws.name}」 공간에 초대합니다.\n앱의 [공간 → 초대 코드로 참여]에 코드를 입력해 주세요.\n코드: ${invite.code}\n${invite.url}` }).catch(() => {});

  // ---------- 공간 삭제 (관리자) · 나가기 (멤버) ----------
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const remove = async () => {
    setConfirmRemove(false);
    setRemoving(true);
    setRemoveError('');
    try {
      await deleteWorkspace(id); // 서버에서 삭제(관리자) 또는 나가기(멤버) 뒤 기기에서도 지움
      navigation.goBack();
    } catch (e) {
      setRemoveError(e.message || '처리하지 못했어요. 잠시 후 다시 시도해 주세요');
      setRemoving(false);
    }
  };

  // ---------- 이 공간의 기록 ----------
  const today = toKey(new Date());
  const weekEnd = shiftKey(today, 7);
  const tasks = useAllTasks().filter((t) => t.workspaceId === id);
  const upcoming = tasks
    .filter((t) => t.status !== '완료' && t.date <= weekEnd)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start || '').localeCompare(b.start || ''))
    .slice(0, 6);
  const memos = useAllMemos()
    .filter((m) => m.workspaceId === id)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const activeProjects = ready ? projects.filter((p) => p.status !== '완료') : [];
  const progressOf = (p) => {
    const linked = tasks.filter((t) => p.links.tasks.includes(t.id));
    return { done: linked.filter((t) => t.status === '완료').length, total: linked.length };
  };

  if (!ws) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="공간" onBack={navigation.goBack} />
        <Text style={styles.empty}>이 공간을 찾을 수 없어요. 나갔거나 삭제된 공간일 수 있어요.</Text>
      </View>
    );
  }

  const owner = ws.roleCode === 'OWNER';
  const canInvite = !ws.personal && owner && !!ws.serverId;
  const go = (route, params) => navigation.navigate(route, params);

  return (
    <View style={styles.root}>
      <ScreenHeader title={ws.name} onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        {/* ---------- 공간 소개 + 멤버 ---------- */}
        <View style={styles.hero}>
          <SpaceTile space={space} size={48} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.heroSub}>{ws.personal ? '나만 보는 공간 · 이 기기에만 저장돼요' : `${ws.role} · 멤버 ${ws.members}명`}</Text>
            {!!ws.desc && <Text style={styles.desc} numberOfLines={2}>{ws.desc}</Text>}
          </View>
        </View>
        {!ws.personal && (
          <View style={styles.membersRow}>
            {members.loading ? (
              <ActivityIndicator color={colors.mintDark} />
            ) : members.error ? (
              <Text style={styles.muted}>{members.error}</Text>
            ) : (
              <View style={styles.avatars} accessibilityLabel={`멤버 ${members.list.map((m) => m.display_name || '이름 없음').join(', ')}`}>
                {members.list.slice(0, 5).map((m, i) => <Avatar key={m.account_id} name={m.display_name} i={i} />)}
                {members.list.length > 5 && <Text style={styles.more}>+{members.list.length - 5}</Text>}
              </View>
            )}
            <View style={{ flex: 1 }} />
            {canInvite && (
              <Pressable accessibilityRole="button" onPress={makeInvite} style={({ pressed }) => [styles.inviteBtn, pressed && { opacity: 0.7 }]}>
                <Icon name="userPlus" size={16} color={colors.white} />
                <Text style={styles.inviteText}>초대</Text>
              </Pressable>
            )}
          </View>
        )}
        {!ws.personal && members.list.length > 0 && (
          <Text style={styles.muted} numberOfLines={2}>
            {members.list.map((m) => `${m.display_name || '이름 없음'}${m.role === 'OWNER' ? '(관리자)' : m.role === 'VIEWER' ? '(보기 전용)' : ''}`).join(' · ')}
          </Text>
        )}

        {/* ---------- 바로 가기 ---------- */}
        <View style={styles.quick}>
          {[
            { icon: 'compare', label: '회의 안건', route: ROUTES.AgendaCompare },
            { icon: 'paperclip', label: '파일', route: ROUTES.Files },
            { icon: 'sparkles', label: 'AI에게 묻기', route: ROUTES.Ai },
          ].map((q) => (
            <Pressable key={q.label} accessibilityRole="button" onPress={() => go(q.route)} style={({ pressed }) => [styles.quickBtn, pressed && { backgroundColor: colors.mintSoft }]}>
              <Icon name={q.icon} size={18} color={colors.mintDark} />
              <Text style={styles.quickText}>{q.label}</Text>
            </Pressable>
          ))}
        </View>

        {/* ---------- 진행 중 프로젝트 ---------- */}
        <Section title={`진행 중 프로젝트${activeProjects.length ? ` ${activeProjects.length}` : ''}`} addLabel="프로젝트 추가" onAdd={ready ? () => go(ROUTES.ProjectEdit) : null}>
          {!ready ? (
            <ActivityIndicator color={colors.mintDark} />
          ) : activeProjects.length === 0 ? (
            <Text style={styles.empty}>진행 중인 프로젝트가 없어요</Text>
          ) : (
            activeProjects.map((p) => {
              const pr = progressOf(p);
              const pct = pr.total ? Math.round((pr.done / pr.total) * 100) : 0;
              return (
                <Pressable key={p.id} accessibilityRole="button" onPress={() => go(ROUTES.ProjectDetail, { projectId: p.id })} style={styles.card}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.cardTitle} numberOfLines={1}>{p.title || '(제목 없음)'}</Text>
                    {!!p.due && <Text style={styles.muted}>{shortDate(p.due)} 마감</Text>}
                  </View>
                  <View style={styles.track}><View style={[styles.fill, { width: `${pct}%`, backgroundColor: space.color }]} /></View>
                  <Text style={styles.muted}>{pr.total ? `할 일 ${pr.total}개 중 ${pr.done}개 완료` : '연결된 할 일 없음'}{p.members.length ? ` · 팀원 ${p.members.length}명` : ''}</Text>
                </Pressable>
              );
            })
          )}
        </Section>

        {/* ---------- 다가오는 일정 · 할 일 (일주일 안 + 기한 지남) ---------- */}
        <Section title="다가오는 일정 · 할 일" addLabel="일정 · 할 일 추가" onAdd={() => go(ROUTES.TaskEdit, { date: today, kind: 'task', workspaceId: id })}>
          {upcoming.length === 0 ? (
            <Text style={styles.empty}>일주일 안에 할 일이 없어요</Text>
          ) : (
            upcoming.map((t) => {
              const late = lastDate(t) < today;
              return (
                <View key={t.id} style={styles.itemRow}>
                  {t.kind !== 'event' ? (
                    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: false }} accessibilityLabel={`${t.title} 완료 표시`} onPress={() => taskIn(t, 'toggleDone', t.id)} hitSlop={8}>
                      <Icon name="square" size={20} color={colors.muted} />
                    </Pressable>
                  ) : (
                    <Icon name="calendar" size={18} color={space.color} />
                  )}
                  <Pressable accessibilityRole="button" onPress={() => go(ROUTES.TaskEdit, { taskId: t.id })} style={styles.itemBody}>
                    <Text style={styles.itemTitle} numberOfLines={1}>{t.title}</Text>
                    <Text style={[styles.when, late && { color: colors.coral }]}>
                      {t.date === today ? '오늘' : shortDate(t)}{t.start ? ` ${t.start}` : ''}{t.assignee ? ` · ${t.assignee}` : ''}
                    </Text>
                  </Pressable>
                </View>
              );
            })
          )}
        </Section>

        {/* ---------- 최근 메모 ---------- */}
        <Section title={ws.personal ? '최근 메모' : '공유 메모'} addLabel="메모 추가" onAdd={() => go(ROUTES.MemoEdit)}>
          {memos.length === 0 ? (
            <Text style={styles.empty}>아직 메모가 없어요</Text>
          ) : (
            memos.slice(0, 4).map((m) => (
              <Pressable key={m.id} accessibilityRole="button" onPress={() => go(ROUTES.MemoEdit, { memoId: m.id })} style={styles.itemRow}>
                <Icon name="file" size={18} color={colors.muted} />
                <Text style={[styles.itemTitle, { flex: 1 }]} numberOfLines={1}>{memoTitle(m)}</Text>
                <Text style={styles.muted}>{new Date(m.updatedAt).getMonth() + 1}/{new Date(m.updatedAt).getDate()}</Text>
              </Pressable>
            ))
          )}
          {memos.length > 4 && (
            <Pressable accessibilityRole="button" onPress={() => go(ROUTES.Memos, { space: id })} hitSlop={8} style={styles.addLink}>
              <Text style={styles.addLinkText}>메모 {memos.length}개 모두 보기</Text>
              <Icon name="chevronRight" size={14} color={colors.mintDark} />
            </Pressable>
          )}
        </Section>

        {/* ---------- 공간 삭제 · 나가기 (팀 공간만) ---------- */}
        {!ws.personal && (
          <View style={styles.danger}>
            {!!removeError && <Text style={styles.dangerError} accessibilityLiveRegion="polite">{removeError}</Text>}
            <Pressable
              accessibilityRole="button"
              disabled={removing}
              onPress={() => setConfirmRemove(true)}
              style={({ pressed }) => [styles.dangerBtn, (pressed || removing) && { opacity: 0.6 }]}
            >
              {removing ? <ActivityIndicator color={colors.coral} /> : <Icon name={owner ? 'trash' : 'logout'} size={18} color={colors.coral} />}
              <Text style={styles.dangerText}>{owner ? '공간 삭제' : '공간에서 나가기'}</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>

      <ConfirmDialog
        visible={confirmRemove}
        title={owner ? `「${ws.name}」 공간을 삭제할까요?` : `「${ws.name}」에서 나갈까요?`}
        sub={
          owner
            ? `멤버 ${ws.members}명 모두에게서 이 공간의 메모·일정·할 일·프로젝트·파일이 삭제되고 되돌릴 수 없어요.`
            : '공간과 기록은 다른 멤버에게 그대로 남아요. 이 기기에서는 지워지고, 다시 들어오려면 관리자의 새 초대가 필요해요.'
        }
        confirmText={owner ? '삭제' : '나가기'}
        danger
        onCancel={() => setConfirmRemove(false)}
        onConfirm={remove}
      />

      {/* ---------- 초대 코드 창 ---------- */}
      <Modal transparent visible={!!invite} animationType="fade" onRequestClose={() => setInvite(null)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>「{ws.name}」 초대</Text>
            {invite === 'loading' ? (
              <ActivityIndicator color={colors.mintDark} />
            ) : invite?.error ? (
              <Text style={[styles.muted, { color: colors.coral }]}>{invite.error}</Text>
            ) : invite ? (
              <>
                <Text style={styles.code} selectable accessibilityLabel={`초대 코드 ${invite.code}`}>{invite.code}</Text>
                <Text style={styles.muted}>7일 동안 한 명이 쓸 수 있는 코드예요. 받는 사람은 [공간 → 초대 코드로 참여]에 입력하면 돼요. 이 코드는 다시 볼 수 없어요.</Text>
                <Pressable accessibilityRole="button" onPress={shareInvite} style={styles.primary}>
                  <Text style={styles.primaryText}>코드 공유하기</Text>
                </Pressable>
              </>
            ) : null}
            <Pressable accessibilityRole="button" onPress={() => setInvite(null)} style={styles.ghost}>
              <Text style={styles.ghostText}>닫기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  danger: { gap: spacing.sm, marginTop: spacing.lg, paddingTop: spacing.lg, borderTopWidth: 1, borderTopColor: colors.line },
  dangerBtn: { flexDirection: 'row', gap: 6, minHeight: 48, borderRadius: radius.card, borderWidth: 1, borderColor: colors.coral, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  dangerText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.coral },
  dangerError: { fontSize: font.body, fontWeight: '700', color: colors.coral, textAlign: 'center' },
  hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  heroSub: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  desc: { fontSize: font.caption, color: colors.muted },
  membersRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: -spacing.sm },
  avatars: { flexDirection: 'row', alignItems: 'center' },
  avatar: { alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.cream },
  avatarText: { fontSize: 12, fontWeight: '800' },
  more: { marginLeft: 6, fontSize: font.caption, fontWeight: '700', color: colors.muted },
  inviteBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 34, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.mintDark },
  inviteText: { fontSize: font.body, fontWeight: '800', color: colors.white },
  quick: { flexDirection: 'row', gap: spacing.sm },
  quickBtn: { flex: 1, minHeight: 64, gap: 4, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  quickText: { fontSize: font.caption, fontWeight: '800', color: colors.ink },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { fontSize: font.body, fontWeight: '800', color: colors.muted },
  addLink: { flexDirection: 'row', alignItems: 'center', gap: 2, minHeight: 28, alignSelf: 'flex-start' },
  addLinkText: { fontSize: font.caption, fontWeight: '800', color: colors.mintDark },
  empty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.xs, paddingHorizontal: spacing.lg },
  card: { gap: 6, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  cardTitle: { flex: 1, fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.mintSoft, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  muted: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 50, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  itemBody: { flex: 1, minHeight: 44, justifyContent: 'center', gap: 2 },
  itemTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  when: { fontSize: font.caption, color: colors.muted },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.4)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 400, gap: spacing.md, padding: spacing.xl, borderRadius: radius.card, backgroundColor: colors.cream },
  dialogTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  code: { fontSize: 28, fontWeight: '800', letterSpacing: 2, color: colors.mintDark, textAlign: 'center', paddingVertical: spacing.sm },
  primary: { minHeight: 48, borderRadius: radius.card, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  ghost: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.body, fontWeight: '700', color: colors.muted },
});
