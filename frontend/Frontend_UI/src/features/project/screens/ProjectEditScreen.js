// ============================================================
// ProjectEditScreen.js — 프로젝트 추가 / 편집
// ============================================================

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Icon from '../../../shared/components/Icon';
import { Chips, FieldLine, Line } from '../../tasks/screens/TaskEditScreen';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { fromKey } from '../../calendar/utils/DateUtils';
import { ALARMS, PRIORITIES } from '../../../data/tasks/TaskStore';
import { PROJECT_STATUSES, addProject, deleteProject, getProject, updateProject } from '../../../data/projects/ProjectStore';
import { DatePickerModal } from '../../../shared/components/DateTimePicker';

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
      if (!updateProject(existing.id, fields)) return;
      navigation.goBack();
    } else {
      const p = addProject(fields);
      if (!p) return; // 저장 실패는 저장소가 안내
      // 만든 프로젝트의 상세 화면으로 (뒤로가기 하면 목록)
      navigation.goBack();
      setTimeout(() => navigation.navigate(ROUTES.ProjectDetail, { projectId: p.id }), 0);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding">
      <ScreenHeader title={existing ? '프로젝트 편집' : '새 프로젝트'} onBack={navigation.goBack} right={<Pressable accessibilityRole="button" accessibilityLabel="저장하기" onPress={save} style={styles.headerSave}><Text style={styles.headerSaveText}>저장</Text></Pressable>} />
      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <TextInput style={styles.titleInput} value={f.title} onChangeText={set('title')} placeholder="제목" placeholderTextColor={colors.muted} maxLength={60} accessibilityLabel="제목" autoFocus={!existing} multiline />

        <View>
          <Line icon="calendar" label="마감일" value={f.due ? `${fromKey(f.due).getFullYear()}년 ${fromKey(f.due).getMonth() + 1}월 ${fromKey(f.due).getDate()}일` : '없음'} onPress={() => setPickDate(true)} right={f.due ? <Pressable accessibilityRole="button" accessibilityLabel="마감일 지우기" onPress={() => set('due')('')} hitSlop={8} style={styles.clear}><Icon name="x" size={16} color={colors.muted} /></Pressable> : null} />
          <Chips label="중요도" options={PRIORITIES} value={f.priority} onChange={set('priority')} />
          <Chips label="상태" options={PROJECT_STATUSES} value={f.status} onChange={set('status')} />
          <Chips label="알림" options={ALARMS} value={f.alarm} onChange={set('alarm')} />
          <FieldLine icon="users" label="담당자" value={f.assignee} onChangeText={set('assignee')} />
          <FieldLine icon="pin" label="장소" value={f.place} onChangeText={set('place')} />
        </View>
        {f.alarm !== ALARMS[0] && <Text style={styles.note}>마감일 아침 9시에 알려 드려요.</Text>}
        <TextInput style={styles.desc} value={f.desc} onChangeText={set('desc')} placeholder="설명" placeholderTextColor={colors.muted} accessibilityLabel="설명" multiline />

        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
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
        sub="연결된 메모, 할 일, 파일은 지워지지 않고, 프로젝트와의 연결만 풀려요."
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
  content: { paddingHorizontal: 20, paddingBottom: spacing.xxl, gap: 10 },
  headerSave: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center' },
  headerSaveText: { fontSize: 16, fontWeight: '600', color: colors.ink },
  titleInput: { minHeight: 72, fontSize: 28, fontWeight: '600', color: colors.ink, paddingHorizontal: 2, lineHeight: 38, paddingTop: 12, paddingBottom: 8, textAlignVertical: 'top' },
  clear: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  desc: { minHeight: 96, fontSize: font.bodyLg, color: colors.ink, textAlignVertical: 'top', paddingTop: 12 },
  note: { fontSize: font.caption, color: colors.muted },
  error: { fontSize: font.body, fontWeight: '500', color: colors.coral },
  del: { minHeight: 48, justifyContent: 'center' },
  delText: { fontSize: 14, color: colors.coral },
});
