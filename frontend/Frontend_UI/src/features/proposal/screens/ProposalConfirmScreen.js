// ============================================================
// ProposalConfirmScreen.js — AI 제안 확인 (스토리보드 99~101장)
// ============================================================

import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { approveProposal, findDuplicate, getProposal, setProposalStatus } from '../../../data/proposals/ProposalStore';
import { getSettings } from '../../../data/settings/SettingsStore';
import { fromKey } from '../../calendar/utils/DateUtils';
import { DatePickerModal, TimePickerModal } from '../../../shared/components/DateTimePicker';
import { useNotice } from '../../../shared/components/SettingsUi';
import { KIND_LABEL } from './ProposalListScreen';

const dateLabel = (k) => { if (!k) return '날짜 선택'; const d = fromKey(k); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };

export default function ProposalConfirmScreen({ navigation, route }) {
  const id = route?.params?.id;
  const p = getProposal(id);
  const notice = useNotice();
  const [f, setF] = useState(() => (p ? { ...p, body: p.body || (p.evidence ? `${p.title}\n근거: ${p.evidence}` : p.title) } : null));
  const [picker, setPicker] = useState(null);
  const [dup, setDup] = useState(null);
  const done = useRef(false); // 저장·보류·거절을 두 번 누르는 것 방지
  if (!p || !f) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="AI 제안 확인" onBack={navigation.goBack} />
        <Text style={styles.empty}>이미 처리했거나 찾을 수 없는 제안이에요.</Text>
      </View>
    );
  }
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const isMemo = f.kind === 'memo';
  const paid = getSettings().plan && getSettings().plan !== 'free';

  const finish = (msg) => { done.current = true; notice.show(msg); setTimeout(navigation.goBack, 600); };
  const doSave = () => {
    if (done.current) return;
    const saved = approveProposal(id, f);
    finish(saved && saved.kind === 'memo' ? '메모로 저장했어요' : '저장했어요');
  };
  const save = () => {
    if (done.current) return;
    if (!f.title.trim()) { notice.show('제목을 입력해 주세요'); return; }
    if (!isMemo && !f.date) { notice.show('날짜를 선택해 주세요'); return; }
    const d = findDuplicate(f);
    if (d) { setDup(d); return; }
    doSave();
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="AI 제안 확인" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.seg}>
          {['event', 'task', 'memo'].map((k) => (
            <Pressable key={k} accessibilityRole="button" accessibilityState={{ selected: f.kind === k }} onPress={() => set('kind')(k)} style={[styles.segBtn, f.kind === k && styles.segOn]}>
              <Text style={[styles.segText, f.kind === k && styles.segTextOn]}>{KIND_LABEL[k]}</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.label}>{isMemo ? '메모 제목' : f.kind === 'event' ? '일정명' : '할 일'}</Text>
        <TextInput style={styles.input} value={f.title} onChangeText={set('title')} maxLength={100} placeholderTextColor={colors.muted} accessibilityLabel="제목" />

        {!isMemo ? (
          <>
            <Text style={styles.label}>일시</Text>
            <View style={styles.rowGap}>
              <Pressable accessibilityRole="button" onPress={() => setPicker('date')} style={[styles.input, styles.pick]}><Text style={styles.pickText}>{dateLabel(f.date)}</Text></Pressable>
              {f.kind === 'event' && (
                <Pressable accessibilityRole="button" onPress={() => setPicker('start')} style={[styles.input, styles.pick]}><Text style={styles.pickText}>{f.start || '시간'}</Text></Pressable>
              )}
            </View>
            <Text style={styles.label}>장소</Text>
            <TextInput style={styles.input} value={f.place} onChangeText={set('place')} placeholder="장소" placeholderTextColor={colors.muted} accessibilityLabel="장소" />
            <Text style={styles.label}>담당자</Text>
            <TextInput style={styles.input} value={f.assignee} onChangeText={set('assignee')} placeholder="담당자" placeholderTextColor={colors.muted} accessibilityLabel="담당자" />
          </>
        ) : (
          <>
            <Text style={styles.label}>메모 미리보기</Text>
            <TextInput style={[styles.input, { minHeight: 120, textAlignVertical: 'top' }]} multiline value={f.body} onChangeText={set('body')} placeholderTextColor={colors.muted} accessibilityLabel="메모 본문" />
            <Pressable accessibilityRole="button" onPress={() => (paid ? notice.show('자료 분석은 서버가 연결되면 사용할 수 있어요') : navigation.navigate(ROUTES.Subscription))} style={styles.locked}>
              <Text style={styles.lockedTitle}>{paid ? '✦ AI 자동 이미지' : '🔒 AI 자동 이미지'}</Text>
              <Text style={styles.lockedSub}>{paid ? '서버 연결 후 사용할 수 있어요' : '이미지 포함 저장은 Pro·Team  ›'}</Text>
            </Pressable>
          </>
        )}

        {!!p.evidence && (
          <View style={styles.evBox}>
            <Text style={styles.evLabel}>근거 · {p.sourceType === 'record' ? '녹음' : '메모'}{p.sourceTitle ? ` “${p.sourceTitle}”` : ''}</Text>
            <Text style={styles.evText}>“<Text style={styles.hl}>{p.evidence}</Text>”</Text>
          </View>
        )}

        <Pressable accessibilityRole="button" onPress={save} style={styles.primary}><Text style={styles.primaryText}>저장하기</Text></Pressable>
        <View style={styles.rowGap}>
          <Pressable accessibilityRole="button" onPress={() => { if (done.current) return; setProposalStatus(id, 'hold'); finish('보류했어요. 나중에 다시 확인할 수 있어요'); }} style={[styles.ghost, { flex: 1 }]}><Text style={styles.ghostText}>보류</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => { if (done.current) return; setProposalStatus(id, 'rejected'); finish('거절했어요'); }} style={[styles.ghost, { flex: 1 }]}><Text style={[styles.ghostText, { color: colors.coral }]}>거절</Text></Pressable>
        </View>
      </ScrollView>

      <DatePickerModal visible={picker === 'date'} value={f.date} onPick={(k) => { set('date')(k); setPicker(null); }} onClose={() => setPicker(null)} />
      <TimePickerModal visible={picker === 'start'} value={f.start} title="시작 시간" onPick={(v) => { set('start')(v); setPicker(null); }} onClear={() => { set('start')(''); setPicker(null); }} onClose={() => setPicker(null)} />
      <ConfirmDialog visible={!!dup} title="이미 비슷한 일정이 있어요" sub={dup ? `“${dup.title}” (${dup.start || '종일'})와 겹쳐요. 그래도 저장할까요?` : ''} confirmText="그래도 저장" onCancel={() => setDup(null)} onConfirm={() => { setDup(null); doSave(); }} />
      {notice.view}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  empty: { textAlign: 'center', color: colors.muted, marginTop: spacing.xxl, fontSize: font.body },
  body: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
  seg: { flexDirection: 'row', backgroundColor: colors.white, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: 4, marginBottom: spacing.sm },
  segBtn: { flex: 1, minHeight: 40, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.mintDark },
  segText: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  segTextOn: { color: colors.white },
  label: { fontSize: font.body, fontWeight: '700', color: colors.ink, marginTop: spacing.sm },
  input: { minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: spacing.md, fontSize: font.bodyLg, color: colors.ink },
  rowGap: { flexDirection: 'row', gap: spacing.sm },
  pick: { flex: 1, justifyContent: 'center' },
  pickText: { fontSize: font.bodyLg, color: colors.ink },
  locked: { minHeight: 72, borderRadius: radius.md, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.line, backgroundColor: colors.white, padding: spacing.md, justifyContent: 'center', gap: 4, marginTop: spacing.sm },
  lockedTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  lockedSub: { fontSize: font.body, color: colors.muted },
  evBox: { backgroundColor: '#EAF4F0', borderRadius: radius.md, padding: spacing.md, gap: 4, marginTop: spacing.md },
  evLabel: { fontSize: font.caption, fontWeight: '800', color: colors.mintDark },
  evText: { fontSize: font.body, color: colors.ink, lineHeight: 21 },
  hl: { backgroundColor: '#FFF1B8' },
  primary: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: spacing.lg },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  ghost: { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
