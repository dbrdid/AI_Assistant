import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Icon from '../../../shared/components/Icon';
import ReviewActions from '../../../shared/components/ReviewActions';
import { useInsets } from '../../../shared/hooks/useInsets';
import { WorkspaceHeader } from '../../stella/WorkspaceScreen';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { approveProposal, findDuplicate, getProposal, setProposalStatus } from '../../../data/proposals/ProposalStore';
import { getMemo } from '../../../data/memos/MemoStore';
import { getSettings } from '../../../data/settings/SettingsStore';
import { unstatedTimeWarning } from '../../../integration/recordEvidence.mjs';
import { fromKey } from '../../calendar/utils/DateUtils';
import { DatePickerModal, TimePickerModal } from '../../../shared/components/DateTimePicker';
import { useNotice } from '../../../shared/components/SettingsUi';
import { KIND_LABEL } from '../components/ProposalCard';

const dateLabel = (k) => { if (!k) return '날짜 선택'; const d = fromKey(k); return `${d.getMonth() + 1}월 ${d.getDate()}일`; };

export default function ProposalConfirmScreen({ navigation, route }) {
  const id = route?.params?.id;
  const p = getProposal(id);
  const notice = useNotice();
  const insets = useInsets();
  const [f, setF] = useState(() => (p ? { ...p, body: p.body || (p.evidence ? `${p.title}\n근거: ${p.evidence}` : p.title) } : null));
  const [picker, setPicker] = useState(null);
  const [dup, setDup] = useState(null);
  const completion=useRef('');
  const finishTimer=useRef(null);
  useEffect(()=>()=>clearTimeout(finishTimer.current),[]);
  const done = useRef(false); // 저장·보류·거절을 두 번 누르는 것 방지
  if (!p || !f) {
    return (
      <View style={styles.root}>
        <WorkspaceHeader title="제안 확인" onBack={navigation.goBack} />
        <Text style={styles.empty}>{done.current ? completion.current : '이미 처리했거나 찾을 수 없는 제안이에요.'}</Text>
      </View>
    );
  }
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }));
  const isMemo = f.kind === 'memo';
  const paid = getSettings().plan && getSettings().plan !== 'free';
  // Only the model's untouched values warn; a time the user picked is the user's decision.
  const timeWarning = !isMemo && p.sourceType === 'memo'
    ? unstatedTimeWarning({ start: f.start === p.start ? f.start : '', end: f.end === p.end ? f.end : '' }, getMemo(p.sourceId)?.body) : '';

  const finish = (msg) => { done.current = true; completion.current=msg; notice.show(msg); finishTimer.current=setTimeout(navigation.goBack, 600); };
  const doSave = () => {
    if (done.current) return;
    try {
      const saved = approveProposal(id, f);
      finish(saved && saved.kind === 'memo' ? '메모로 저장했어요' : '저장했어요');
    } catch (error) {
      notice.show(error.code === 'source_changed' ? '원본 메모가 바뀌었어요. 다시 분석해 주세요.' : error.message);
    }
  };
  const save = () => {
    if (done.current) return;
    if (!f.title.trim()) { notice.show('제목을 입력해 주세요'); return; }
    if (!isMemo && !f.date) { notice.show('날짜를 선택해 주세요'); return; }
    const d = findDuplicate(f);
    if (d) { setDup(d); return; }
    doSave();
  };

  const statusChange = (status, message) => {
    if (done.current) return;
    try { setProposalStatus(id, status); finish(message); }
    catch (error) { notice.show(error.message); }
  };
  const pickerRow = (label, value, onPress) => (
    <Pressable accessibilityRole="button" accessibilityLabel={value ? label + ' ' + value : label}
      onPress={onPress} style={styles.property}>
      <Text style={styles.propertyLabel}>{label}</Text>
      <Text style={styles.propertyValue}>{value || '선택'}</Text>
      <Icon name="chevronRight" size={14} color={colors.muted} />
    </Pressable>
  );
  const field = (label, key) => (
    <View style={styles.property}>
      <Text style={styles.propertyLabel}>{label}</Text>
      <TextInput style={styles.field} value={f[key]} onChangeText={set(key)} placeholder="입력"
        placeholderTextColor={colors.muted} accessibilityLabel={label} />
    </View>
  );

  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding">
      <WorkspaceHeader title="제안 확인" onBack={navigation.goBack} />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={styles.tabs}>
          {['event', 'task', 'memo'].map(key => (
            <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: f.kind === key }}
              onPress={() => set('kind')(key)} style={[styles.tab, f.kind === key && styles.tabOn]}>
              <Text style={[styles.tabText, f.kind === key && styles.tabTextOn]}>{KIND_LABEL[key]}</Text>
            </Pressable>
          ))}
        </View>

        <TextInput style={styles.title} value={f.title} onChangeText={set('title')} maxLength={100}
          placeholder="제목" placeholderTextColor={colors.muted} accessibilityLabel="제목" />

        {isMemo ? <>
          <TextInput style={styles.document} multiline value={f.body} onChangeText={set('body')}
            placeholder="문서 본문" placeholderTextColor={colors.muted} accessibilityLabel="메모 본문" />
          <Pressable accessibilityRole="button"
            onPress={() => (paid ? notice.show('자료 분석은 서버가 연결되면 사용할 수 있어요') : navigation.navigate(ROUTES.Subscription))}
            style={styles.property}>
            <Text style={styles.propertyLabel}>AI 자동 이미지</Text>
            <Text style={styles.propertyValue}>{paid ? '서버 연결 필요' : 'Pro / Team'}</Text>
            <Icon name={paid ? 'chevronRight' : 'lock'} size={14} color={colors.muted} />
          </Pressable>
        </> : <>
          {pickerRow('날짜', f.date ? dateLabel(f.date) : '', () => setPicker('date'))}
          {(f.kind === 'event' || !!f.start) && pickerRow('시작 시간', f.start, () => setPicker('start'))}
          {!!f.end && pickerRow('종료 시간', f.end, () => setPicker('end'))}
          {!!timeWarning && <Text style={styles.warning} accessibilityRole="alert" accessibilityLabel={`경고: ${timeWarning}`}>{timeWarning}</Text>}
          {field('장소', 'place')}
          {field('담당자', 'assignee')}
        </>}

        {!!p.evidence && <View style={styles.evidence}>
          <Text style={styles.tabText}>근거{p.sourceTitle ? ', ' + p.sourceTitle : ''}</Text>
          <Text selectable style={styles.quote}>{p.evidence}</Text>
        </View>}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(4, insets.bottom) }]}>
        <ReviewActions actions={[
          p.status !== 'hold' && { label: '보류', onPress: () => statusChange('hold', '보류했어요. 나중에 다시 확인할 수 있어요') },
          { label: '거절', danger: true, onPress: () => statusChange('rejected', '거절했어요') },
          { label: '저장하기', primary: true, onPress: save },
        ]} />
      </View>

      <DatePickerModal visible={picker === 'date'} value={f.date} onPick={(k) => { set('date')(k); setPicker(null); }} onClose={() => setPicker(null)} />
      <TimePickerModal visible={picker === 'start'} value={f.start} title="시작 시간" onPick={(v) => { set('start')(v); setPicker(null); }} onClear={() => { set('start')(''); setPicker(null); }} onClose={() => setPicker(null)} />
      <TimePickerModal visible={picker === 'end'} value={f.end} title="종료 시간" onPick={(v) => { set('end')(v); setPicker(null); }} onClear={() => { set('end')(''); setPicker(null); }} onClose={() => setPicker(null)} />
      <ConfirmDialog visible={!!dup} title="이미 비슷한 일정이 있어요" sub={dup ? `“${dup.title}” (${dup.start || '종일'})와 겹쳐요. 그래도 저장할까요?` : ''} confirmText="그래도 저장" onCancel={() => setDup(null)} onConfirm={() => { setDup(null); doSave(); }} />
      {notice.view}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  empty: { color: colors.muted, margin: spacing.lg, fontSize: 14 },
  body: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl },
  tabs: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line, gap: 16 },
  tab: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 2, borderBottomWidth: 1, borderColor: 'transparent' },
  tabOn: { borderColor: colors.ink },
  tabText: { fontSize: 13, color: colors.muted },
  tabTextOn: { color: colors.ink, fontWeight: '600' },
  title: { color: colors.ink, fontSize: 24, fontWeight: '600', minHeight: 68, paddingHorizontal: 0, paddingVertical: 12 },
  property: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  propertyLabel: { color: colors.muted, minWidth: 76, fontSize: 14 },
  propertyValue: { color: colors.ink, fontSize: 14, flex: 1, textAlign: 'right' },
  field: { flex: 1, color: colors.ink, fontSize: 14, minHeight: 44, padding: 0, textAlign: 'right' },
  warning: { fontSize: 13, color: colors.coral, lineHeight: 19, marginVertical: 8 },
  document: { color: colors.ink, fontSize: 15, lineHeight: 23, minHeight: 96, padding: 0, textAlignVertical: 'top' },
  evidence: { marginTop: 18, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingTop: 12, gap: 6 },
  quote: { color: colors.ink, fontSize: 14, lineHeight: 21 },
  footer: { paddingHorizontal: spacing.lg, paddingVertical: 4, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
});
