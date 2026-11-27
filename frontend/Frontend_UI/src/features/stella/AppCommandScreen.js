import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { maybeRuntime } from '../../integration/runtime';
import { useMemos } from '../../data/memos/MemoStore';
import { ROUTES } from '../../navigation/routes';
import { WorkspaceHeader, PrimaryButton } from './WorkspaceScreen';
import { examples, routeCommand, screens } from './appCommands.mjs';
import { projectExamples, routeProjectCommand } from './projectCommands.mjs';
import { itemExamples } from './itemCommands.mjs';
import { useCommandPlanner } from './InlineCommand';
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
  // AI가 순서대로 제안한 여러 작업: 하나씩 검토·승인하고, 승인하면 다음 작업을 바로 준비한다
  const [queue, setQueue] = useState(() => (route.params?.commands ?? []).slice(1));
  const total = route.params?.commands?.length ?? 1;
  // 검사·계획은 AI 시트의 바로 승인과 같은 것을 쓴다
  const planner = useCommandPlanner(total);
  const owner = planner.owner;
  const canAccess = planner.canAccess();
  const memo = canAccess && memos.find(item => item.id === memoId);
  const planFor = (text, original, target = memoId) => planner.planFor(text, original, target);
  const planStep = (text, original, target = memoId) => planner.planStep(text, original, target);
  function clear() { setPlan(null); setMessage(''); }
  // Device-only evaluation record for untouched model commands; user-typed commands are not AI results.
  const fromModel = useRef(false);
  function feedback(decision, detail = '') {
    if (!fromModel.current) return;
    try { owner.store.recordAiFeedback({ surface: 'command', decision, request: route.params.originalRequest, output: route.params.command, detail }); } catch { /* never blocks the command */ }
  }
  function preview() {
    clear();
    fromModel.current = !!route.params?.originalRequest && input === route.params?.command;
    try {
      if (!canAccess) throw new Error('공간 접근이 변경되었습니다. 화면을 다시 열어 주세요.');
      // A command the user retyped is theirs; only the untouched model output is checked against the original request.
      const started = Date.now();
      setPlan(planStep(input, fromModel.current ? route.params.originalRequest : undefined));
      metrics?.record('approval_card', { ms: Date.now() - started });
    } catch (error) { setMessage(error.message); feedback('failed', error.message); }
  }
  // Clear requests skip the model but keep the same verification, review and approval path.
  function interpret() {
    clear();
    fromModel.current = false;
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
      feedback('accepted');
      if (queue.length) {
        // 다음 작업: 방금 만든 문서가 있으면 그 문서가 대상이 된다
        const [next, ...rest] = queue;
        const target = result?.params?.memoId ?? memoId;
        setQueue(rest); setMemoId(target); setInput(next);
        fromModel.current = !!route.params?.originalRequest;
        try { setPlan(planStep(next, route.params?.originalRequest, target)); }
        catch (error) { setMessage(`${total - rest.length}번째 작업을 준비하지 못했어요: ${error.message}`); }
        return;
      }
      if (result?.route) navigation.navigate(result.route, result.params);
      else setMessage('승인한 변경을 저장했습니다.');
    } catch (error) { setMessage(error.message); feedback('failed', error.message); }
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
      {total > 1 && <Text style={s.note}>{`AI가 제안한 작업 ${total}개 중 ${total - queue.length}번째. 하나씩 확인하고 승인해요.`}</Text>}
      {plan && <View style={s.section}><Text style={s.sectionTitle}>실행할 작업</Text>
        <Text selectable style={s.proposalBody}>{plan.summary}</Text>
        <PrimaryButton label={queue.length ? '승인하고 다음 작업' : '승인하고 실행'} icon="check" onPress={approve} />
        {row(queue.length ? '이 작업과 남은 작업 모두 취소' : '취소', () => { clear(); setQueue([]); })}</View>}
      {!!message && <Text accessibilityRole="alert" style={s.note}>{message}</Text>}
      {row(showHelp ? '사용 예시 닫기' : '지원 작업과 사용 예시', () => setShowHelp(!showHelp))}
      {showHelp && <><Text selectable style={s.proposalBody}>{[...examples, ...projectExamples, ...itemExamples].join('\n')}</Text>
        <Text style={s.note}>화면 열기: {Object.keys(screens).join(', ')}. 파일 선택, 공유, 권한, 결제 및 계정 변경은 해당 화면에서 직접 확인하세요.</Text></>}
    </ScrollView></View>;
}
