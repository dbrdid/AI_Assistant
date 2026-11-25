// ============================================================
// TaskEditScreen.js — 일정/할 일 추가 · 편집
// ============================================================
// 맨 위에서 [일정 | 할 일]을 고르고, 자주 쓰는 칸만 먼저 보여 줍니다.
//   일정  : 날짜 · 여러 날 · 종일 · 시간 · 알림 · 장소
//   할 일 : 기한 · 시간(선택) · 알림
// 중요도 · 상태 · 담당자 · 프로젝트 · 설명(할 일은 장소도)은 '더보기' 안에 접혀 있습니다.

import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import Icon from '../../../shared/components/Icon';
import { Chip } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { WEEKDAYS_LONG, fromKey, toKey } from '../../calendar/utils/DateUtils';
import { ALARMS, PRIORITIES, STATUSES, addTask, deleteTask, findOverlap, getTask, shiftKey, updateTask } from '../../../data/tasks/TaskStore';
import { DatePickerModal, TimePickerModal } from '../../../shared/components/DateTimePicker';
import { projectOf, setItemProject, useProjects } from '../../../data/projects/ProjectStore';
import { enterSpace, useSpaceInfo, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import { SpaceDot } from '../../../shared/components/SpaceTag';
import {SheetModal} from '../../../shared/components/Motion';

const KINDS = [{ id: 'event', label: '일정' }, { id: 'task', label: '할 일' }];

const dateLabel = (k) => {
  const d = fromKey(k);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS_LONG[d.getDay()]}`;
};

export function Chips({ label, options, value, onChange }) {
  const [open,setOpen]=useState(false);
  return (
    <><Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${value}`} onPress={()=>setOpen(true)} style={styles.line}>
      <Icon name={label==='알림'?'bell':label==='중요도'?'flag':'checkSquare'} size={18} color={colors.muted}/><Text style={styles.lineLabel}>{label}</Text><Text style={styles.lineValue}>{value}</Text><Icon name="chevronDown" size={15} color={colors.muted}/>
    </Pressable><SheetModal visible={open} onClose={()=>setOpen(false)} label={`${label} 선택`}><View style={{flexDirection:"row",alignItems:"center",justifyContent:"space-between",minHeight:44}}><Text style={styles.label}>{label}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${label} 선택 닫기`} onPress={()=>setOpen(false)} style={{minWidth:44,minHeight:44,alignItems:"center",justifyContent:"center"}}><Icon name="x" size={18} color={colors.muted}/></Pressable></View><ScrollView showsVerticalScrollIndicator={false}>{options.map(option=><Pressable key={option} accessibilityRole="radio" accessibilityState={{checked:value===option}} accessibilityLabel={option} onPress={()=>{onChange(option);setOpen(false);}} style={styles.line}><Text style={styles.lineValue}>{option}</Text><View style={{flex:1}}/>{value===option&&<Icon name="check" size={18} color={colors.ink}/>}</Pressable>)}</ScrollView></SheetModal></>
  );
}

// 공간: 다른 속성 줄과 같은 한 줄, 누르면 아래 시트에서 고른다 (Notion 캘린더의 캘린더 선택 줄)
function SpaceLine({ list, spaces, current, onPick }) {
  const [open, setOpen] = useState(false);
  return (
    <><Pressable accessibilityRole="button" accessibilityLabel={`공간: ${current.name}`} onPress={() => setOpen(true)} style={styles.line}>
      <SpaceDot color={spaces[current.id]?.color} /><Text style={styles.lineLabel}>공간</Text><Text style={styles.lineValue} numberOfLines={1}>{current.name}</Text><Icon name="chevronDown" size={15} color={colors.muted} />
    </Pressable><SheetModal visible={open} onClose={() => setOpen(false)} label="공간 선택"><View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 }}><Text style={styles.label}>공간</Text><Pressable accessibilityRole="button" accessibilityLabel="공간 선택 닫기" onPress={() => setOpen(false)} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}><Icon name="x" size={18} color={colors.muted} /></Pressable></View><ScrollView showsVerticalScrollIndicator={false}>{list.map((w) => { const s = spaces[w.id]; const on = w.id === current.id; return <Pressable key={w.id} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: s.readOnly }} accessibilityLabel={s.name} disabled={s.readOnly} onPress={() => { onPick(w.id); setOpen(false); }} style={[styles.line, s.readOnly && { opacity: 0.4 }]}><SpaceDot color={s.color} /><Text style={[styles.lineValue, { flex: 1 }]} numberOfLines={1}>{s.name}</Text>{on && <Icon name="check" size={18} color={colors.ink} />}</Pressable>; })}</ScrollView></SheetModal></>
  );
}

// 장소처럼 짧은 값: 아이콘 + 입력칸 한 줄 (제목 라벨과 placeholder를 겹쳐 쓰지 않는다)
export function FieldLine({ icon, label, ...rest }) {
  return (
    <View style={styles.line}>
      <Icon name={icon} size={18} color={colors.muted} />
      <TextInput style={styles.lineInput} placeholder={label} placeholderTextColor={colors.muted} accessibilityLabel={label} {...rest} />
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

// 아이콘 + 글자 + 오른쪽 값/스위치 한 줄
export function Line({ icon, label, value, onPress, right, muted }) {
  const body = (
    <>
      <Icon name={icon} size={18} color={muted ? colors.muted : colors.mintDark} />
      <Text style={[styles.lineLabel, muted && { color: colors.muted }]} numberOfLines={1}>{label}</Text>
      {value !== undefined && <Text style={styles.lineValue} numberOfLines={1}>{value}</Text>}
      {right}
    </>
  );
  if (!onPress) return <View style={styles.line}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={value ? `${label} ${value}` : label} onPress={onPress} style={({ pressed }) => [styles.line, pressed && { backgroundColor: colors.mintSoft }]}>
      {body}
    </Pressable>
  );
}

const Toggle = ({ value, onValueChange, label }) => (
  <Switch
    accessibilityLabel={label}
    value={value}
    onValueChange={onValueChange}
    trackColor={{ false: colors.line, true: colors.mint }}
    thumbColor={colors.white}
    {...(Platform.OS === 'web' ? { activeThumbColor: colors.white } : {})}
  />
);

export default function TaskEditScreen({ navigation, route }) {
  const params = route?.params || {};
  const existing = params.taskId ? getTask(params.taskId) : null;
  // 공간: 새 항목은 저장할 공간을 고름 (고르면 그 공간으로 바뀌어 프로젝트 목록도 그 공간 것). 편집은 항목의 공간 그대로
  const { list: spaceList, current: currentSpace } = useWorkspaces();
  const spaces = useSpaceInfo();
  useEffect(() => {
    if (!existing && params.workspaceId) enterSpace(params.workspaceId);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 종류: 편집이면 그대로(만든 뒤에는 바꿀 수 없음), 새로 만들면 들어온 곳이 정한 값 (기본 할 일)
  const [kind, setKind] = useState(existing?.kind ?? (params.kind === 'event' ? 'event' : 'task'));
  const isEvent = kind === 'event';
  const [f, setF] = useState(() => ({
    title: existing?.title ?? '',
    date: existing?.date ?? params.date ?? toKey(new Date()),
    endDate: existing?.endDate ?? '',
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
  // 종일: 시간 없는 일정. 새 일정은 시간 있는 쪽으로 시작
  const [allDay, setAllDay] = useState(() => !!existing && existing.kind === 'event' && !existing.start);
  const [multiDay, setMultiDay] = useState(() => !!existing?.endDate);
  // 프로젝트: 이 항목이 들어갈 프로젝트 (한 프로젝트에만 속함). 없으면 null
  const projects = useProjects();
  const [projectId, setProjectId] = useState(() => (existing ? projectOf('tasks', existing.id)?.id ?? null : null));
  // 더보기: 편집할 때 이미 채운 칸이 있으면 펼친 채로 시작
  const [more, setMore] = useState(
    () => !!existing && (existing.priority !== '보통' || existing.status !== '진행 전' || !!existing.assignee || !!existing.desc || !!projectId || (existing.kind !== 'event' && !!existing.place)),
  );

  const [picker, setPicker] = useState(null); // 'date' | 'endDate' | 'start' | 'end' | null
  const [error, setError] = useState('');
  const [overlap, setOverlap] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState(null); // 겹침 확인 뒤 저장할 값

  // 화면 상태(종일·여러 날)를 반영한 저장 값
  const draft = () => ({
    ...f,
    title: f.title.trim(),
    start: isEvent && allDay ? '' : f.start,
    end: isEvent && allDay ? '' : f.end,
    endDate: isEvent && multiDay ? f.endDate : '',
  });

  const persist = (fields) => {
    // project(글자)는 프로젝트 이름을 같이 저장해서 검색에도 걸리게 함
    const v = { ...fields, project: projects.find((p) => p.id === projectId)?.title ?? '' };
    try {
      if (existing) {
        updateTask(existing.id, v);
        setItemProject('tasks', existing.id, projectId);
      } else {
        const t = addTask({ ...v, kind });
        if (projectId) setItemProject('tasks', t.id, projectId);
      }
    } catch (e) {
      return setError(e.code === 'read_only' ? '보기 전용 공간이라 저장할 수 없어요. 다른 공간을 골라 주세요.' : '저장하지 못했어요. 입력한 내용을 확인해 주세요.');
    }
    navigation.goBack();
  };

  const save = () => {
    const v = draft();
    if (!v.title) return setError('제목을 입력해 주세요.');
    if (isEvent && multiDay && (!v.endDate || v.endDate <= v.date)) return setError('끝 날짜는 시작 날짜보다 뒤여야 해요.');
    if (v.end && !v.start) return setError('끝나는 시간만 있을 수 없어요. 시작 시간을 먼저 정해 주세요.');
    if (v.start && v.end && v.end <= v.start && !v.endDate) return setError('끝나는 시간은 시작 시간보다 뒤여야 해요.');
    setError('');
    const clash = v.status === '완료' ? null : findOverlap(v, existing?.id);
    if (clash) {
      setPending(v);
      return setOverlap(clash);
    }
    persist(v);
  };

  const timeBtn = (k, placeholder) => (
    <Pressable accessibilityRole="button" accessibilityLabel={placeholder} onPress={() => setPicker(k)} style={styles.pickBtn}>
      <Icon name="clock" size={18} color={f[k] ? colors.mintDark : colors.muted} />
      <Text style={[styles.pickText, !f[k] && { color: colors.muted }]}>{f[k] || placeholder}</Text>
    </Pressable>
  );
  const timeRow = (
    <View style={styles.timeRow}>
      {timeBtn('start', '시작')}
      <Text style={styles.tilde}>~</Text>
      {timeBtn('end', '끝')}
    </View>
  );

  const title = existing ? (isEvent ? '일정 편집' : '할 일 편집') : '새로 만들기';

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenHeader title={title} onBack={navigation.goBack} right={<Pressable accessibilityRole="button" accessibilityLabel="저장하기" onPress={save} style={styles.headerSave}><Text style={styles.headerSaveText}>저장</Text></Pressable>}/>
      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* ---------- 종류 ---------- */}
        {!existing && <View style={styles.seg} accessibilityRole="tablist">
          {KINDS.map((k) => {
            const on = kind === k.id;
            return (
              <Pressable
                key={k.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: on, disabled: !!existing && !on }}
                disabled={!!existing}
                onPress={() => setKind(k.id)}
                style={[styles.segBtn, on && styles.segOn]}
              >
                <Text style={[styles.segText, on && styles.segTextOn, !!existing && !on && { color: colors.line }]}>{k.label}</Text>
              </Pressable>
            );
          })}
        </View>}

        <TextInput
          accessibilityLabel="제목"
          style={styles.titleInput}
          value={f.title}
          onChangeText={set('title')}
          placeholder="제목"
          placeholderTextColor={colors.muted}
          maxLength={100}
          autoFocus={!existing}
          multiline
        />

        {/* ---------- 날짜, 시간 ---------- */}
        <View style={styles.group}>
          {spaceList.length > 1 && (existing
            ? <Line icon="users" muted label="공간" value={currentSpace.name} />
            : <SpaceLine list={spaceList} spaces={spaces} current={currentSpace} onPick={(id) => { enterSpace(id); setProjectId(null); }} />)}
          <Line icon="calendar" label={isEvent ? (multiDay ? '시작' : '날짜') : '기한'} value={dateLabel(f.date)} onPress={() => setPicker('date')} />
          {isEvent && (
            <Line
              icon="calendar"
              muted={!multiDay}
              label="여러 날"
              right={<Toggle label="여러 날 일정" value={multiDay} onValueChange={(on) => { setMultiDay(on); if (on && (!f.endDate || f.endDate <= f.date)) set('endDate')(shiftKey(f.date, 1)); }} />}
            />
          )}
          {isEvent && multiDay && <Line icon="calendar" label="끝" value={f.endDate ? dateLabel(f.endDate) : '날짜 선택'} onPress={() => setPicker('endDate')} />}
          {isEvent && <Line icon="clock" muted={!allDay} label="종일" right={<Toggle label="종일 일정" value={allDay} onValueChange={setAllDay} />} />}
          {!(isEvent && allDay) && (
            <View style={styles.lineBlock}>

              {timeRow}
            </View>
          )}
        </View>

        <Chips label="알림" options={ALARMS} value={f.alarm} onChange={set('alarm')} />
        {f.alarm !== ALARMS[0] && <Text style={styles.note}>아직 알림은 울리지 않아요. 설정만 저장돼요.</Text>}
        {isEvent && <FieldLine icon="pin" label="장소" value={f.place} onChangeText={set('place')} />}

        {/* ---------- 더보기 ---------- */}
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: more }} onPress={() => setMore((v) => !v)} style={styles.moreBtn}>
          <Icon name="chevronDown" size={18} color={colors.muted} style={more ? styles.flip : undefined} />
          <Text style={styles.moreText}>{more ? '접기' : '더보기'}</Text>
        </Pressable>
        {more && (
          <>
            <View style={styles.field}>
              <Text style={styles.label}>프로젝트</Text>
              {projects.length === 0 ? (
                <Text style={styles.note}>만들어 둔 프로젝트가 없어요. 더보기 › 프로젝트에서 먼저 만들어 주세요.</Text>
              ) : (
                <View style={styles.chipRow}>
                  {[{ id: null, title: '없음' }, ...projects].map((p) => (
                    <Chip key={p.id ?? 'none'} label={p.title} active={projectId === p.id} onPress={() => setProjectId(p.id)} />
                  ))}
                </View>
              )}
            </View>
            {!isEvent && <FieldLine icon="pin" label="장소" value={f.place} onChangeText={set('place')} />}
            <FieldLine icon="users" label="담당자" value={f.assignee} onChangeText={set('assignee')} />
            <Chips label="중요도" options={PRIORITIES} value={f.priority} onChange={set('priority')} />
            <Chips label="상태" options={STATUSES} value={f.status} onChange={set('status')} />
            <Input label="메모" value={f.desc} onChangeText={set('desc')} placeholder="설명" multiline style={[styles.input, { minHeight: 96, textAlignVertical: 'top', paddingTop: 12 }]} />
          </>
        )}

        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}

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
          setF((p) => ({ ...p, date: k, endDate: p.endDate && p.endDate <= k ? shiftKey(k, 1) : p.endDate }));
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />
      <DatePickerModal
        key={`ed-${picker === 'endDate'}`}
        visible={picker === 'endDate'}
        value={f.endDate || shiftKey(f.date, 1)}
        onPick={(k) => {
          set('endDate')(k);
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
          persist(pending);
        }}
      />
      <ConfirmDialog
        visible={confirmDelete}
        title={isEvent ? '일정을 삭제할까요?' : '할 일을 삭제할까요?'}
        sub="삭제하면 복구할 수 없어요."
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

const styles = StyleSheet.create({headerSaveText:{fontSize:16,fontWeight:'600',color:colors.ink},headerSave:{minHeight:44,minWidth:44,paddingHorizontal:8,alignItems:'center',justifyContent:'center'},
  root: { flex: 1, backgroundColor: colors.cream },
  content: {paddingHorizontal:20,paddingBottom:32,gap:10},
  seg: { flexDirection: 'row', gap: 4, marginLeft: -10 },
  segBtn: { minHeight: 44, paddingHorizontal: 10, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.raised },
  segText: { fontSize: 14, fontWeight: '500', color: colors.muted },
  segTextOn: {color:colors.ink},
  spaceLine: {flexDirection:'row',alignItems:'center',gap:6,marginTop:8},
  spacePick: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, maxWidth: 180, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  spacePickOn: { borderColor: colors.actionBorder, backgroundColor: colors.mintSoft },
  spacePickText: { flexShrink: 1, fontSize: font.body, fontWeight: '600', color: colors.ink },
  titleInput: {minHeight:96,borderBottomWidth:0,borderBottomColor:colors.line,fontSize:28,fontWeight:'600',color:colors.ink,paddingHorizontal:2,lineHeight:38,paddingTop:12,paddingBottom:16,textAlignVertical:'top'},
  group: {backgroundColor:'transparent',borderRadius:0,borderWidth:0,borderColor:colors.line,overflow:'hidden'},
  lineInput: { flex: 1, minHeight: 50, fontSize: 15, color: colors.ink, paddingVertical: 0 },
  line: {flexDirection:'row',alignItems:'center',gap:spacing.md,minHeight:52,paddingHorizontal:0,borderBottomWidth:1,borderBottomColor:colors.line},
  lineLabel: {flex:1,fontSize:14,fontWeight:'400',color:colors.muted},
  lineValue: {fontSize:15,color:colors.ink},
  lineBlock: {padding:spacing.md,gap:spacing.sm,paddingHorizontal:0,paddingVertical:12},
  lineHint: {fontSize:font.caption,fontWeight:'400',color:colors.muted,marginLeft:0},
  field: { gap: spacing.sm },
  label: {fontSize:14,fontWeight:'500',color:colors.muted},
  input: {minHeight:46,borderRadius:0,borderWidth:0,borderColor:colors.line,backgroundColor:colors.cream,paddingHorizontal:0,fontSize:font.bodyLg,color:colors.ink,borderBottomWidth:1},
  pickBtn: {flex:1,minHeight:46,flexDirection:'row',alignItems:'center',gap:spacing.sm,borderRadius:0,borderWidth:0,borderColor:colors.line,backgroundColor:colors.cream,paddingHorizontal:0,borderBottomWidth:1},
  pickText: { fontSize: font.bodyLg, color: colors.ink },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tilde: { fontSize: font.bodyLg, color: colors.muted },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  note: {fontSize:font.caption,color:colors.muted,marginTop:0,lineHeight:20},
  moreBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44 },
  moreText: {flex:1,fontSize:13,fontWeight:'400',color:colors.muted},
  flip: { transform: [{ rotate: '180deg' }] },
  error: { fontSize: font.body, fontWeight: '500', color: colors.coral },
  save: { minHeight: 52, borderRadius: radius.card, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  del: {minHeight:48,borderRadius:radius.card,backgroundColor:'transparent',borderWidth:0,borderColor:colors.coral,alignItems:'flex-start',justifyContent:'center'},
  delText: {fontSize:14,fontWeight:'400',color:colors.coral},
});
