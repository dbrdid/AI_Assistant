// ============================================================
// AiChatScreen.js — AI 채팅 화면
//   이전 대화(기기에 저장) · 새 채팅 · 사진/파일 첨부 · 클라우드/로컬 AI 선택
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { randomUUID } from 'expo-crypto';
import { aiPolicy, askFromDevice, lookupChatDocument, lookupChatReadTool, titleForChat, runtime } from '../../../integration/runtime';
import { documentLookupTerms } from '../../../data/memos/memoSearch.mjs';
import { readPreference } from '../../../data/hooks';
import { nextField, parseProjectRequest, parseProjectStatusRequest, projectDraftValues } from '../projectTemplate.mjs';
import { getProjects, projectScope, queryProjects } from '../../../data/projects/ProjectStore';
import { projectSnapshot } from '../../../data/projects/projectOperations.mjs';
import { queryTasks, taskScope } from '../../../data/tasks/TaskStore';
import { parseTaskAction } from '../taskChatIntent.mjs';
import { planChatCommand } from '../chatCommands.mjs';
import { planProjectBrief } from '../chatWorkflows.mjs';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import AtriaBook from '../components/AtriaBook';
import ChatMessageBubble from '../components/ChatMessageBubble';
import ChatPanels from '../components/ChatPanels';
import useChatActions, { buildTaskApprovalDraft } from '../hooks/useChatActions';
import OnceTip from '../../../shared/components/OnceTip';
import Icon from '../../../shared/components/Icon';
import { CircleButton } from '../../../shared/components/Ui';
import { useLeadAction } from '../../../navigation/ScreenEntry';
import { openParams } from '../../../data/memos/MemoStore';
import { AI_ROUTE_LABEL, LOCAL_AI_AVAILABLE, addUsage, loadAiUsage, setAiRoute, setAiTransmission, useSettings } from '../../../data/settings/SettingsStore';
import { ROUTES } from '../../../navigation/routes';
import { deleteChat, getChat, saveChat, setChatTitle, setPinned, useChats } from '../../../data/ai/ChatStore';
import { describe, extract, pickAttachments } from '../../../services/ai/ChatAttachments';
import { canRecognize, getCloudFiles, getFiles, recognizeFile, useCloudFiles, useFiles } from '../../../data/files/FileStore';
import { chatAttachmentsForTurn } from '../../../integration/ChatSourceScope.mjs';
import { chatErrorMessage, todayIn } from '../../../lib/stella/ai-chat';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

const ATTACH_ONLY_QUESTION = '첨부한 자료를 요약해줘';

function errorText(error) {
  const code = error?.code ?? '';
  if (code === 'CONSENT_REQUIRED' || code === 'TRANSMISSION_DENIED') return 'AI로 자료 보내기가 꺼져 있어요. 위의 [허용하기]를 눌러 주세요';
  if (code === 'NO_SOURCES') return '보낼 수 있는 자료가 없어요';
  if (code === 'NETWORK') return error.message;
  return chatErrorMessage(error);
}

const pad = (n) => String(n).padStart(2, '0');
const when = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayLabel = (ms) => {
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (ms >= start.getTime()) return `오늘 ${hm}`;
  if (ms >= start.getTime() - 86400000) return `어제 ${hm}`;
  return when(ms);
};

const getChatCatalog = () => ({ projects: getProjects(), files: [...getFiles(), ...getCloudFiles()] });
const pendingProjectForm = messages => messages.slice().reverse().find(message => message.projectForm && !message.projectForm.created && !message.projectForm.cancelled);

export default function AiChatScreen({ navigation, route: navRoute }) {
  const lead = useLeadAction(navigation.goBack);
  const insets = useSafeAreaInsets();
  const settings = useSettings();
  const ai = settings.ai ?? {};
  const route = ai.route === 'self_hosted' ? 'self_hosted' : 'external';
  const routeReady = route === 'external' || LOCAL_AI_AVAILABLE;
  const allowed = !ai.transmissionDisabled && ai.consent?.[route] === true;
  const chats = useChats();
  const localVaultFiles = useFiles();
  const cloudVaultFiles = useCloudFiles();
  const vaultFiles = [
    ...localVaultFiles.filter((file) => !file.storage || file.storage === 'local'),
    ...cloudVaultFiles,
  ].filter(canRecognize);

  const restored = useRef(navRoute?.params?.chatId ? getChat(navRoute.params.chatId) : null).current;
  const [chatId, setChatId] = useState(() => restored?.id ?? randomUUID());
  const [messages, setMessages] = useState(() => (restored?.messages ?? []).map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
  const [input, setInput] = useState(() => String(navRoute?.params?.initialPrompt ?? ''));
  const [status, setStatus] = useState('idle');
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const chatFiles = useRef([]);
  const [panel, setPanel] = useState(null);
  const [consentBusy, setConsentBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const [usage, setUsage] = useState({ data: null, error: '' });
  const [headerBottom, setHeaderBottom] = useState(0);
  const [startedAt, setStartedAt] = useState(() => restored?.updatedAt ?? null);
  const [renaming, setRenaming] = useState(null);

  const listRef = useRef(null);
  const timers = useRef({ think: null, type: null });
  const dirty = useRef(false);
  const extractAbort = useRef(null);
  const requestRef = useRef(null);
  const actionSaves = useRef(new Set());
  const titled = useRef(new Set());
  const nextId = useCallback(() => randomUUID(), []);

  const clearTimers = useCallback(() => {
    clearTimeout(timers.current.think);
    clearInterval(timers.current.type);
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  useEffect(() => () => extractAbort.current?.abort(), []);
  useEffect(() => () => requestRef.current?.abort(), []);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, () => setKeyboardUp(true));
    const b = Keyboard.addListener(hideEvt, () => setKeyboardUp(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  useEffect(() => {
    if (status === 'idle' && dirty.current && messages.length) {
      dirty.current = false;
      saveChat(chatId, messages);
      const chat = getChat(chatId);
      const question = messages.find((m) => m.role === 'user')?.text;
      const answer = messages.find((m) => m.role === 'ai' && !m.error && m.text);
      if (chat?.titleSource === 'question' && question && answer && !answer.documentLookup && !answer.toolResult && !answer.projectForm && !titled.current.has(chatId)) {
        titled.current.add(chatId);
        const id = chatId;
        titleForChat(question, answer.text)
          .then((title) => setChatTitle(id, title, 'ai'))
          .catch(() => {});
      }
    }
  }, [status, messages, chatId]);

  const openUsage = async () => {
    setPanel('usage');
    setUsage((u) => ({ data: u.data, error: '' }));
    try { setUsage({ data: await loadAiUsage(), error: '' }); }
    catch (e) { setUsage({ data: null, error: e?.message || '사용량을 불러오지 못했어요' }); }
  };

  const startRename = (chat) => {
    setPanel(null);
    if (!chat && !getChat(chatId)) saveChat(chatId, messages.map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
    const target = chat ?? getChat(chatId);
    if (target) setRenaming({ id: target.id, value: target.title });
  };
  const saveRename = () => {
    if (!renaming) return;
    if (!renaming.value.trim()) return setBanner('제목을 입력해 주세요');
    setChatTitle(renaming.id, renaming.value, 'user');
    setRenaming(null);
  };

  const addFiles = async (mode) => {
    if (status !== 'idle') return;
    setPanel(null);
    let assets;
    try { assets = await pickAttachments(mode); } catch { return setBanner('파일을 고르지 못했어요'); }
    const items = assets.map(describe);
    if (!items.length) return;
    setAttachments((prev) => [...prev, ...items]);
    extractAbort.current ??= new AbortController();
    const signal = extractAbort.current.signal;
    for (const item of items) {
      const done = await extract(item, signal);
      if (signal.aborted) return;
      setAttachments((prev) => prev.map((a) => (a.id === item.id ? done : a)));
    }
  };
  const addVaultFile = async (file) => {
    if (status !== 'idle') return;
    const storage = file.storage || 'local';
    if (attachments.some((a) => a.archiveFileId === file.id && a.archiveStorage === storage)) {
      return setBanner('이미 첨부한 파일이에요');
    }
    const item = { ...describe({ name: file.name, mimeType: file.mimeType }), archiveFileId: file.id, archiveStorage: storage, sourceScope: 'vault' };
    setPanel(null);
    setAttachments((prev) => [...prev, item]);
    extractAbort.current ??= new AbortController();
    const signal = extractAbort.current.signal;
    try {
      const text = (file.text?.trim() || await recognizeFile(file.id)).trim();
      if (signal.aborted) return;
      if (!text) throw new Error('파일에서 읽을 글자를 찾지 못했어요');
      setAttachments((prev) => prev.map((a) => (a.id === item.id ? { ...a, status: 'ready', text, error: '' } : a)));
    } catch (error) {
      if (signal.aborted) return;
      setAttachments((prev) => prev.map((a) => (a.id === item.id ? { ...a, status: 'error', error: error?.message || '파일을 읽지 못했어요' } : a)));
    }
  };
  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));
  const reading = attachments.some((a) => a.status === 'reading');
  const ready = attachments.filter((a) => a.status === 'ready');

  const navigateFromChat = useCallback((targetRoute, params) => {
    if (messages.length) {
      if (dirty.current || !getChat(chatId)) saveChat(chatId, messages.map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
      dirty.current = false;
      navigation.setParams?.({ chatId });
    }
    navigation.navigate(targetRoute, params);
  }, [chatId, messages, navigation]);

  const actions = useChatActions({ messages, setMessages, dirty, actionSaves, setBanner, navigateFromChat });

  const send = useCallback(
    async (raw) => {
      const text = raw.trim() || (ready.length ? ATTACH_ONLY_QUESTION : '');
      if (!text || status !== 'idle' || reading) return;
      const taskAction = !ready.length && parseTaskAction(text, todayIn(aiPolicy().timezone));
      if (taskAction) {
        const { form, text: replyText } = buildTaskApprovalDraft(taskAction);
        dirty.current = true;
        if (!messages.length) setStartedAt(Date.now());
        setInput('');
        setMessages(previous => [...previous, { id: nextId(), role: 'user', text },
          { id: nextId(), role: 'ai', done: true, toolResult: true, sources: [], text: replyText, ...(form && { taskForm: form }) }]);
        return;
      }
      if (!ready.length && !chatAttachmentsForTurn(text, [], chatFiles.current).length) {
        const own = runtime();
        const scope = taskScope();
        const isExcluded = id => readPreference(`ai-excluded:${id}`, false);
        const canRead = !own.closedSpaces.has(scope.workspaceId);
        const brief = canRead && planProjectBrief(text, todayIn(aiPolicy().timezone), { queryProjects, queryTasks, isExcluded });
        const command = !brief && canRead && planChatCommand(text, {
          memos: own.store.getMemos().filter(memo => !isExcluded(memo.id)),
          recentSources: [...messages].reverse().find(entry => entry.sources?.length)?.sources ?? [],
        });
        if (brief || command) {
          Keyboard.dismiss();
          dirty.current = true;
          if (!messages.length) setStartedAt(Date.now());
          setInput('');
          setMessages(previous => [...previous, { id: nextId(), role: 'user', text },
            { id: nextId(), role: 'ai', done: true, toolResult: true, sources: [],
              text: brief ? brief.text : command.message ?? '실행할 작업을 검토해 주세요.',
              ...(brief?.sections && { documentDraft: { ...brief, request: text, scope } }),
              ...(command?.command && { chatCommand: { ...command, scope } }) }]);
          return;
        }
      }
      const waiting = pendingProjectForm(messages);
      if (!ready.length && waiting && !waiting.projectForm.change && nextField(waiting.projectForm.values)?.key === 'title') {
        dirty.current = true;
        setInput('');
        setMessages((prev) => [...prev.filter((m) => m.id !== waiting.id), { id: nextId(), role: 'user', text },
          { ...waiting, projectForm: { ...waiting.projectForm, values: projectDraftValues(text.slice(0, 100)) } }]);
        return;
      }
      const change = !ready.length && parseProjectStatusRequest(text);
      if (change) {
        const candidates = queryProjects({ title: change.title }).filter(project => !readPreference(`ai-excluded:${project.id}`, false));
        const target = candidates.length === 1 ? projectSnapshot(candidates[0]) : null;
        const form = candidates.length ? { values: {}, scope: projectScope(), change: {
          status: change.status, target, candidates: candidates.map(project => ({ ...projectSnapshot(project), due: project.due })),
        } } : null;
        dirty.current = true;
        if (!messages.length) setStartedAt(Date.now());
        setInput('');
        setMessages(previous => [...previous, { id: nextId(), role: 'user', text },
          { id: nextId(), role: 'ai', done: true, toolResult: true, sources: [],
            text: form ? '변경할 프로젝트 상태를 확인해 주세요.' : '현재 공간에서 해당 프로젝트를 찾지 못했어요.',
            ...(form && { projectForm: form }) }]);
        return;
      }
      const project = !ready.length && parseProjectRequest(text);
      if (project) {
        dirty.current = true;
        if (!messages.length) setStartedAt(Date.now());
        setInput('');
        setMessages((prev) => [...prev, { id: nextId(), role: 'user', text },
          { id: nextId(), role: 'ai', text: '프로젝트를 어떻게 만들지 확인해 주세요.', done: true, sources: [],
            projectForm: { values: projectDraftValues(project.title.slice(0, 100)), scope: projectScope(), creationId: randomUUID() } }]);
        return;
      }
      const turnFiles = chatAttachmentsForTurn(text, ready, chatFiles.current);
      const history = messages.filter(m => !m.error && m.text && !m.toolResult)
        .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }));
      const local = !turnFiles.length && (lookupChatDocument(text) ?? lookupChatReadTool(text, history, {
        queryProjects, queryTasks, getFiles: () => getChatCatalog().files,
      }));
      if (local) {
        dirty.current = true;
        if (!messages.length) setStartedAt(Date.now());
        setInput('');
        setMessages(previous => [...previous, { id: nextId(), role: 'user', text }, { id: nextId(), role: 'ai', done: true, ...local }]);
        return;
      }
      if (!routeReady) return setBanner('로컬 AI는 아직 연결 전이에요. 클라우드 AI로 바꿔 주세요');

      const aiId = nextId();
      const userId = nextId();
      const sentFiles = ready.map(({ id, name, kind, text: body, sourceScope }) => ({ id, name, kind, text: body, sourceScope }));
      dirty.current = true;
      if (!messages.length) setStartedAt(Date.now());
      setMessages((prev) => [...prev, { id: userId, role: 'user', text, attachments: sentFiles }]);
      setInput('');
      setAttachments((prev) => prev.filter((attachment) => attachment.status === 'error'));
      extractAbort.current = null;
      setStatus('thinking');

      addUsage('question');
      const controller = new AbortController(); requestRef.current = controller;
      let answer;
      chatFiles.current = [...sentFiles, ...chatFiles.current.filter((f) => !sentFiles.some((s) => s.id === f.id))];
      try {
        answer = await askFromDevice(text, controller.signal, {
          history,
          attachments: turnFiles,
          fileVaultOnly: turnFiles.some(file => file.sourceScope === 'vault'),
          getCatalog: getChatCatalog,
        });
      } catch (error) {
        if (!controller.signal.aborted) setMessages((prev) => [...prev, { id: aiId, role: 'ai', text: errorText(error), done: true, sources: [], error: true }]);
        if (requestRef.current === controller) setStatus('idle');
        return;
      }
      if (controller.signal.aborted || requestRef.current !== controller) return;
      if (answer.attachmentWarnings?.length) {
        const omittedIds = new Set(answer.attachmentWarnings.map((file) => file.id));
        setMessages((prev) => prev.map((message) => (message.id === userId ? {
          ...message,
          attachments: message.attachments.map((file) => (omittedIds.has(file.id)
            ? { ...file, warning: '이번 요청의 AI 자료 한도를 넘어 제외됐어요' }
            : file)),
        } : message)));
        setBanner(`AI 요청 자료 한도를 넘어 이번 답변에서 제외된 파일: ${answer.attachmentWarnings.map(file => file.name).join(', ')}`);
      }
      if (answer.taskAction) {
        const { form, text: replyText } = buildTaskApprovalDraft(answer.taskAction);
        setMessages((prev) => [...prev, { id: aiId, role: 'ai', done: true, toolResult: true, sources: [], text: replyText, ...(form && { taskForm: form }) }]);
        setStatus('idle');
        return;
      }
      if (answer.documentLookup) {
        setMessages((prev) => [...prev, { id: aiId, role: 'ai', text: answer.text, sources: answer.sources, documentLookup: true, done: true }]);
        setStatus('idle');
        return;
      }
      const full = answer.text;
      timers.current.think = setTimeout(() => {
        setMessages((prev) => [...prev, { id: aiId, role: 'ai', text: '' }]);
        setStatus('streaming');
        let shown = 0;
        timers.current.type = setInterval(() => {
          shown = Math.min(full.length, shown + 2);
          const finished = shown >= full.length;
          setMessages((prev) => prev.map((m) => (m.id === aiId ? { ...m, text: full.slice(0, shown), sources: answer.sources, done: finished } : m)));
          if (finished) {
            clearInterval(timers.current.type);
            setStatus('idle');
          }
        }, 30);
      }, 300);
    },
    [status, nextId, messages, ready, reading, routeReady],
  );

  const stop = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    clearTimers();
    setMessages((prev) => prev.map((m) => (m.role === 'ai' && !m.done ? { ...m, done: true } : m)));
    setStatus('idle');
  };

  const reset = (next = { id: randomUUID(), messages: [], at: null }) => {
    requestRef.current?.abort();
    requestRef.current = null;
    clearTimers();
    extractAbort.current?.abort();
    extractAbort.current = null;
    if (dirty.current && messages.length) saveChat(chatId, messages.map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
    dirty.current = false;
    chatFiles.current = [];
    setChatId(next.id);
    setMessages(next.messages);
    setStartedAt(next.at ?? null);
    setAttachments([]);
    setInput('');
    setStatus('idle');
    setPanel(null);
    navigation.setParams?.({ chatId: next.messages.length ? next.id : undefined });
  };
  const newChat = () => reset();
  const pinned = !!chats.find((c) => c.id === chatId)?.pinnedAt;
  const togglePin = () => {
    setPanel(null);
    const ok = setPinned(chatId, !pinned, messages.map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
    setBanner(!ok ? '답이 끝난 뒤에 고정할 수 있어요' : pinned ? '고정을 해제했어요' : '이 대화를 고정했어요. 이전 대화 맨 위에 보여요');
  };

  const chatUploads = messages.flatMap((m) => (m.role === 'user' ? (m.attachments ?? []).map((a) => ({ ...a, messageId: m.id, question: m.text })) : []));
  const jumpTo = (messageId) => {
    setPanel(null);
    const index = messages.findIndex((m) => m.id === messageId);
    if (index >= 0) setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 }), 250);
  };
  const deleteCurrent = () => {
    const id = chatId;
    dirty.current = false;
    reset();
    deleteChat(id);
  };
  const openChat = (chat) => reset({ id: chat.id, messages: chat.messages.map((m) => ({ ...m, done: true })), at: chat.updatedAt });

  const chooseRoute = (next) => {
    setPanel(null);
    if (next === route) return;
    if (next === 'self_hosted' && !LOCAL_AI_AVAILABLE) return;
    setAiRoute(next);
  };
  const toggleSending = async (enabled) => {
    if (consentBusy) return;
    setConsentBusy(true);
    try { await setAiTransmission(route, enabled); setBanner(''); }
    catch (e) { setBanner(e.message); }
    finally { setConsentBusy(false); }
  };

  const canLookup = !chatAttachmentsForTurn(input, ready, chatFiles.current).length && documentLookupTerms(input).length > 0;
  const canSend = (input.trim().length > 0 || ready.length > 0) && status === 'idle' && !reading && (routeReady || canLookup);

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.flex}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]} onLayout={(e) => setHeaderBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
          <View pointerEvents="none" style={[styles.headerTitleWrap, { top: insets.top + spacing.sm }]}>
            <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
              {(messages.length > 0 && chats.find((c) => c.id === chatId)?.title) || 'AI 채팅'}
            </Text>
          </View>
          {lead.hidden ? <View style={{ width: 40 }} /> : <CircleButton icon="chevronLeft" label="뒤로 가기" onPress={lead.onPress} />}
          <View style={styles.headerRight}>
            {messages.length === 0 ? (
              <CircleButton icon="history" label="이전 대화" onPress={() => setPanel('history')} />
            ) : (
              <>
                <CircleButton icon="edit" label="새 채팅" onPress={newChat} />
                <CircleButton icon="more" label="더보기" onPress={() => setPanel('more')} />
              </>
            )}
          </View>
        </View>

        {!routeReady ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>로컬 AI는 서버 연결 전이라 아직 쓸 수 없어요.</Text>
            <Pressable accessibilityRole="button" onPress={() => chooseRoute('external')} style={styles.noticeBtn}>
              <Text style={styles.noticeBtnText}>클라우드 AI로</Text>
            </Pressable>
          </View>
        ) : !allowed ? (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>질문과 관련 기록 일부를 {route === 'external' ? '외부 AI' : '자체 모델 서버'}로 보내야 답할 수 있어요.</Text>
            <Pressable accessibilityRole="button" disabled={consentBusy} onPress={() => toggleSending(true)} style={[styles.noticeBtn, consentBusy && { opacity: 0.5 }]}>
              <Text style={styles.noticeBtnText}>{consentBusy ? '처리 중…' : '허용하기'}</Text>
            </Pressable>
          </View>
        ) : null}

        {!!banner && (
          <Pressable accessibilityRole="button" accessibilityLabel={`${banner}, 닫기`} onPress={() => setBanner('')} style={styles.banner}>
            <Text style={styles.bannerText}>{banner}</Text>
            <Icon name="x" size={14} color={colors.muted} />
          </Pressable>
        )}

        {messages.length === 0 ? (
          <View style={styles.empty}>
            <AtriaBook size={40} busy={status !== 'idle'} />
            <Text style={styles.emptyTitle}>Atria AI</Text>
            <OnceTip style={{ marginTop: 16, marginHorizontal: 24 }} tips={[{ id: 'ai-chat', text: '앱 안의 문서, 일정, 할 일에서 찾아 답해요. 무언가를 만들거나 바꾸는 작업은 확인하고 승인한 뒤에만 적용돼요.' }]} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => (
              <ChatMessageBubble
                message={item}
                onOpenSource={(src) => src.route && navigateFromChat(src.route, openParams(src.type, src.id))}
                onCommand={actions.onCommand}
                onDraft={actions.onDraft}
                onTask={actions.onTask}
                onProject={actions.onProject}
                onMakeDoc={actions.onMakeDoc}
              />
            )}
            contentContainerStyle={styles.list}
            ListHeaderComponent={startedAt ? <Text style={styles.dayDivider}>{dayLabel(startedAt)}</Text> : null}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
              setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 }), 100);
            }}
            ListFooterComponent={status === 'thinking' ? <View style={{ paddingHorizontal: 16, paddingVertical: 10 }}><AtriaBook size={26} busy label="Atria AI" /></View> : null}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          />
        )}
      </View>

      {attachments.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pendingBar} contentContainerStyle={styles.pendingRow}>
          {attachments.map((a) => (
            <View key={a.id} style={[styles.pending, a.status === 'error' && styles.pendingError]}>
              {a.status === 'reading' && <ActivityIndicator size="small" color={colors.mintDark} />}
              {a.status !== 'reading' && <Icon name={a.kind === 'image' ? 'image' : a.kind === 'audio' ? 'mic' : 'file'} size={16} color={a.status === 'error' ? colors.coral : colors.mintDark} />}
              <View style={{ maxWidth: 180 }}>
                <Text style={styles.pendingName} numberOfLines={1} accessibilityLabel={`${a.kind === 'image' ? '사진' : a.kind === 'audio' ? '음성' : '파일'} ${a.name}`}>{a.name}</Text>
                <Text style={[styles.pendingSub, a.status === 'error' && { color: colors.coral }]} numberOfLines={2}>
                  {a.status === 'reading' ? (a.kind === 'image' ? '사진 글자 읽는 중…' : a.kind === 'audio' ? '음성 받아쓰는 중…' : '글자 꺼내는 중…') : a.status === 'ready' ? `글자 ${a.text.length.toLocaleString()}자 준비됨` : a.error}
                </Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel={`${a.name} 빼기`} onPress={() => removeAttachment(a.id)} hitSlop={8}>
                <Icon name="x" size={16} color={colors.muted} />
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={[styles.inputArea, { paddingBottom: keyboardUp ? spacing.xs : insets.bottom + spacing.xs }]}>
        <View style={styles.inputBox}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={ready.length ? '첨부한 자료에 대해 물어보세요' : '앱 안의 기록에 대해 물어보세요'}
            placeholderTextColor={colors.muted}
            multiline
            maxLength={2000}
            accessibilityLabel="메시지 입력"
          />
          <View style={styles.inputTools}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="사진이나 파일 첨부"
              disabled={status !== 'idle'}
              onPress={() => setPanel('attach')}
              style={[styles.toolBtn, status !== 'idle' && { opacity: 0.4 }]}
            >
              <Icon name="plus" size={20} color={colors.muted} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="이번 달 AI 사용량" onPress={openUsage} style={styles.routeChip}>
              <Text style={styles.routeText}>사용량</Text>
            </Pressable>
            <View style={{ flex: 1 }} />
            <Pressable accessibilityRole="button" accessibilityLabel={`AI 선택, 지금 ${AI_ROUTE_LABEL[route]}`} onPress={() => setPanel('route')} style={styles.routeChip}>
              <Text style={[styles.routeText, routeReady && !allowed && { color: colors.coral }]}>{AI_ROUTE_LABEL[route]}{routeReady && !allowed ? ', 사용 불가' : ''}</Text>
              <Icon name="chevronDown" size={14} color={colors.muted} />
            </Pressable>
            {status === 'idle' ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="전송"
                accessibilityState={{ disabled: !canSend }}
                onPress={() => send(input)}
                disabled={!canSend}
                style={[styles.sendBtn, canSend ? styles.sendOn : styles.sendOff]}
              >
                <Icon name="arrowUp" size={22} color={colors.onPrimary} strokeWidth={2.4} />
              </Pressable>
            ) : (
              <Pressable accessibilityRole="button" accessibilityLabel="답변 중지" onPress={stop} style={({ pressed }) => [styles.sendBtn, styles.sendOn, pressed && { opacity: 0.85 }]}>
                <Icon name="stop" size={20} color={colors.onPrimary} />
              </Pressable>
            )}
          </View>
        </View>
      </View>

      <ChatPanels
        panel={panel}
        setPanel={setPanel}
        headerBottom={headerBottom}
        insets={insets}
        route={route}
        chooseRoute={chooseRoute}
        usage={usage}
        onOpenSubscription={() => { setPanel(null); navigation.navigate(ROUTES.Subscription); }}
        renaming={renaming}
        setRenaming={setRenaming}
        saveRename={saveRename}
        pinned={pinned}
        togglePin={togglePin}
        startRename={startRename}
        deleteCurrent={deleteCurrent}
        deleteChatById={deleteChat}
        chatUploads={chatUploads}
        jumpTo={jumpTo}
        vaultFiles={vaultFiles}
        attachments={attachments}
        status={status}
        addFiles={addFiles}
        addVaultFile={addVaultFile}
        chats={chats}
        chatId={chatId}
        openChat={openChat}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  flex: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: spacing.md, backgroundColor: colors.cream },
  headerTitleWrap: { position: 'absolute', left: 112, right: 112, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: font.header, fontWeight: '800', color: colors.ink },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  inputArea: { backgroundColor: colors.cream, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  inputTools: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: 6, paddingBottom: 6 },
  routeChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line },
  routeText: { fontSize: font.caption + 1, fontWeight: '700', color: colors.ink },
  notice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.coralSoft, borderWidth: 1, borderColor: colors.coral },
  noticeText: { flex: 1, fontSize: font.caption + 1, color: colors.ink, lineHeight: 19 },
  noticeBtn: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.action },
  noticeBtnText: { fontSize: font.caption, fontWeight: '800', color: colors.onPrimary },
  banner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.mintSoft },
  bannerText: { flex: 1, fontSize: font.caption + 1, color: colors.ink },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: 15, color: colors.muted, marginTop: spacing.sm },
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg, gap: spacing.lg },
  dayDivider: { alignSelf: 'center', fontSize: font.caption, color: colors.muted },
  pendingBar: { flexGrow: 0, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  pendingRow: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  pending: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  pendingError: { borderColor: colors.coral },
  pendingName: { fontSize: font.caption, fontWeight: '700', color: colors.ink },
  pendingSub: { fontSize: 11, color: colors.muted },
  inputBox: { borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  toolBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 44, maxHeight: 140, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, fontSize: 15, color: colors.ink },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sendOn: { backgroundColor: colors.action },
  sendOff: { backgroundColor: colors.line },
});
