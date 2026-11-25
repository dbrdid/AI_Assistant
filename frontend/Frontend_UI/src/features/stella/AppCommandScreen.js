import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { runtime, maybeRuntime } from '../../integration/runtime';
import { useMemos } from '../../data/memos/MemoStore';
import { ROUTES } from '../../navigation/routes';
import { WorkspaceHeader, PrimaryButton } from './WorkspaceScreen';
import { examples, planCommand, routeCommand, screens } from './appCommands.mjs';
import { planProjectCommand, projectExamples, routeProjectCommand } from './projectCommands.mjs';
import { addProject, getProjects, setItemProject, updateProject } from '../../data/projects/ProjectStore';
import { metrics } from '../../integration/s22Gate';
import { palette as c, styles as s } from './theme';

export default function AppCommandScreen({ navigation, route }) {
  const memos = useMemos();
  const [memoId, setMemoId] = useState(route.params?.memoId);
  const [input, setInput] = useState(route.params?.command ?? '');
  const [plan, setPlan] = useState(null);
  const [message, setMessage] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const owner = useRef(runtime()).current;
  const workspaceId = useRef(owner.store.getCurrentWorkspace().id).current;
  const canAccess = maybeRuntime() === owner && owner.store.getCurrentWorkspace().id === workspaceId && !owner.closedSpaces.has(workspaceId);
  const memo = canAccess && memos.find(item => item.id === memoId);
  const projectTools = {
    getProjects, addProject, updateProject,
    getTasks: () => owner.store.getTasks(), getTask: id => owner.store.getTask(id),
    setTaskProject: (taskId, projectId) => setItemProject('task', taskId, projectId),
    canWrite: () => {
      const ws = owner.store.getCurrentWorkspace();
      return maybeRuntime() === owner && ws.id === workspaceId && !owner.closedSpaces.has(workspaceId) && (ws.personal || ws.roleCode !== 'VIEWER');
    },
  };
  const planFor = (text, original) => planProjectCommand(projectTools, text, original) ?? planCommand(owner, text, memoId, randomUUID, original);
  function clear() { setPlan(null); setMessage(''); }
  function preview() {
    clear();
    try {
      if (!canAccess) throw new Error('공간 접근이 변경되었습니다. 화면을 다시 열어 주세요.');
      // A command the user retyped is theirs; only the untouched model output is checked against the original request.
      const started = Date.now();
      setPlan(planFor(input, input === route.params?.command ? route.params?.originalRequest : undefined));
      metrics?.record('approval_card', { ms: Date.now() - started });
    } catch (error) { setMessage(error.message); }
  }
  // Clear requests skip the model but keep the same verification, review and approval path.
  function interpret() {
    clear();
    const project = routeProjectCommand(input);
    const routed = project.command ? project : routeCommand(input);
    if (routed.clarify) { setMessage(routed.clarify); return; }
    if (!routed.command) { navigation.navigate(ROUTES.LocalModel, { commandRequest: input, memoId }); return; }
    try {
      if (!canAccess) throw new Error('공간 접근이 변경되었습니다. 화면을 다시 열어 주세요.');
      setPlan(planFor(routed.command, input));
    } catch (error) { setMessage(error.message); }
  }
  function approve() {
    clear();
    try {
      const result = plan.approve(maybeRuntime());
      if (result?.route) navigation.navigate(result.route, result.params);
      else setMessage('승인한 변경을 저장했습니다.');
    } catch (error) { setMessage(error.message); }
  }
  function row(label, onPress) {
    return <Pressable accessibilityRole="button" onPress={onPress} style={s.menuRow}><Text style={s.menuLabel}>{label}</Text></Pressable>;
  }
  return <View style={s.root}><WorkspaceHeader title="앱 작업 요청" onBack={navigation.goBack} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.page}>
      {!!route.params?.originalRequest && <Text selectable style={s.note}>원래 요청: {route.params.originalRequest}</Text>}
      {row('대상 문서: ' + (memo?.title || (memo ? '제목 없는 문서' : '선택하기')), () => setShowPicker(!showPicker))}
      {canAccess && showPicker && memos.map(item => <View key={item.id}>{row(item.title || '제목 없는 문서', () => {
        clear(); setMemoId(item.id); setShowPicker(false);
      })}</View>)}
      {memo && <Text style={s.note}>{owner.documents.blocksFor(memo).map((block, i) => (i + 1) + '. ' + (block.type === 'table' ? '표' : block.text.slice(0, 45))).join('\n')}</Text>}
      <TextInput accessibilityLabel="앱 작업 요청" placeholder="제목 블록 추가: 결정 사항" placeholderTextColor={c.subtle}
        style={[s.editorBody, { minHeight: 90 }]} maxLength={2000} multiline value={input}
        onChangeText={value => { clear(); setInput(value); }} />
      <PrimaryButton label="작업 검토" icon="checkSquare" disabled={!input.trim()} onPress={preview} />
      {row('자연어 요청 해석', interpret)}
      {plan && <View style={s.section}><Text style={s.sectionTitle}>실행할 작업</Text>
        <Text selectable style={s.proposalBody}>{plan.summary}</Text>
        <PrimaryButton label="승인하고 실행" icon="check" onPress={approve} />{row('취소', clear)}</View>}
      {!!message && <Text accessibilityRole="alert" style={s.note}>{message}</Text>}
      {row(showHelp ? '사용 예시 닫기' : '지원 작업과 사용 예시', () => setShowHelp(!showHelp))}
      {showHelp && <><Text selectable style={s.proposalBody}>{[...examples, ...projectExamples].join('\n')}</Text>
        <Text style={s.note}>화면 열기: {Object.keys(screens).join(', ')}. 파일 선택, 공유, 권한, 결제 및 계정 변경은 해당 화면에서 직접 확인하세요.</Text></>}
    </ScrollView></View>;
}
