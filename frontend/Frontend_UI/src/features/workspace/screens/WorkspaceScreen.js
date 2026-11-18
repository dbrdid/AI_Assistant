// ============================================================
// WorkspaceScreen.js — 워크스페이스 전환 화면
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { CircleButton, DashedButton, IconTile } from '../../../shared/components/Ui';
import { ROUTES } from '../../../navigation/routes';
import { deleteWorkspace, switchWorkspace, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';

export default function WorkspaceScreen({ navigation }) {
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
    try { await switchWorkspace(w.id); showNotice(`「${w.name}」로 전환했어요`); }
    catch (e) { showNotice(e.message); }
    finally { setBusy(false); }
  };

  const target = list.find((w) => w.id === delId);

  return (
    <View style={styles.root}>
      <ScreenHeader
        title="공간 전환"
        onBack={navigation.goBack}
        right={
          <CircleButton icon="paperclip" label="파일 보관함" onPress={() => navigation.navigate(ROUTES.Files)} />
        }
      />
      <ScrollView contentContainerStyle={styles.content}>
        <DashedButton label="새 워크스페이스 만들기" onPress={() => navigation.navigate(ROUTES.WorkspaceCreate)} />

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
              style={({ pressed }) => [styles.card, on && styles.cardOn, pressed && !on && { backgroundColor: '#F7FBF9' }]}
            >
              {/* 개인 공간은 자물쇠, 조직 공간은 사람들 */}
              <IconTile icon={w.personal ? 'lock' : 'users'} size={40} bg={on ? colors.white : colors.mintSoft} />
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
          try { await deleteWorkspace(id); showNotice('처리했어요'); }
          catch (e) { showNotice(e.message); }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, minHeight: 64 },
  cardOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  name: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  sub: { fontSize: font.body, color: colors.muted },
  desc: { fontSize: font.caption, color: colors.muted },
  badge: { paddingHorizontal: spacing.md, minHeight: 26, borderRadius: radius.pill, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: font.caption, fontWeight: '800', color: colors.white },
  hint: { fontSize: font.caption, color: colors.muted, lineHeight: 18, marginTop: spacing.sm },
  notice: { position: 'absolute', left: spacing.xl, right: spacing.xl, bottom: spacing.xl, backgroundColor: colors.ink, borderRadius: radius.md, padding: spacing.md, alignItems: 'center' },
  noticeText: { color: colors.white, fontSize: font.body },
});
