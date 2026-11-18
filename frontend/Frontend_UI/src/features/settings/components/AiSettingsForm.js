// ============================================================
// AiSettingsForm.js — AI 및 브리핑 설정 내용 (설정 화면과 AI 채팅의 오른쪽 창이 같이 씀)
//   onOpenUsage: '이용량'을 눌렀을 때 (설정 화면: 이용량 화면으로 이동, AI 채팅: 사용량 창)
// ============================================================

import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { LOCAL_AI_AVAILABLE, PLANS, WEEKDAY_NAMES, getSettings, setAiRoute, setAiTransmission, updateSettings } from '../../../data/settings/SettingsStore';
import { TimePickerModal } from '../../../shared/components/DateTimePicker';
import { PURPOSES, TIMEZONES, hasPurpose, timezoneLabel, togglePurpose } from '../../../data/setup/SetupStore';
import { Group, Radio, Row, SaveButton, SectionTitle, ToggleRow, same, useNotice } from '../../../shared/components/SettingsUi';
import Icon from '../../../shared/components/Icon';
import { runtime, maybeRuntime } from '../../../integration/runtime';

const MODES = [
  { id: 'confirm', title: '확인 후 저장', sub: '생성된 결과물을 사용자가 직접 확인하고 승인한 뒤에만 저장합니다' },
];

// compact: AI 채팅의 오른쪽 창용. 사용 목적·시간대·브리핑·이용량은 빼고 AI 처리·확인 방식만
export default function AiSettingsForm({ onOpenUsage, contentStyle, compact = false }) {
  const saved = getSettings();
  const [ai, setAi] = useState(() => JSON.parse(JSON.stringify(saved.ai)));
  const [picker, setPicker] = useState(null); // 'weekly' | 'daily' | null
  const [setup, setSetup] = useState(() => ({ ...saved.setup })); // 첫 실행 때 고른 사용 목적·시간대
  const [tzOpen, setTzOpen] = useState(false);
  const notice = useNotice();
  const consentBusy = useRef(false);
  const set = (patch) => setAi((p) => ({ ...p, ...patch }));

  // 처리 서버 바꾸기: 경로마다 동의가 따로라 전송 허용은 꺼짐. 로컬 AI는 서버 연결 전에는 고를 수 없음
  const switchRoute = () => {
    if (consentBusy.current) return;
    const next = ai.route === 'self_hosted' ? 'external' : 'self_hosted';
    if (next === 'self_hosted' && !LOCAL_AI_AVAILABLE) return notice.show('로컬 AI는 서버 연결 후 쓸 수 있어요');
    const s = setAiRoute(next);
    const { route, transmissionDisabled, allowedProviders, consent } = s.ai;
    set({ route, transmissionDisabled, allowedProviders, consent });
  };

  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.content, contentStyle]}>
        <SectionTitle>AI 처리와 전송 허용</SectionTitle>
        {/* 좁은 창(AI 채팅 오른쪽)에서도 한 줄에 들어가게 값은 짧게. 로컬 준비 중 안내는 누르면 표시 */}
        <Group>
          <Row label="처리 서버" value={ai.route === 'self_hosted' ? '자체 모델' : '외부 AI'} onPress={switchRoute} />
          <ToggleRow label="선택한 서버로 자료 전송 허용" sub={ai.route === 'self_hosted' ? 'Supabase와 자체 모델 서버가 선택한 자료를 처리합니다. 외부 AI로 전환하지 않습니다.' : 'Supabase와 외부 AI 제공자가 선택한 자료를 처리합니다.'}
            value={!ai.transmissionDisabled} onValueChange={async enabled => {
              if (consentBusy.current) return;
              consentBusy.current = true;
              const own = runtime();
              const selected = ai.route ?? 'external';
              set({ transmissionDisabled: true, allowedProviders: [], consent: {} });
              try {
                const next = await setAiTransmission(selected, enabled);
                const { route, transmissionDisabled, allowedProviders, consent } = next.ai; // 다른 칸의 저장 전 수정은 유지
                if (maybeRuntime() === own) set({ route, transmissionDisabled, allowedProviders, consent });
              } catch (error) { if (maybeRuntime() === own) notice.show(error.message); }
              finally { consentBusy.current = false; }
            }} />
          <ToggleRow label="AI 자동 분석" sub="입력한 내용을 AI가 자동으로 분석해요" value={ai.autoAnalyze} onValueChange={(v) => set({ autoAnalyze: v })} />
        </Group>

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
              <Radio on={on} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.modeTitle}>{m.title}</Text>
                <Text style={styles.modeSub}>{m.sub}</Text>
              </View>
            </Pressable>
          );
        })}

        {!compact && (<>
        <SectionTitle>사용 목적</SectionTitle>
        {PURPOSES.map((p) => {
          const on = hasPurpose(setup.purpose, p.id);
          return (
            <Pressable key={p.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} onPress={() => setSetup((s) => ({ ...s, purpose: togglePurpose(s.purpose, p.id) }))} style={[styles.mode, on && styles.modeOn]}>
              <Icon name={on ? 'checkSquare' : 'square'} size={22} color={on ? colors.mintDark : colors.muted} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={styles.modeTitle}>{p.label}</Text>
                <Text style={styles.modeSub}>{p.sub}</Text>
              </View>
            </Pressable>
          );
        })}
        <Row icon="globe" label="시간대" value={setup.timezone ? timezoneLabel(setup.timezone) : '선택 안 함'} onPress={() => setTzOpen((v) => !v)} />
        {tzOpen && (
          <View style={styles.sub}>
            {TIMEZONES.map((t) => {
              const on = setup.timezone === t.id;
              return (
                <Pressable key={t.id} accessibilityRole="radio" accessibilityState={{ selected: on }} onPress={() => { setSetup((s) => ({ ...s, timezone: t.id })); setTzOpen(false); }} style={[styles.mode, on && styles.modeOn]}>
                  <Radio on={on} />
                  <Text style={styles.modeTitle}>{t.label} ({t.gmt})</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        <SectionTitle>브리핑</SectionTitle>
        <Group>
          <ToggleRow label="주간 브리핑" sub={ai.weekly.on ? `${ai.weekly.day} ${ai.weekly.time}` : '받지 않음'} value={ai.weekly.on} onValueChange={(v) => set({ weekly: { ...ai.weekly, on: v } })} />
          {ai.weekly.on && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {WEEKDAY_NAMES.map((d) => (
                <Pressable key={d} accessibilityRole="button" accessibilityState={{ selected: ai.weekly.day === d }} onPress={() => set({ weekly: { ...ai.weekly, day: d } })} style={[styles.chip, ai.weekly.day === d && styles.chipOn]}>
                  <Text style={[styles.chipText, ai.weekly.day === d && styles.chipTextOn]}>{d.charAt(0)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          {ai.weekly.on && <Row label="받는 시간" value={ai.weekly.time} onPress={() => setPicker('weekly')} />}
        </Group>
        <Group>
          <ToggleRow label="일간 브리핑" sub={ai.daily.on ? ai.daily.time : '받지 않음'} value={ai.daily.on} onValueChange={(v) => set({ daily: { ...ai.daily, on: v } })} />
          {ai.daily.on && <Row label="받는 시간" value={ai.daily.time} onPress={() => setPicker('daily')} />}
        </Group>

        <SectionTitle>이용량</SectionTitle>
        <Row icon="sparkles" label="이용량" value={PLANS[saved.plan].name} onPress={onOpenUsage} />
        </>)}

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
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  mode: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  modeOn: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  modeTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  modeSub: { fontSize: font.caption, color: colors.muted, lineHeight: 17 },
  sub: { gap: spacing.sm, paddingLeft: spacing.lg },
  // 주간 브리핑 요일 칩 (Group 카드 안)
  chips: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  chip: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  chipTextOn: { color: colors.white },
});
