// ============================================================
// NotificationSettingsScreen.js — 알림 설정
// ============================================================

import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { getSettings, updateSettings } from '../../../data/settings/SettingsStore';
import { TimePickerModal } from '../../../shared/components/DateTimePicker';
import { Row, SaveButton, SectionTitle, ToggleRow, same, useNotice } from '../../../shared/components/SettingsUi';

const KINDS = [
  { id: 'schedule', label: '일정 알림' },
  { id: 'due', label: '할 일 마감 알림' },
  { id: 'aiConfirm', label: 'AI 확인 요청' },
  { id: 'briefing', label: '브리핑' },
];

export default function NotificationSettingsScreen({ navigation }) {
  const saved = getSettings();
  const [n, setN] = useState({ ...saved.notify });
  const [picker, setPicker] = useState(null); // 'dndStart' | 'dndEnd' | null
  const notice = useNotice();
  const set = (patch) => setN((p) => ({ ...p, ...patch }));

  return (
    <View style={styles.root}>
      <ScreenHeader title="알림 설정" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <SectionTitle>받을 알림</SectionTitle>
        {KINDS.map((k) => (
          <ToggleRow key={k.id} label={k.label} value={n[k.id]} onValueChange={(v) => set({ [k.id]: v })} />
        ))}

        <SectionTitle>방해 금지 시간</SectionTitle>
        <ToggleRow label="방해 금지" sub="설정한 시간에는 알림을 보내지 않아요" value={n.dndOn} onValueChange={(v) => set({ dndOn: v })} />
        {n.dndOn && (
          <>
            <Row label="시작" value={n.dndStart} onPress={() => setPicker('dndStart')} />
            <Row label="끝" value={n.dndEnd} onPress={() => setPicker('dndEnd')} />
            <Text style={styles.note}>시작이 끝보다 늦으면 다음 날 아침까지로 계산해요 (예: 22:00 ~ 06:30)</Text>
          </>
        )}
        <Text style={styles.note}>저장하면 이 설정대로 일정·할 일 마감·브리핑 알림이 예약돼요. 알림 시각은 일정/할 일의 [알림] 설정을 따라요.</Text>

        <SaveButton
          disabled={same(n, saved.notify)}
          onPress={() => {
            updateSettings('notify', n);
            notice.show('저장했어요');
          }}
        />
      </ScrollView>
      {notice.view}

      <TimePickerModal
        key={`dnd-${picker}`}
        visible={picker !== null}
        title={picker === 'dndStart' ? '방해 금지 시작' : '방해 금지 끝'}
        value={picker ? n[picker] : ''}
        onPick={(v) => {
          set({ [picker]: v });
          setPicker(null);
        }}
        onClear={() => setPicker(null)}
        onClose={() => setPicker(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  note: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
});
