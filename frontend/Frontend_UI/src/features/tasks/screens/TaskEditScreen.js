// ============================================================
// TaskEditScreen.js — 일정/할 일 추가 · 편집
// ============================================================


import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { WEEKDAYS_LONG, fromKey, toKey } from '../../calendar/utils/DateUtils';
import { ALARMS, PRIORITIES, STATUSES, addTask, deleteTask, findOverlap, getTask, updateTask } from '../../../data/tasks/TaskStore';
import { DatePickerModal, TimePickerModal } from '../../../shared/components/DateTimePicker';
import { projectOf, setItemProject, useProjects } from '../../../data/projects/ProjectStore';

const dateLabel = (k) => {
  const d = fromKey(k);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS_LONG[d.getDay()]}`;
};

function Chips({ label, options, value, onChange }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.chipRow}>
        {options.map((o) => (
          <Pressable
            key={o}
            accessibilityRole="button"
            accessibilityState={{ selected: value === o }}
            onPress={() => onChange(o)}
            style={[styles.chip, value === o && styles.chipOn]}
          >
            <Text style={[styles.chipText, value === o && styles.chipTextOn]}>{o}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Input({ label, ...rest }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor={colors.muted} accessibilityLabel={label} {...rest} />
    </View>
  );
}

export default function TaskEditScreen({ navigation, route }) {
  const params = route?.params || {};
  const existing = params.taskId ? getTask(params.taskId) : null;

  const [f, setF] = useState(() => ({
    title: existing?.title ?? '',
    date: existing?.date ?? params.date ?? toKey(new Date()),
    start: existing?.start ?? '',
    end: existing?.end ?? '',
    priority: existing?.priority ?? '보통',
    status: existing?.status ?? '진행 전',
    alarm: existing?.alarm ?? '없음',
    assignee: existing?.assignee ?? '',
    place: existing?.place ?? '',
    project: existing?.project ?? '',
    desc: existing?.desc ?? '',
  }));
  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }));
  // 프로젝트: 이 항목이 들어갈 프로젝트 (한 프로젝트에만 속함). 없으면 null
  const projects = useProjects();
  const [projectId, setProjectId] = useState(() => (existing ? projectOf('tasks', existing.id)?.id ?? null : null));

  const [picker, setPicker] = useState(null); // 'date' | 'start' | 'end' | null
  const [error, setError] = useState('');
  const [overlap, setOverlap] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const persist = () => {
    // project(글자)는 프로젝트 이름을 같이 저장해서 검색에도 걸리게 함
    const fields = { ...f, title: f.title.trim(), project: projects.find((p) => p.id === projectId)?.title ?? '' };
    if (existing) {
      updateTask(existing.id, fields);
      setItemProject('tasks', existing.id, projectId);
    } else {
      const t = addTask(fields);
      if (projectId) setItemProject('tasks', t.id, projectId);
    }
    navigation.goBack();
  };

  const save = () => {
    if (!f.title.trim()) return setError('제목을 입력해 주세요.');
    if (f.end && !f.start) return setError('끝나는 시간만 있을 수 없어요. 시작 시간을 먼저 정해 주세요.');
    if (f.start && f.end && f.end <= f.start) return setError('끝나는 시간은 시작 시간보다 뒤여야 해요.');
    setError('');
    const clash = f.status === '완료' ? null : findOverlap(f, existing?.id);
    if (clash) return setOverlap(clash);
    persist();
  };

  const timeBtn = (k, placeholder) => (
    <Pressable accessibilityRole="button" accessibilityLabel={placeholder} onPress={() => setPicker(k)} style={styles.pickBtn}>
      <Text style={[styles.pickText, !f[k] && { color: colors.muted }]}>{f[k] || placeholder}</Text>
    </Pressable>
  );

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title={existing ? '일정 편집' : '일정 추가'} onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Input label="제목 *" value={f.title} onChangeText={set('title')} placeholder="무엇을 할까요?" maxLength={100} />

        <View style={styles.field}>
          <Text style={styles.label}>날짜 *</Text>
          <Pressable accessibilityRole="button" onPress={() => setPicker('date')} style={styles.pickBtn}>
            <Text style={styles.pickText}>{dateLabel(f.date)}</Text>
          </Pressable>
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>시간 (선택)</Text>
          <View style={styles.timeRow}>
            {timeBtn('start', '시작')}
            <Text style={styles.tilde}>~</Text>
            {timeBtn('end', '끝')}
          </View>
        </View>

        <Chips label="중요도" options={PRIORITIES} value={f.priority} onChange={set('priority')} />
        <Chips label="상태" options={STATUSES} value={f.status} onChange={set('status')} />
        <Chips label="알림" options={ALARMS} value={f.alarm} onChange={set('alarm')} />
        <Text style={styles.note}>알림 설정은 저장만 되고, 실제 알림은 추후 지원돼요.</Text>

        <Input label="담당자" value={f.assignee} onChangeText={set('assignee')} placeholder="담당자" />
        <Input label="장소" value={f.place} onChangeText={set('place')} placeholder="장소" />
        <View style={styles.field}>
          <Text style={styles.label}>프로젝트</Text>
          {projects.length === 0 ? (
            <Text style={styles.note}>만들어 둔 프로젝트가 없어요. 프로젝트 메뉴에서 먼저 만들어 주세요.</Text>
          ) : (
            <View style={styles.chipRow}>
              {[{ id: null, title: '없음' }, ...projects].map((p) => (
                <Pressable key={p.id ?? 'none'} accessibilityRole="button" accessibilityState={{ selected: projectId === p.id }} onPress={() => setProjectId(p.id)} style={[styles.chip, projectId === p.id && styles.chipOn]}>
                  <Text style={[styles.chipText, projectId === p.id && styles.chipTextOn]} numberOfLines={1}>{p.title}</Text>
                </Pressable>
              ))}
            </View>
          )}
        </View>
        <Input label="설명" value={f.desc} onChangeText={set('desc')} placeholder="설명" multiline style={[styles.input, { minHeight: 96, textAlignVertical: 'top' }]} />

        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

        <Pressable accessibilityRole="button" onPress={save} style={styles.save}>
          <Text style={styles.saveText}>저장하기</Text>
        </Pressable>
        {existing && (
          <Pressable accessibilityRole="button" onPress={() => setConfirmDelete(true)} style={styles.del}>
            <Text style={styles.delText}>삭제</Text>
          </Pressable>
        )}
      </ScrollView>

      <DatePickerModal
        key={`d-${picker === 'date'}`}
        visible={picker === 'date'}
        value={f.date}
        onPick={(k) => {
          set('date')(k);
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <TimePickerModal
        key={`s-${picker === 'start'}`}
        visible={picker === 'start'}
        title="시작 시간"
        value={f.start}
        onPick={(v) => {
          set('start')(v);
          setPicker(null);
        }}
        onClear={() => {
          setF((p) => ({ ...p, start: '', end: '' }));
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <TimePickerModal
        key={`e-${picker === 'end'}`}
        visible={picker === 'end'}
        title="끝나는 시간"
        value={f.end}
        onPick={(v) => {
          set('end')(v);
          setPicker(null);
        }}
        onClear={() => {
          set('end')('');
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />

      <ConfirmDialog
        visible={!!overlap}
        title="다른 일정과 시간이 겹쳐요"
        sub={overlap ? `${overlap.title}와 시간이 겹쳐요. 그래도 저장할까요?` : ''}
        confirmText="저장"
        onCancel={() => setOverlap(null)}
        onConfirm={() => {
          setOverlap(null);
          persist();
        }}
      />
      <ConfirmDialog
        visible={confirmDelete}
        title="일정을 삭제할까요?"
        sub="삭제한 일정은 복구할 수 없어요."
        confirmText="삭제"
        danger
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          deleteTask(existing.id);
          setConfirmDelete(false);
          navigation.goBack();
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
  pickBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: spacing.lg, justifyContent: 'center' },
  pickText: { fontSize: font.bodyLg, color: colors.ink },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tilde: { fontSize: font.bodyLg, color: colors.muted },
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
