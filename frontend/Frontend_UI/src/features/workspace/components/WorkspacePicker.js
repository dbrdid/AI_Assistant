// ============================================================
// WorkspacePicker.js — 홈에서 바로 여는 "워크스페이스" 창
// ============================================================

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import { colors, font, radius, spacing, FILL } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { switchWorkspace, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';

export default function WorkspacePicker({ visible, onClose, navigation, onSwitched }) {
  const insets = useSafeAreaInsets();
  const { list, current } = useWorkspaces();
  const [busy, setBusy] = useState(false);

  const pick = async (w) => {
    if (busy) return;
    if (w.id === current.id) return onClose();
    setBusy(true);
    await switchWorkspace(w.id);
    setBusy(false);
    onClose();
    if (onSwitched) onSwitched(w.name);
  };
  const go = (route) => {
    onClose();
    navigation.navigate(route);
  };

  return (
    <Modal transparent visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="공간 선택 닫기" />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]} accessibilityViewIsModal>
          <View style={styles.grip} />
          <Text style={styles.title}>공간 선택</Text>
          <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: spacing.sm }}>
            {list.map((w) => {
              const on = w.id === current.id;
              return (
                <Pressable
                  key={w.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${w.name}${on ? ', 현재 공간' : ''}`}
                  onPress={() => pick(w)}
                  style={[styles.row, on && styles.rowOn]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.name} numberOfLines={1}>{w.name}</Text>
                    <Text style={styles.sub} numberOfLines={1}>{w.personal ? w.desc : `멤버 ${w.members}명 · ${w.role}`}</Text>
                  </View>
                  {on && (
                    <View style={styles.badge}>
                      <Text style={styles.badgeText}>현재</Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
          <View style={styles.links}>
            <Pressable accessibilityRole="button" onPress={() => go(ROUTES.WorkspaceCreate)} style={styles.link}>
              <Text style={styles.linkText}>＋ 새 워크스페이스</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => go(ROUTES.Workspace)} style={styles.link}>
              <Text style={styles.linkText}>공간 관리</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...FILL, backgroundColor: 'rgba(38,57,53,0.4)' },
  sheet: { backgroundColor: colors.cream, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md },
  grip: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.line, marginBottom: spacing.xs },
  title: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 60, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  rowOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  name: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  sub: { fontSize: font.caption, color: colors.muted },
  badge: { paddingHorizontal: spacing.md, minHeight: 26, borderRadius: 13, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  badgeText: { fontSize: font.caption, fontWeight: '800', color: colors.white },
  links: { flexDirection: 'row', gap: spacing.sm },
  link: { flex: 1, minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  linkText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
});
