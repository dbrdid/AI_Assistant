// ============================================================
// ProjectEditScreen.js — 프로젝트 추가 / 편집
// ============================================================

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { fromKey } from '../../calendar/utils/DateUtils';
import { ALARMS, PRIORITIES } from '../../../data/tasks/TaskStore';
import { PROJECT_STATUSES, addProject, deleteProject, getProject, updateProject } from '../../../data/projects/ProjectStore';
import { DatePickerModal } from '../../../shared/components/DateTimePicker';

function Chips({ label, options, value, onChange }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((o) => (
          <Pressable key={o} accessibilityRole="button" accessibilityState={{ selected: value === o }} onPress={() => onChange(o)} style={[styles.chip, value === o && styles.chipOn]}>
            <Text style={[styles.chipText, value === o && styles.chipTextOn]}>{o}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export default function ProjectEditScreen({ navigation, route }) {
  const existing = route?.params?.projectId ? getProject(route.params.projectId) : null;
  const [f, setF] = useState(() => ({
    title: existing?.title ?? '',
    due: existing?.due ?? '',
    priority: existing?.priority ?? '보통',
    status: existing?.status ?? '진행 전',
    alarm: existing?.alarm ?? '없음',
    assignee: existing?.assignee ?? '',
    place: existing?.place ?? '',
    desc: existing?.desc ?? '',
  }));
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  const [pickDate, setPickDate] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    if (!f.title.trim()) return setError('제목을 입력해 주세요.');
    const fields = { ...f, title: f.title.trim() };
    if (existing) {
      updateProject(existing.id, fields);
      navigation.goBack();
    } else {
      const p = addProject(fields);
      // 만든 프로젝트의 상세 화면으로 (뒤로가기 하면 목록)
      navigation.goBack();
      setTimeout(() => navigation.navigate(ROUTES.ProjectDetail, { projectId: p.id }), 0);
    }
  };

  const input = (label, key, extra) => (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={[styles.input, extra]} value={f[key]} onChangeText={set(key)} placeholder={label} placeholderTextColor={colors.muted} accessibilityLabel={label} {...(key === 'desc' ? { multiline: true } : {})} />
    </View>
  );

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title={existing ? '프로젝트 편집' : '프로젝트 추가'} onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.field}>
          <Text style={styles.label}>제목 *</Text>
          <TextInput style={styles.input} value={f.title} onChangeText={set('title')} placeholder="프로젝트 이름" placeholderTextColor={colors.muted} maxLength={60} accessibilityLabel="제목" />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>마감일</Text>
          <View style={styles.row}>
            <Pressable accessibilityRole="button" onPress={() => setPickDate(true)} style={[styles.input, { flex: 1, justifyContent: 'center' }]}>
              <Text style={[styles.pickText, !f.due && { color: colors.muted }]}>
                {f.due ? `${fromKey(f.due).getFullYear()}년 ${fromKey(f.due).getMonth() + 1}월 ${fromKey(f.due).getDate()}일` : '마감일 선택 (선택)'}
              </Text>
            </Pressable>
            {!!f.due && (
              <Pressable accessibilityRole="button" accessibilityLabel="마감일 지우기" onPress={() => set('due')('')} style={styles.clear}>
                <Text style={styles.clearText}>지우기</Text>
              </Pressable>
            )}
          </View>
        </View>

        <Chips label="중요도" options={PRIORITIES} value={f.priority} onChange={set('priority')} />
        <Chips label="상태" options={PROJECT_STATUSES} value={f.status} onChange={set('status')} />
        <Chips label="알림" options={ALARMS} value={f.alarm} onChange={set('alarm')} />
        <Text style={styles.note}>알림 설정은 저장만 되고, 실제 알림은 추후 지원돼요.</Text>

        {input('담당자', 'assignee')}
        {input('장소', 'place')}
        {input('설명', 'desc', { minHeight: 96, textAlignVertical: 'top' })}

        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

        <Pressable accessibilityRole="button" onPress={save} style={styles.save}>
          <Text style={styles.saveText}>저장하기</Text>
        </Pressable>
        {existing && (
          <Pressable accessibilityRole="button" onPress={() => setConfirmDelete(true)} style={styles.del}>
            <Text style={styles.delText}>프로젝트 삭제</Text>
          </Pressable>
        )}
      </ScrollView>

      <DatePickerModal key={`d-${pickDate}`} visible={pickDate} value={f.due || undefined} onPick={(k) => { set('due')(k); setPickDate(false); }} onClose={() => setPickDate(false)} />
      <ConfirmDialog
        visible={confirmDelete}
        title="프로젝트를 삭제할까요?"
        sub="연결된 메모·할 일·파일은 지워지지 않고, 프로젝트와의 연결만 풀려요."
        confirmText="삭제"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          deleteProject(existing.id);
          setConfirmDelete(false);
          navigation.goBack(); // 편집 화면 닫고
          navigation.goBack(); // 지워진 프로젝트의 상세 화면도 닫아 목록으로
        }}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.lg },
  field: { gap: spacing.sm },
  label: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  input: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: spacing.lg, fontSize: font.bodyLg, color: colors.ink },
  pickText: { fontSize: font.bodyLg, color: colors.ink },
  row: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  clear: { minHeight: 46, paddingHorizontal: spacing.md, justifyContent: 'center' },
  clearText: { fontSize: font.body, color: colors.coral, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { minHeight: 38, paddingHorizontal: spacing.lg, borderRadius: 19, justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  chipOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  chipText: { fontSize: font.body, fontWeight: '600', color: colors.ink },
  chipTextOn: { color: colors.white, fontWeight: '800' },
  note: { fontSize: font.caption, color: colors.muted, marginTop: -spacing.sm },
  error: { fontSize: font.body, fontWeight: '700', color: colors.coral },
  save: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  del: { minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: colors.coral, alignItems: 'center', justifyContent: 'center' },
  delText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.coral },
});
