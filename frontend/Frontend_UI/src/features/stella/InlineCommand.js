// AI가 제안한 앱 작업을 그 자리(AI 시트·AI 화면)에서 바로 확인하고 승인한다. 다른 화면으로 가지 않는다.
// 검사는 앱 작업 화면과 같다: 모델 명령은 원래 요청의 값만 쓸 수 있고, 승인은 한 번만, 공간·문서가 바뀌면 거절.
// 여러 작업이면 하나씩 보여 주고, 승인하면 다음 작업을 준비한다.
import React, { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { runtime, maybeRuntime, readPreference, writePreference } from '../../integration/runtime';
import { proposeBlocks } from './aiPending.mjs';
import { planCommand } from './appCommands.mjs';
import { splitRequest } from './commandSteps.mjs';
import { planProjectCommand } from './projectCommands.mjs';
import { planDocumentCommand, planItemCommand } from './itemCommands.mjs';
import { addProject, getProjects, setItemProject, updateProject } from '../../data/projects/ProjectStore';
import ReviewActions from '../../shared/components/ReviewActions';
import { styles as s } from './theme';

/** 앱 작업 검토 화면과 함께 쓰는 계획 세우기 (같은 검사) */
export function useCommandPlanner(total = 1) {
  const owner = useRef(runtime()).current;
  const workspaceId = useRef(owner.store.getCurrentWorkspace().id).current;
  const canAccess = () => maybeRuntime() === owner && owner.store.getCurrentWorkspace().id === workspaceId && !owner.closedSpaces.has(workspaceId);
  const canWrite = () => { const ws = owner.store.getCurrentWorkspace(); return canAccess() && (ws.personal || ws.roleCode !== 'VIEWER'); };
  const projectTools = {
    getProjects, addProject, updateProject,
    getTasks: () => owner.store.getTasks(), getTask: id => owner.store.getTask(id),
    setTaskProject: (taskId, projectId) => setItemProject('task', taskId, projectId),
    canWrite,
  };
  const planFor = (text, original, target, rt = owner) => {
    const appPlan = planProjectCommand(projectTools, text, original)
      ?? planDocumentCommand(rt, text, { originalRequest: original, canWrite })
      ?? planItemCommand(rt, text, { memoId: target, originalRequest: original, canWrite });
    if (appPlan) return appPlan;
    const legacy = planCommand(rt, text, target, randomUUID, original);
    const summary = legacy.summary.replace(/(^새 문서 만들기|\n기존 (?:값|내용)) \u00b7 /, '$1, ');
    return { ...legacy, summary };
  };
  // 여러 작업이면 원래 요청을 작업별 조각으로 나눠, 이 작업과 맞는 조각으로 같은 검사를 한다
  const planStep = (text, original, target, rt = owner) => {
    if (!canAccess()) throw new Error('공간 접근이 변경되었습니다. 다시 열어 주세요.');
    if (total <= 1 || !original) return planFor(text, original, target, rt);
    let last;
    for (const part of [...splitRequest(original), original]) { try { return planFor(text, part, target, rt); } catch (error) { last = error; } }
    throw last;
  };
  return { owner, canAccess, planFor, planStep };
}

// 문서 블록을 바꾸는 작업: 바로 저장하지 않고 문서 안에 강조된 제안으로 넣어, 문서에서 수용·거절한다
export const DOCUMENT_BLOCK_COMMAND = /^\d+\s*번\s*블록|^(?:문단|본문|제목|목록|체크|표)\s*블록\s*(?:추가|생성)/;
function draftRuntime(rt, memoId) {
  let draft = null;
  const refuse = () => { throw new Error('문서 블록 작업만 제안으로 넣을 수 있습니다.'); };
  // 앱의 store·documents는 얼어 있어(freeze) 덮어쓸 수 없으므로 복사본을 만든다
  const blocked = names => Object.fromEntries(names.map(name => [name, refuse]));
  const store = { ...rt.store, ...blocked(['addMemo', 'updateMemo', 'addTask', 'updateTask', 'deleteTask', 'setFavorites', 'trashMemo', 'approveProposal']),
    getMemo: id => { const memo = rt.store.getMemo(id); return draft && id === memoId ? { ...memo, revision: memo.revision + 1, title: draft.title } : memo; } };
  const documents = { ...rt.documents, ...blocked(['moveDocument', 'setLink', 'createVersion', 'trash']),
    saveContent: (id, content) => { if (id !== memoId) refuse(); draft = content; },
    blocksFor: memo => (draft && memo.id === memoId ? draft.blocks : rt.documents.blocksFor(memo)) };
  return { rt: { ...rt, store, documents }, result: () => draft };
}

// 화면을 여는 작업과 새로 만드는 작업만 그 화면으로 이동한다. 나머지(블록·할 일 수정 등)는 그 자리에 머문다
const OPENS = /열어\s*줘$|만들기\s*[:：]/;

export default function InlineCommand({ commands, originalRequest, memoId, navigation, onLeave, onApplied }) {
  const { owner, planStep } = useCommandPlanner(commands.length);
  const [placed, setPlaced] = useState(false);
  const proposeInDocument = (i, memoId) => {
    const memo = owner.store.getMemo(memoId);
    if (!memo || memo.deletedAt) throw new Error('문서를 찾을 수 없습니다.');
    const original = owner.documents.blocksFor(memo);
    const draft = draftRuntime(owner, memoId);
    planStep(commands[i], originalRequest, memoId, draft.rt).approve(draft.rt);
    if (!draft.result()) throw new Error('바뀌는 내용이 없습니다.');
    proposeBlocks(owner.documents, memo, original, draft.result().blocks, { read: readPreference, write: writePreference });
  };
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState(memoId);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  const make = (i, memo) => {
    try {
      if (memo && DOCUMENT_BLOCK_COMMAND.test(commands[i])) { proposeInDocument(i, memo); return { placed: true }; }
      return { plan: planStep(commands[i], originalRequest, memo) };
    } catch (error) { return { error: error.message }; }
  };
  // 문서 블록 작업은 그리기 중이 아니라 효과에서 한 번만 넣는다 (저장이 따르므로)
  const [step, setStep] = useState(() => (memoId && DOCUMENT_BLOCK_COMMAND.test(commands[0]) ? { waiting: true } : make(0, memoId)));
  useEffect(() => { if (step.waiting) setStep(make(0, memoId)); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const feedback = (decision, detail = '') => {
    try { owner.store.recordAiFeedback({ surface: 'command', decision, request: originalRequest, output: commands[index], detail }); } catch { /* never blocks */ }
  };
  if (step.error && !message) feedback('failed', step.error);
  useEffect(() => {
    if (!step.placed) return;
    onApplied?.();
    const next = index + 1;
    if (next < commands.length) { setIndex(next); setStep(make(next, target)); return; }
    setPlaced(true);
    onLeave?.();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  function approve() {
    setMessage('');
    try {
      const result = step.plan.approve(maybeRuntime());
      feedback('accepted');
      onApplied?.();   // 열려 있는 편집기가 바뀐 내용을 다시 읽게
      const next = index + 1;
      if (next < commands.length) {
        const memo = result?.params?.memoId ?? target;   // 방금 만든 문서가 있으면 다음 작업의 대상
        setIndex(next); setTarget(memo); setStep(make(next, memo));
        return;
      }
      setDone('적용했어요.');
      if (result?.route && OPENS.test(commands[index])) { onLeave?.(); navigation.navigate(result.route, result.params); }
    } catch (error) { setMessage(error.message); feedback('failed', error.message); }
  }
  if (placed) return <Text accessibilityLiveRegion="polite" style={s.note}>문서에 제안으로 넣었어요. 문서에서 수용하거나 거절해 주세요.</Text>;
  if (done) return <Text accessibilityLiveRegion="polite" style={s.note}>{done}</Text>;
  if (step.placed || step.waiting) return null;
  return <View style={{ gap: 8 }}>
    {commands.length > 1 && <Text style={s.note}>{`작업 ${commands.length}개 중 ${index + 1}번째`}</Text>}
    {step.plan ? <>
      <Text selectable style={s.reviewText}>{step.plan.summary}</Text>
      <ReviewActions actions={[
        { label: commands.length > 1 ? '남은 작업 취소' : '취소', onPress: () => { feedback('rejected'); setDone('작업을 취소했어요.'); } },
        { label: index + 1 < commands.length ? '승인하고 다음' : '승인', onPress: approve, primary: true },
      ]} />
    </> : <Text accessibilityRole="alert" style={s.error}>{step.error}</Text>}
    {!!message && <Text accessibilityRole="alert" style={s.error}>{message}</Text>}
  </View>;
}
