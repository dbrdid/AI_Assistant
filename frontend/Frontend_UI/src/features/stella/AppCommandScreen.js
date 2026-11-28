import React, { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import ReviewActions from '../../shared/components/ReviewActions';
import { maybeRuntime, readPreference } from '../../integration/runtime';
import { itemAccessOf } from '../../data/projects/ProjectStore';
import { useMemos } from '../../data/memos/MemoStore';
import { ROUTES } from '../../navigation/routes';
import { WorkspaceHeader } from './WorkspaceScreen';
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
  function clear() { setPlan(null); setMessage(''); setDidApply(false); }
  // Device-only evaluation record for untouched model commands; user-typed commands are not AI results.
  const fromModel = useRef(false);
  const applying = useRef(false);
  const [isApplying, setIsApplying] = useState(false);
  const [didApply, setDidApply] = useState(false);
  const chatRequest = route.params?.fromChat;
  const checkChatContext = () => {
    if (!chatRequest) return;
    const space = owner.store.getCurrentWorkspace();
    if (!planner.canAccess() || space.id !== chatRequest.workspaceId || owner.session.id !== chatRequest.accountId) {
      throw new Error('요청한 공간에서 작업을 다시 열어 주세요.');
    }
    if (route.params.memoId) {
      const memo = owner.store.getMemo(route.params.memoId);
      if (!memo || memo.deletedAt || memo.revision !== chatRequest.revision) throw new Error('문서가 바뀌었어요. 작업을 다시 요청해 주세요.');
    }
  };
  function feedback(decision, detail = '') {
    if (!fromModel.current) return;
    try { owner.store.recordAiFeedback({ surface: 'command', decision, request: route.params.originalRequest, output: route.params.command, detail }); } catch { /* never blocks the command */ }
  }
  function preview() {
    Keyboard.dismiss();
    clear();
    fromModel.current = !chatRequest && !!route.params?.originalRequest && input === route.params?.command;
    try {
      checkChatContext();
      if (!canAccess) throw new Error('공간 접근이 변경되었습니다. 화면을 다시 열어 주세요.');
      // A command the user retyped is theirs; only the untouched model output is checked against the original request.
      const started = Date.now();
      const original = route.params?.originalRequest;
      setPlan(planStep(input, fromModel.current || (chatRequest && original !== input) ? original : undefined));
      metrics?.record('approval_card', { ms: Date.now() - started });
    } catch (error) { setMessage(error.message); feedback('failed', error.message); }
  }
  useEffect(() => { if (chatRequest || route.params?.command) preview(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
  async function approve() {
    if (applying.current || !plan) return;
    applying.current = true;
    setIsApplying(true);
    try {
      checkChatContext();
      const target = plan.taskId ? ['task', plan.taskId] : memoId ? ['memo', memoId] : null;
      if (target && (readPreference(`ai-excluded:${target[1]}`, false) && chatRequest ||
          ['view', 'unknown'].includes(await itemAccessOf(...target)))) throw new Error('이 항목에 대한 변경 권한을 확인해 주세요.');
      checkChatContext();
      if (!planner.canAccess()) throw new Error('공간 접근이 변경되었습니다.');
      clear();
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
      else { setDidApply(true); setMessage('승인한 변경을 저장했습니다.'); }
    } catch (error) { clear(); setMessage(error.message); feedback('failed', error.message); }
    finally { applying.current = false; setIsApplying(false); }
  }
  function cancel() {
    if (applying.current) return;
    feedback('rejected');
    if (chatRequest) { navigation.goBack(); return; }
    clear();
    setQueue([]);
  }
  function row(label, onPress) {
    return <Pressable accessibilityRole="button" onPress={onPress} style={s.menuRow}><Text style={s.menuLabel}>{label}</Text></Pressable>;
  }
  return <KeyboardAvoidingView style={s.root} behavior="padding">
    <WorkspaceHeader title={chatRequest ? '작업 검토' : '앱 작업 요청'} onBack={() => { if (!applying.current) navigation.goBack(); }} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.page}>
      {plan && <View style={s.reviewDetail}>
        {total > 1 && <Text style={s.meta}>{`${total - queue.length} / ${total} 작업`}</Text>}
        <Text accessibilityRole="header" style={s.sectionTitle}>실행할 작업</Text>
        <Text selectable style={s.reviewText}>{plan.summary}</Text>
        {memo && !plan.summary.startsWith(memo.title || '제목 없는 문서') && <Text style={s.meta}>{memo.title || '제목 없는 문서'}</Text>}
        <ReviewActions actions={[
          { label: queue.length ? '남은 작업 취소' : '취소', onPress: cancel, disabled: isApplying },
          { label: queue.length ? '승인하고 다음 작업' : '승인하고 실행', onPress: approve, primary: true, disabled: isApplying },
        ]} />
      </View>}
      {!!message && <Text accessibilityRole={didApply ? undefined : 'alert'} accessibilityLiveRegion="polite" style={didApply ? s.note : s.error}>{message}</Text>}
      {!chatRequest && !plan && <>
        {row('대상 문서: ' + (memo?.title || (memo ? '제목 없는 문서' : '선택하기')), () => setShowPicker(!showPicker))}
        {canAccess && showPicker && memos.map(item => <View key={item.id}>{row(item.title || '제목 없는 문서', () => {
          clear(); setMemoId(item.id); setShowPicker(false);
        })}</View>)}
        {memo && <Text style={s.note}>{owner.documents.blocksFor(memo).map((block, i) => (i + 1) + '. ' + (block.type === 'table' ? '표' : block.text.slice(0, 45))).join('\n')}</Text>}
        <TextInput accessibilityLabel="앱 작업 요청" placeholder="제목 블록 추가: 결정 사항" placeholderTextColor={c.subtle}
          style={s.promptBox} maxLength={2000} multiline value={input}
          onChangeText={value => { clear(); setInput(value); }} />
        <ReviewActions actions={[
          { label: '자연어 요청 해석', disabled: !input.trim(), onPress: interpret },
          { label: '작업 검토', disabled: !input.trim(), onPress: preview, primary: true },
        ]} />
        {row(showHelp ? '사용 예시 닫기' : '지원 작업과 사용 예시', () => setShowHelp(!showHelp))}
        {showHelp && <><Text selectable style={s.proposalBody}>{[...examples, ...projectExamples, ...itemExamples].join('\n')}</Text>
          <Text style={s.note}>화면 열기: {Object.keys(screens).join(', ')}. 파일 선택, 공유, 권한, 결제 및 계정 변경은 해당 화면에서 직접 확인하세요.</Text></>}
      </>}
    </ScrollView>
  </KeyboardAvoidingView>;
}
