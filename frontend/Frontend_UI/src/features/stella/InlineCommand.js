// AI가 제안한 앱 작업을 그 자리(AI 시트·AI 화면)에서 바로 확인하고 승인한다. 다른 화면으로 가지 않는다.
// 검사는 앱 작업 화면과 같다: 모델 명령은 원래 요청의 값만 쓸 수 있고, 승인은 한 번만, 공간·문서가 바뀌면 거절.
// 여러 작업이면 하나씩 보여 주고, 승인하면 다음 작업을 준비한다.
import React, { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { runtime, maybeRuntime } from '../../integration/runtime';
import { planCommand } from './appCommands.mjs';
import { splitRequest } from './commandSteps.mjs';
import { planProjectCommand } from './projectCommands.mjs';
import { planItemCommand } from './itemCommands.mjs';
import { addProject, getProjects, setItemProject, updateProject } from '../../data/projects/ProjectStore';
import Icon from '../../shared/components/Icon';
import { palette as c, styles as s } from './theme';

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
  const planFor = (text, original, target) => planProjectCommand(projectTools, text, original)
    ?? planItemCommand(owner, text, { memoId: target, originalRequest: original, canWrite })
    ?? planCommand(owner, text, target, randomUUID, original);
  // 여러 작업이면 원래 요청을 작업별 조각으로 나눠, 이 작업과 맞는 조각으로 같은 검사를 한다
  const planStep = (text, original, target) => {
    if (!canAccess()) throw new Error('공간 접근이 변경되었습니다. 다시 열어 주세요.');
    if (total <= 1 || !original) return planFor(text, original, target);
    let last;
    for (const part of [...splitRequest(original), original]) { try { return planFor(text, part, target); } catch (error) { last = error; } }
    throw last;
  };
  return { owner, canAccess, planFor, planStep };
}

// 화면을 여는 작업과 새로 만드는 작업만 그 화면으로 이동한다. 나머지(블록·할 일 수정 등)는 그 자리에 머문다
const OPENS = /열어\s*줘$|만들기\s*[:：]/;

export default function InlineCommand({ commands, originalRequest, memoId, navigation, onLeave, onApplied }) {
  const { owner, planStep } = useCommandPlanner(commands.length);
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState(memoId);
  const [message, setMessage] = useState('');
  const [done, setDone] = useState(false);
  const make = (i, memo) => { try { return { plan: planStep(commands[i], originalRequest, memo) }; } catch (error) { return { error: error.message }; } };
  const [step, setStep] = useState(() => make(0, memoId));
  const feedback = (decision, detail = '') => {
    try { owner.store.recordAiFeedback({ surface: 'command', decision, request: originalRequest, output: commands[index], detail }); } catch { /* never blocks */ }
  };
  if (step.error && !message) feedback('failed', step.error);
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
      setDone(true);
      if (result?.route && OPENS.test(commands[index])) { onLeave?.(); navigation.navigate(result.route, result.params); }
    } catch (error) { setMessage(error.message); feedback('failed', error.message); }
  }
  const row = (icon, label, onPress, strong) => <Pressable accessibilityRole="button" onPress={onPress} style={strong ? s.aiSend : s.aiGhost}>
    <Icon name={icon} size={15} color={c.text} /><Text style={strong ? s.aiSendText : s.aiGhostText}>{label}</Text></Pressable>;
  if (done) return <Text accessibilityLiveRegion="polite" style={s.note}>적용했어요.</Text>;
  return <View style={{ gap: 8 }}>
    {commands.length > 1 && <Text style={s.note}>{`작업 ${commands.length}개 중 ${index + 1}번째`}</Text>}
    {step.plan ? <>
      <Text selectable style={s.proposalBody}>{step.plan.summary}</Text>
      <View style={s.aiActions}>
        {row('check', index + 1 < commands.length ? '승인하고 다음' : '승인', approve, true)}
        {row('x', commands.length > 1 ? '모두 취소' : '취소', () => setDone(true))}
      </View>
    </> : <Text accessibilityRole="alert" style={s.error}>{step.error}</Text>}
    {!!message && <Text accessibilityRole="alert" style={s.error}>{message}</Text>}
  </View>;
}
