// ============================================================
// WorkspaceScreen.js — 공간 전환 (스토리보드 39장)
// ============================================================
// 1) 지금 보고 있는 공간(개인 공간)과 "현재" 표시
// 2) 내가 속한 조직 워크스페이스 목록 (이름 · 멤버 수 · 내 역할)
// 3) "＋ 새 워크스페이스 만들기"
// 4) 오른쪽 위 아이콘 → 파일 보관함
// 공간을 누르면 그 공간의 데이터(메모·할 일·프로젝트·파일)로 바뀝니다.
// 조직 공간을 꾹 누르면 삭제(관리자) / 나가기(멤버) — 확인 창을 거쳐요. 개인 공간은 삭제할 수 없어요.

import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { deleteWorkspace, switchWorkspace, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';

export default function WorkspaceScreen({ navigation }) {
  const menuSwipe = useSwipeToOpenMenu();
  const { list, current } = useWorkspaces();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [delId, setDelId] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const showNotice = (t) => {
    setNotice(t);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(''), 2200);
  };

  const pick = async (w) => {
    if (busy || w.id === current.id) return;
    setBusy(true);
    await switchWorkspace(w.id);
    setBusy(false);
    showNotice(`「${w.name}」로 전환했어요`);
  };

  const target = list.find((w) => w.id === delId);

  return (
    <View style={styles.root} {...menuSwipe}>
      <ScreenHeader
        title="공간 전환"
        onBack={navigation.goBack}
        right={
          <Pressable accessibilityRole="button" accessibilityLabel="파일 보관함" onPress={() => navigation.navigate(ROUTES.Files)} hitSlop={10}>
            <Text style={styles.headIcon}>📎</Text>
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable accessibilityRole="button" onPress={() => navigation.navigate(ROUTES.WorkspaceCreate)} style={styles.add}>
          <Text style={styles.addText}>＋ 새 워크스페이스 만들기</Text>
        </Pressable>

        {list.map((w) => {
          const on = w.id === current.id;
          return (
            <Pressable
              key={w.id}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${w.name}${on ? ', 현재 공간' : ''}`}
              onPress={() => pick(w)}
              onLongPress={() => !w.personal && setDelId(w.id)}
              delayLongPress={450}
              style={[styles.card, on && styles.cardOn]}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.name} numberOfLines={1}>{w.name}</Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {w.personal ? w.desc : `멤버 ${w.members}명 · ${w.role}`}
                </Text>
                {!w.personal && !!w.desc && <Text style={styles.desc} numberOfLines={2}>{w.desc}</Text>}
              </View>
              {on && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>현재</Text>
                </View>
              )}
            </Pressable>
          );
        })}

        <Text style={styles.hint}>
          공간을 바꾸면 그 공간의 메모·할 일·프로젝트·파일이 보여요. 개인 공간의 기록은 다른 팀원에게 보이지 않아요.
          {list.length > 1 ? ' 조직 공간을 꾹 누르면 삭제하거나 나갈 수 있어요.' : ''}
        </Text>

        {/* 서버가 연결되기 전 미리보기용 (나중에 지울 것) */}
        <View style={styles.previewBox}>
          <Text style={styles.previewTitle}>초대 화면 미리보기 (임시)</Text>
          <View style={styles.previewRow}>
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate(ROUTES.WorkspaceInvite, { name: '팀 프로젝트 회의', inviter: '홍길동', role: '멤버', members: 6, status: 'valid' })}
              style={styles.previewBtn}
            >
              <Text style={styles.previewText}>수락 화면</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => navigation.navigate(ROUTES.WorkspaceInvite, { name: '팀 프로젝트 회의', inviter: '홍길동', role: '멤버', members: 6, status: 'expired' })}
              style={styles.previewBtn}
            >
              <Text style={styles.previewText}>만료 화면</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>

      {!!notice && (
        <View pointerEvents="none" style={styles.notice}>
          <Text style={styles.noticeText}>{notice}</Text>
        </View>
      )}

      <ConfirmDialog
        visible={!!target}
        title={target?.role === '관리자' ? '워크스페이스를 삭제할까요?' : '워크스페이스에서 나갈까요?'}
        sub={
          target?.role === '관리자'
            ? `「${target?.name}」의 메모·할 일·프로젝트·파일이 모두 삭제되고 되돌릴 수 없어요.`
            : `「${target?.name}」 공간이 목록에서 사라져요.`
        }
        confirmText={target?.role === '관리자' ? '삭제' : '나가기'}
        danger
        onCancel={() => setDelId(null)}
        onConfirm={async () => {
          const id = delId;
          setDelId(null);
          await deleteWorkspace(id);
          showNotice('처리했어요');
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  headIcon: { fontSize: 20 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  add: { minHeight: 50, borderRadius: 25, borderWidth: 1, borderColor: colors.mint, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center' },
  addText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.mintDark },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.lg, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, minHeight: 64 },
  cardOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  name: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  sub: { fontSize: font.body, color: colors.muted },
  desc: { fontSize: font.caption, color: colors.muted },
  badge: { paddingHorizontal: spacing.md, minHeight: 28, borderRadius: 14, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: font.caption, fontWeight: '800', color: colors.white },
  hint: { fontSize: font.caption, color: colors.muted, lineHeight: 18, marginTop: spacing.sm },
  previewBox: { marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, gap: spacing.sm },
  previewTitle: { fontSize: font.caption, color: colors.muted },
  previewRow: { flexDirection: 'row', gap: spacing.sm },
  previewBtn: { flex: 1, minHeight: 40, borderRadius: radius.sm, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  previewText: { fontSize: font.body, color: colors.ink, fontWeight: '600' },
  notice: { position: 'absolute', left: spacing.xl, right: spacing.xl, bottom: spacing.xl, backgroundColor: colors.ink, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  noticeText: { color: colors.white, fontSize: font.body },
});
