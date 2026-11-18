// ============================================================
// NotificationSettingsScreen.js — 알림 설정
// ============================================================

import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { getSettings, updateSettings } from '../../../data/settings/SettingsStore';
import { TimePickerModal } from '../../../shared/components/DateTimePicker';
import { Group, Row, SaveButton, SectionTitle, ToggleRow, same, useNotice } from '../../../shared/components/SettingsUi';
import { onPushState, pushState, pushUnavailableReason, registerPush, serverNotify } from '../../../services/notify/PushRegister';

const KINDS = [
  { id: 'schedule', label: '일정 알림' },
  { id: 'due', label: '할 일 마감 알림' },
  { id: 'aiConfirm', label: 'AI 확인 요청' },
  { id: 'briefing', label: '브리핑' },
];

// 서버 알림 (공유 공간 · 휴대폰). 브리핑·개인 알림은 위의 기기 알림이 보내요.
const SERVER_KINDS = [
  { id: 'reminders', label: '공유 공간 마감·시작 알림', sub: '다른 멤버가 바꾼 일정·할 일·프로젝트도 알려 줘요' },
  { id: 'workspace', label: '새 멤버 소식' },
  { id: 'recording', label: '녹음 변환 끝' },
];

export default function NotificationSettingsScreen({ navigation }) {
  const settings = getSettings();
  const saved = { ...settings.notify, server: serverNotify() };
  const [n, setN] = useState(saved);
  const [picker, setPicker] = useState(null); // 'dndStart' | 'dndEnd' | null
  const [push, setPush] = useState(pushState());
  const [saving, setSaving] = useState(false);
  useEffect(() => onPushState(setPush), []);
  const notice = useNotice();
  const set = (patch) => setN((p) => ({ ...p, ...patch }));
  const setServer = (patch) => setN((p) => ({ ...p, server: { ...p.server, ...patch } }));
  const unavailable = pushUnavailableReason();
  const pushStatus = unavailable || (!n.server.on ? '꺼져 있어요' : push.ready ? '이 휴대폰으로 서버 알림을 받고 있어요' : push.reason || '저장하면 이 휴대폰을 등록해요');

  return (
    <View style={styles.root}>
      <ScreenHeader title="알림 설정" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <SectionTitle>받을 알림</SectionTitle>
        <Group>
          {KINDS.map((k) => (
            <ToggleRow key={k.id} label={k.label} value={n[k.id]} onValueChange={(v) => set({ [k.id]: v })} />
          ))}
        </Group>

        <SectionTitle>방해 금지 시간</SectionTitle>
        <Group>
          <ToggleRow label="방해 금지" sub="설정한 시간에는 알림을 보내지 않아요" value={n.dndOn} onValueChange={(v) => set({ dndOn: v })} />
          {n.dndOn && <Row label="시작" value={n.dndStart} onPress={() => setPicker('dndStart')} />}
          {n.dndOn && <Row label="끝" value={n.dndEnd} onPress={() => setPicker('dndEnd')} />}
        </Group>
        {n.dndOn && <Text style={styles.note}>시작이 끝보다 늦으면 다음 날 아침까지로 계산해요 (예: 22:00 ~ 06:30)</Text>}
        <Text style={styles.note}>저장하면 이 설정대로 일정·할 일 마감·브리핑 알림이 예약돼요. 알림 시각은 일정/할 일의 [알림] 설정을 따라요.</Text>

        <SectionTitle>서버 알림 (공유 공간)</SectionTitle>
        <Group>
          <ToggleRow label="서버 알림 받기" sub={pushStatus} value={n.server.on} disabled={!!unavailable} onValueChange={(v) => setServer({ on: v })} />
          {n.server.on && !unavailable && SERVER_KINDS.map((k) => (
            <ToggleRow key={k.id} label={k.label} sub={k.sub} value={n.server[k.id]} onValueChange={(v) => setServer({ [k.id]: v })} />
          ))}
        </Group>
        <Text style={styles.note}>앱을 열지 않아도 공유 공간 소식을 서버가 이 휴대폰으로 보내 줘요. 서버 알림이 켜져 있으면 공유 공간의 마감 알림은 서버가 보내고, 같은 알림이 두 번 오지 않아요.</Text>

        <SaveButton
          disabled={saving || same(n, saved)}
          onPress={async () => {
            setSaving(true);
            updateSettings('notify', n);
            const r = unavailable ? { ok: true } : await registerPush({ ask: true });
            setSaving(false);
            notice.show(r.ok || !n.server.on ? '저장했어요' : `저장했어요 · ${r.reason}`);
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
  note: { fontSize: font.caption, color: colors.muted, lineHeight: 18, marginHorizontal: spacing.xs },
});
