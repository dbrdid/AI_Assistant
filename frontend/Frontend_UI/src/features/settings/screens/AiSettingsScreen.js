// ============================================================
// AiSettingsScreen.js — AI 및 브리핑 설정
// ============================================================

import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { PLANS, WEEKDAY_NAMES, getSettings, updateSettings } from '../../../data/settings/SettingsStore';
import { TimePickerModal } from '../../../shared/components/DateTimePicker';
import { PURPOSES, TIMEZONES, hasPurpose, timezoneLabel, togglePurpose } from '../../../data/setup/SetupStore';
import { Row, SaveButton, SectionTitle, ToggleRow, same, useNotice } from '../../../shared/components/SettingsUi';
import { grantConsent, revokeConsent } from '../../../lib/stella/account';
import { runtime, maybeRuntime } from '../../../integration/runtime';

const MODES = [
  { id: 'confirm', title: '확인 후 저장', sub: '생성된 결과물을 사용자가 직접 확인하고 승인한 뒤에만 저장합니다' },
];

export default function AiSettingsScreen({ navigation }) {
  const saved = getSettings();
  const [ai, setAi] = useState(() => JSON.parse(JSON.stringify(saved.ai)));
  const [picker, setPicker] = useState(null); // 'weekly' | 'daily' | null
  const [setup, setSetup] = useState(() => ({ ...saved.setup })); // 첫 실행 때 고른 사용 목적·시간대
  const [tzOpen, setTzOpen] = useState(false);
  const notice = useNotice();
  const consentBusy = useRef(false);
  const set = (patch) => setAi((p) => ({ ...p, ...patch }));

  return (
    <View style={styles.root}>
      <ScreenHeader title="AI 및 브리핑" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <SectionTitle>AI 처리와 전송 허용</SectionTitle>
        <Row label="처리 서버" value={ai.route === 'self_hosted' ? '자체 모델 전용' : '외부 AI 전용'} onPress={() => { if (consentBusy.current) return; const next = { route: ai.route === 'self_hosted' ? 'external' : 'self_hosted', transmissionDisabled: true, allowedProviders: [], consent: {} }; updateSettings('ai', next); set(next); }} />
        <ToggleRow label="선택한 서버로 자료 전송 허용" sub={ai.route === 'self_hosted' ? 'Supabase와 자체 모델 서버가 선택한 자료를 처리합니다. 외부 AI로 전환하지 않습니다.' : 'Supabase와 외부 AI 제공자가 선택한 자료를 처리합니다.'}
          value={!ai.transmissionDisabled} onValueChange={async enabled => {
            if (consentBusy.current) return;
            consentBusy.current = true;
            const own = runtime();
            const selected = ai.route ?? 'external'; const type = selected === 'self_hosted' ? 'SERVER_AI' : 'EXTERNAL_AI';
            const denied = { transmissionDisabled: true, allowedProviders: [], consent: {} };
            updateSettings('ai', denied); set(denied);
            try {
              if (enabled) await grantConsent(type, { provider: selected }); else await revokeConsent(type);
              if (maybeRuntime() !== own) return;
              const next = { transmissionDisabled: !enabled, allowedProviders: enabled ? [selected] : [], consent: { [selected]: enabled } };
              updateSettings('ai', { route: selected, ...next }); set(next);
            } catch (error) { if (maybeRuntime() === own) notice.show(error.message); }
            finally { consentBusy.current = false; }
          }} />
        <ToggleRow label="AI 자동 분석" sub="입력한 내용을 AI가 자동으로 분석해요" value={ai.autoAnalyze} onValueChange={(v) => set({ autoAnalyze: v })} />

        <SectionTitle>AI 확인 방식</SectionTitle>
        {MODES.map((m) => {
          const on = ai.confirmMode === m.id;
          return (
            <Pressable
              key={m.id}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              onPress={() => set({ confirmMode: m.id })}
              style={[styles.mode, on && styles.modeOn]}
            >
              <Text style={[styles.radio, on && { color: colors.mintDark }]}>{on ? '◉' : '○'}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.modeTitle}>{m.title}</Text>
                <Text style={styles.modeSub}>{m.sub}</Text>
              </View>
            </Pressable>
          );
        })}

        <SectionTitle>사용 목적</SectionTitle>
        {PURPOSES.map((p) => {
          const on = hasPurpose(setup.purpose, p.id);
          return (
            <Pressable key={p.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => setSetup((s) => ({ ...s, purpose: togglePurpose(s.purpose, p.id) }))} style={[styles.mode, on && styles.modeOn]}>
              <Text style={[styles.radio, on && { color: colors.mintDark }]}>{on ? '☑' : '☐'}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.modeTitle}>{p.icon}  {p.label}</Text>
                <Text style={styles.modeSub}>{p.sub}</Text>
              </View>
            </Pressable>
          );
        })}
        <Row label="시간대" value={setup.timezone ? timezoneLabel(setup.timezone) : '선택 안 함'} onPress={() => setTzOpen((v) => !v)} />
        {tzOpen && (
          <View style={styles.sub}>
            {TIMEZONES.map((t) => {
              const on = setup.timezone === t.id;
              return (
                <Pressable key={t.id} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => { setSetup((s) => ({ ...s, timezone: t.id })); setTzOpen(false); }} style={[styles.mode, on && styles.modeOn]}>
                  <Text style={[styles.radio, on && { color: colors.mintDark }]}>{on ? '◉' : '○'}</Text>
                  <Text style={styles.modeTitle}>{t.label} ({t.gmt})</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <SectionTitle>브리핑</SectionTitle>
        <ToggleRow label="주간 브리핑" sub={ai.weekly.on ? `${ai.weekly.day} ${ai.weekly.time}` : '받지 않음'} value={ai.weekly.on} onValueChange={(v) => set({ weekly: { ...ai.weekly, on: v } })} />
        {ai.weekly.on && (
          <View style={styles.sub}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {WEEKDAY_NAMES.map((d) => (
                <Pressable key={d} accessibilityRole="button" accessibilityState={{ selected: ai.weekly.day === d }} onPress={() => set({ weekly: { ...ai.weekly, day: d } })} style={[styles.chip, ai.weekly.day === d && styles.chipOn]}>
                  <Text style={[styles.chipText, ai.weekly.day === d && styles.chipTextOn]}>{d.charAt(0)}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Row label="받는 시간" value={ai.weekly.time} onPress={() => setPicker('weekly')} />
          </View>
        )}
        <ToggleRow label="일간 브리핑" sub={ai.daily.on ? ai.daily.time : '받지 않음'} value={ai.daily.on} onValueChange={(v) => set({ daily: { ...ai.daily, on: v } })} />
        {ai.daily.on && (
          <View style={styles.sub}>
            <Row label="받는 시간" value={ai.daily.time} onPress={() => setPicker('daily')} />
          </View>
        )}

        <SectionTitle>이용량</SectionTitle>
        <Row label="이용량" value={PLANS[saved.plan].name} onPress={() => navigation.navigate(ROUTES.AiUsage)} />

        <SaveButton
          disabled={same(ai, saved.ai) && same(setup, saved.setup)}
          onPress={() => {
            if (consentBusy.current) return;
            updateSettings('ai', ai);
            updateSettings('setup', setup);
            notice.show('저장했어요');
          }}
        />
      </ScrollView>
      {notice.view}

      <TimePickerModal
        key={`ai-${picker}`}
        visible={picker !== null}
        title={picker === 'weekly' ? '주간 브리핑 시간' : '일간 브리핑 시간'}
        value={picker ? ai[picker].time : ''}
        onPick={(v) => {
          set({ [picker]: { ...ai[picker], time: v } });
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
  mode: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  modeOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  radio: { fontSize: 22, color: colors.muted },
  modeTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  modeSub: { fontSize: font.caption, color: colors.muted, lineHeight: 17 },
  sub: { gap: spacing.sm, paddingLeft: spacing.lg },
  chips: { gap: spacing.sm },
  chip: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  chipTextOn: { color: colors.white },
});
