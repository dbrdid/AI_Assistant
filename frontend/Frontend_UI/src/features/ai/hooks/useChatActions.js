// useChatActions.js — AI 채팅 승인 카드(할 일/일정·프로젝트·문서 초안·명령) 생성 및 인라인 승인 핸들러
import { useCallback } from 'react';
import { Keyboard } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { aiPolicy, maybeRuntime, runtime, writePreference } from '../../../integration/runtime';
import { readPreference } from '../../../data/hooks';
import { createAiDocument } from '../../stella/aiPending.mjs';
import { planCommand } from '../../stella/appCommands.mjs';
import { planProjectCommand } from '../../stella/projectCommands.mjs';
import { planDocumentCommand, planItemCommand } from '../../stella/itemCommands.mjs';
import { nextField } from '../projectTemplate.mjs';
import { addProject, getProjects, itemAccessOf, projectScope, queryProjects, saveProject, setItemProject, updateProject } from '../../../data/projects/ProjectStore';
import { findOverlap, queryTasks, saveTask, taskScope } from '../../../data/tasks/TaskStore';
import { taskSnapshot } from '../../../data/tasks/taskOperations.mjs';
import { planProjectBrief } from '../chatWorkflows.mjs';
import { ROUTES } from '../../../navigation/routes';
import { todayIn } from '../../../lib/stella/ai-chat';

function resolveChatCommandPlan(own, { command, originalRequest, memoId, scope, revision }) {
  const space = own.store.getCurrentWorkspace();
  if (maybeRuntime() !== own || space.id !== scope.workspaceId || own.session.id !== scope.accountId || own.closedSpaces.has(scope.workspaceId)) {
    throw new Error('요청한 공간에서 작업을 다시 실행해 주세요.');
  }
  if (memoId) {
    const memo = own.store.getMemo(memoId);
    if (!memo || memo.deletedAt || memo.revision !== revision) {
      throw new Error('문서가 바뀌었어요. 작업을 다시 요청해 주세요.');
    }
  }
  const canWrite = () => {
    const ws = own.store.getCurrentWorkspace();
    return maybeRuntime() === own && ws.id === scope.workspaceId && !own.closedSpaces.has(scope.workspaceId) && (ws.personal || ws.roleCode !== 'VIEWER');
  };
  const projectTools = {
    getProjects, addProject, updateProject,
    getTasks: () => own.store.getTasks(),
    getTask: id => own.store.getTask(id),
    setTaskProject: (taskId, projectId) => setItemProject('task', taskId, projectId),
    canWrite,
  };
  const original = originalRequest && originalRequest !== command ? originalRequest : undefined;
  const appPlan = planProjectCommand(projectTools, command, original)
    ?? planDocumentCommand(own, command, { originalRequest: original, canWrite })
    ?? planItemCommand(own, command, { memoId, originalRequest: original, canWrite });
  if (appPlan) return appPlan;
  const legacy = planCommand(own, command, memoId, randomUUID, original);
  const summary = legacy.summary.replace(/(^새 문서 만들기|\n기존 (?:값|내용)) \u00b7 /, '$1, ');
  return { ...legacy, summary };
}

export function buildCommandApprovalDraft(commandSpec) {
  if (!commandSpec?.command) return null;
  const own = runtime();
  try {
    const plan = resolveChatCommandPlan(own, commandSpec);
    const memo = commandSpec.memoId ? own.store.getMemo(commandSpec.memoId) : null;
    return {
      text: '실행할 작업을 확인해 주세요.',
      chatCommand: {
        ...commandSpec,
        summary: plan.summary,
        taskId: plan.taskId ?? null,
        memoTitle: memo ? (memo.title || '제목 없는 문서') : '',
      },
    };
  } catch (error) {
    return { text: error.message, chatCommand: null };
  }
}

export function buildTaskApprovalDraft(taskAction) {
  if (!taskAction) return null;
  const candidates = taskAction.action === 'change'
    ? queryTasks({ ...(taskAction.kind && { kind: taskAction.kind }), title: taskAction.title })
      .filter(task => !readPreference(`ai-excluded:${task.id}`, false))
      .map(taskSnapshot)
    : [];
  const canDraft = !taskAction.error && (taskAction.action === 'create' || candidates.length > 0);
  const form = canDraft ? {
    ...taskAction,
    candidates,
    scope: taskScope(),
    target: candidates.length === 1 ? candidates[0] : null,
    ...(taskAction.action === 'create' && {
      creationId: randomUUID(),
      overlap: Boolean(findOverlap({ ...taskAction.fields, start: taskAction.fields.start ?? '', end: '' })),
    }),
  } : null;
  const text = taskAction.error || (form ? '저장할 내용을 확인해 주세요.' : '현재 공간에서 해당 항목을 찾지 못했어요.');
  return { form, text };
}

export default function useChatActions({ messages, setMessages, dirty, actionSaves, setBanner, navigateFromChat }) {
  const onCommand = useCallback(async (message, action) => {
    const form = message.chatCommand;
    if (!form) return;
    if (action === 'open' && form.resultRoute) {
      return navigateFromChat(form.resultRoute, form.resultParams);
    }
    if (actionSaves.current.has(message.id) || form.cancelled || form.applied || form.error) return;
    if (action === 'cancel') {
      dirty.current = true;
      setMessages(previous => previous.map(entry => (entry.id === message.id
        ? { ...entry, chatCommand: { ...form, cancelled: true } }
        : entry)));
      return;
    }
    if (action !== 'approve') return;
    Keyboard.dismiss();
    actionSaves.current.add(message.id);
    setMessages(previous => previous.map(entry => (entry.id === message.id
      ? { ...entry, chatCommand: { ...form, applying: true } }
      : entry)));
    try {
      const own = runtime();
      const plan = resolveChatCommandPlan(own, form);
      const target = plan.taskId ? ['task', plan.taskId] : form.memoId ? ['memo', form.memoId] : null;
      if (target && (readPreference(`ai-excluded:${target[1]}`, false) || ['view', 'unknown'].includes(await itemAccessOf(...target)))) {
        throw new Error('이 항목에 대한 변경 권한을 확인해 주세요.');
      }
      const verified = resolveChatCommandPlan(own, form);
      const result = verified.approve(maybeRuntime());
      const resultRoute = result?.route ?? (form.memoId ? ROUTES.MemoEdit : null);
      const resultParams = result?.params ?? (form.memoId ? { memoId: form.memoId } : undefined);
      const openLabel = resultRoute === ROUTES.MemoEdit ? '문서 열기'
        : resultRoute === ROUTES.TaskEdit ? '항목 열기'
        : resultRoute === ROUTES.ProjectDetail ? '프로젝트 열기' : '결과 열기';
      dirty.current = true;
      setMessages(previous => previous.map(entry => (entry.id === message.id
        ? { ...entry, chatCommand: { ...form, applying: false, applied: true, resultRoute, resultParams, openLabel } }
        : entry)));
    } catch (error) {
      actionSaves.current.delete(message.id);
      dirty.current = true;
      setMessages(previous => previous.map(entry => (entry.id === message.id
        ? { ...entry, chatCommand: { ...form, applying: false, error: error.message } }
        : entry)));
    }
  }, [actionSaves, dirty, navigateFromChat, setMessages]);

  const onDraft = useCallback((message, cancelled) => {
    const draft = message.documentDraft;
    const scope = taskScope();
    const own = runtime();
    if (scope.workspaceId !== draft.scope.workspaceId || scope.accountId !== draft.scope.accountId
        || own.closedSpaces.has(scope.workspaceId)) {
      return setBanner('초안을 작성한 공간에서 열어 주세요.');
    }
    if (draft.savedId) return navigateFromChat(ROUTES.MemoEdit, { memoId: draft.savedId });
    if (draft.cancelled || actionSaves.current.has(message.id)) return;
    let next = { ...draft, cancelled };
    if (!cancelled) {
      const space = own.store.getCurrentWorkspace();
      if (!space.personal && space.roleCode === 'VIEWER') {
        return setBanner('초안을 작성한 공간에서 편집 권한을 확인해 주세요.');
      }
      const latest = planProjectBrief(draft.request, todayIn(aiPolicy().timezone),
        { queryProjects, queryTasks, isExcluded: id => readPreference(`ai-excluded:${id}`, false) });
      if (JSON.stringify(latest?.sections) !== JSON.stringify(draft.sections)) {
        return setBanner('초안에 사용한 항목이 바뀌었어요. 다시 요청해 주세요.');
      }
      actionSaves.current.add(message.id);
      try {
        const savedId = createAiDocument(own, { title: draft.title, text: draft.text, pending: false }, { read: readPreference, write: writePreference }, randomUUID);
        next = { ...next, savedId };
      } catch (error) {
        actionSaves.current.delete(message.id);
        return setBanner(error.message);
      }
    }
    dirty.current = true;
    setMessages(previous => previous.map(entry => (entry.id === message.id ? { ...entry, documentDraft: next } : entry)));
  }, [actionSaves, dirty, navigateFromChat, setBanner, setMessages]);

  const onTask = useCallback(async (message, action, id) => {
    let form = message.taskForm;
    if (action === 'open') return navigateFromChat(ROUTES.TaskEdit, { taskId: form.savedId });
    if (actionSaves.current.has(message.id) || form.cancelled || form.conflict || form.savedId) return;
    if (action === 'target') {
      const target = form.candidates.find(item => item.id === id);
      if (!target) return;
      form = { ...form, target };
    }
    if (action === 'cancel') form = { ...form, cancelled: true };
    if (action === 'save') {
      if (form.action === 'change' && !form.target) return;
      actionSaves.current.add(message.id);
      try {
        if (form.target && readPreference(`ai-excluded:${form.target.id}`, false)) {
          throw new Error('이 항목은 AI 작업에서 제외됐어요.');
        }
        const result = await saveTask(form.fields, { scope: form.scope, id: form.target?.id, expected: form.target, creationId: form.creationId });
        form = { ...form, savedId: result.task.id, pending: result.status === 'pending' };
      } catch (error) {
        if (error.code !== 'revision_conflict') {
          actionSaves.current.delete(message.id);
          setBanner(error.message);
          return;
        }
        form = { ...form, conflict: error.message };
      }
    }
    dirty.current = true;
    setMessages(previous => previous.map(entry => (entry.id === message.id ? { ...entry, taskForm: form } : entry)));
  }, [actionSaves, dirty, navigateFromChat, setBanner, setMessages]);

  const onProject = useCallback(async (message, action, field, value) => {
    let form = message.projectForm;
    if (action === 'open') return navigateFromChat(ROUTES.ProjectDetail, { projectId: form.createdId });
    if (actionSaves.current.has(message.id)) return;
    if (action === 'target') {
      const target = form.change.candidates.find(project => project.id === field);
      if (!target) return;
      const { due, ...snapshot } = target;
      form = { ...form, change: { ...form.change, target: snapshot } };
    }
    if (action === 'set') form = { ...form, values: { ...form.values, [field]: value } };
    if (action === 'cancel') form = { ...form, cancelled: true };
    if (action === 'create') {
      if (form.created || form.cancelled || form.conflict || (form.change ? !form.change.target : nextField(form.values))) return;
      actionSaves.current.add(message.id);
      try {
        const activeScope = projectScope();
        const scope = form.scope ?? (form.workspaceId === activeScope.workspaceId ? activeScope : null);
        const target = form.change?.target;
        if (target && readPreference(`ai-excluded:${target.id}`, false)) {
          throw new Error('이 프로젝트는 AI 작업에서 제외됐어요.');
        }
        const result = await saveProject(target ? { status: form.change.status } : { ...form.values, desc: '' },
          { scope, id: target?.id, expected: target, creationId: form.creationId });
        if (result.status === 'conflict') form = { ...form, conflict: result.message };
        else form = { ...form, created: true, createdId: result.project.id, syncPending: result.status === 'pending' };
      } catch (error) {
        actionSaves.current.delete(message.id);
        setBanner(error.message);
        return;
      }
    }
    dirty.current = true;
    setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, projectForm: form } : m)));
  }, [actionSaves, dirty, navigateFromChat, setBanner, setMessages]);

  const onMakeDoc = useCallback((answer) => {
    try {
      const question = messages[messages.indexOf(answer) - 1]?.text ?? '';
      const title = (/^#{1,6}\s+(.+)$/m.exec(answer.text)?.[1] || question || answer.text.split('\n')[0]).replace(/\*\*/g, '').trim().slice(0, 40);
      const id = createAiDocument(runtime(), { title, text: answer.text }, { read: readPreference, write: writePreference }, randomUUID);
      navigateFromChat(ROUTES.MemoEdit, { memoId: id });
    } catch (e) {
      setBanner(e.message);
    }
  }, [messages, navigateFromChat, setBanner]);

  return { onCommand, onDraft, onTask, onProject, onMakeDoc };
}
