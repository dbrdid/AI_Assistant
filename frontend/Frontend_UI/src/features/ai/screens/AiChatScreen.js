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
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { randomUUID } from 'expo-crypto';
import { aiPolicy, askFromDevice, lookupChatDocument, lookupChatReadTool, titleForChat, runtime, writePreference } from '../../../integration/runtime';
import { documentLookupTerms } from '../../../data/memos/memoSearch.mjs';
import { readPreference } from '../../../data/hooks';
import { createAiDocument } from '../../stella/aiPending.mjs';
import { nextField, parseProjectRequest, parseProjectStatusRequest, projectDraftValues, summary as projectSummary } from '../projectTemplate.mjs';
import { getProjects, projectScope, queryProjects, saveProject } from '../../../data/projects/ProjectStore';
import { projectSnapshot } from '../../../data/projects/projectOperations.mjs';
import { findOverlap, queryTasks, saveTask, taskScope } from '../../../data/tasks/TaskStore';
import { taskSnapshot } from '../../../data/tasks/taskOperations.mjs';
import { parseTaskAction } from '../taskChatIntent.mjs';
import { planChatCommand } from '../chatCommands.mjs';
import { planProjectBrief } from '../chatWorkflows.mjs';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import AtriaBook from '../components/AtriaBook';
import OnceTip from '../../../shared/components/OnceTip';
import { PinIcon } from '../components/ChatIcons';
import Icon from '../../../shared/components/Icon';
import { CircleButton } from '../../../shared/components/Ui';
import { useLeadAction } from '../../../navigation/ScreenEntry';
import SlidePanel from '../components/SlidePanel';
import { openParams } from '../../../data/memos/MemoStore';
import { AI_ROUTE_LABEL, LOCAL_AI_AVAILABLE, PLANS, addUsage, loadAiUsage, setAiRoute, setAiTransmission, useSettings } from '../../../data/settings/SettingsStore';
import { ROUTES } from '../../../navigation/routes';
import { TITLE_MAX, deleteChat, getChat, saveChat, setChatTitle, setPinned, sortChats, useChats } from '../../../data/ai/ChatStore';
import UpSheet from '../components/UpSheet';
import { describe, extract, pickAttachments } from '../../../services/ai/ChatAttachments';
import { canRecognize, getCloudFiles, getFiles, recognizeFile, useCloudFiles, useFiles } from '../../../data/files/FileStore';
import { chatAttachmentsForTurn } from '../../../integration/ChatSourceScope.mjs';
import { chatErrorMessage, todayIn } from '../../../lib/stella/ai-chat';
import { colors, font, radius, shadow, spacing } from '../../../shared/theme/theme';

// 대화가 비어 있을 때 보여줄 "추천 질문" 버튼들. 누르면 그 문장이 바로 전송됩니다.
const ATTACH_ONLY_QUESTION = '첨부한 자료를 요약해줘';

// 오류 코드 → 화면 문구 (정책 검사·서버 오류 모두)
function errorText(error) {
  const code = error?.code ?? '';
  if (code === 'CONSENT_REQUIRED' || code === 'TRANSMISSION_DENIED') return 'AI로 자료 보내기가 꺼져 있어요. 위의 [허용하기]를 눌러 주세요';
  if (code === 'NO_SOURCES') return '보낼 수 있는 자료가 없어요';
  if (code === 'NETWORK') return error.message; // 오프라인 · 서버 작업자 재시작 (runtime.gateway 문구)
  return chatErrorMessage(error);
}
const pad = (n) => String(n).padStart(2, '0');
const when = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// 대화 위 시간 구분선: '오늘 21:12' · '어제 09:30' · '11/15 14:02'
const dayLabel = (ms) => {
  const d = new Date(ms);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (ms >= start.getTime()) return `오늘 ${hm}`;
  if (ms >= start.getTime() - 86400000) return `어제 ${hm}`;
  return when(ms);
};

// 출처 칩 아이콘: 메모 · 일정 · 첨부
const sourceIcons = { memo: 'file', file: 'paperclip', project: 'folder', task: 'checkSquare', event: 'calendar' };
const sourceLabels = { memo: '메모', file: '파일', project: '프로젝트', task: '할 일', event: '일정' };
const sourceIcon = src => src.route ? sourceIcons[src.type] ?? 'file' : 'paperclip';
const getChatCatalog = () => ({ projects: getProjects(), files: [...getFiles(), ...getCloudFiles()] });
const pendingProjectForm = messages => messages.slice().reverse().find(message => message.projectForm && !message.projectForm.created && !message.projectForm.cancelled);

// ------------------------------------------------------------
// 말풍선 하나 (내 메시지 / AI 메시지)
// ------------------------------------------------------------
// "프로젝트 만들어줘": 템플릿의 필수 항목을 하나씩 눌러 고르고, 다 고르면 만들기
function ProjectForm({ form, onAction }) {
  const chip = (label, onPress, strong, key = label) => <Pressable key={key} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.formChip, pressed && { opacity: 0.6 }]}>
    <Text style={[styles.formChipText, strong && styles.formChipPrimary]}>{label}</Text></Pressable>;
  if (form.created) return <View style={styles.form}><Text style={styles.aiText}>{form.syncPending ? '기기에 저장했어요. 공유 공간 동기화를 기다리고 있어요.' : form.change ? '프로젝트 상태를 변경했어요.' : `'${form.values.title}' 프로젝트를 만들었어요.`}</Text><View style={styles.formRow}>{chip('프로젝트 열기', () => onAction('open'), true)}</View></View>;
  if (form.cancelled || form.conflict) return <View style={styles.form}><Text style={styles.formNote}>{form.conflict ?? '프로젝트 작업을 취소했어요.'}</Text></View>;
  if (form.change) return <View style={styles.form}>
    {form.change.target ? <Text style={styles.aiText}>{form.change.target.title}{'\n'}{form.change.target.status} → {form.change.status}</Text>
      : <Text style={styles.aiText}>이름이 같은 프로젝트가 있어요. 변경할 항목을 골라 주세요.</Text>}
    <View style={styles.formRow}>
      {form.change.target ? chip('상태 변경', () => onAction('create'), true)
        : form.change.candidates.map(project => chip(`${project.title} (${project.status}, ${project.due || '마감 없음'})`, () => onAction('target', project.id), false, project.id))}
      {chip('취소', () => onAction('cancel'))}
    </View>
  </View>;
  const field = nextField(form.values);
  return <View style={styles.form}>
    {!!field && Object.keys(form.values).length > 0 && <Text style={styles.formNote}>{projectSummary(form.values)}</Text>}
    {field ? <>
      <Text style={styles.aiText}>{field.ask}</Text>
      {field.options ? <View style={styles.formRow}>{field.options().map(([label, value]) => chip(label, () => onAction('set', field.key, value)))}</View>
        : <Text style={styles.formNote}>아래 입력창에 써서 보내 주세요.</Text>}
    </> : <>
      <Text style={styles.aiText}>{projectSummary(form.values)}</Text>
      <View style={styles.formRow}>{chip('프로젝트 만들기', () => onAction('create'), true)}{chip('취소', () => onAction('cancel'))}</View>
    </>}
    {field && <View style={styles.formRow}>{chip('취소', () => onAction('cancel'))}</View>}
  </View>;
}

function TaskForm({ form, onAction }) {
  const chip = (label, action, strong = false, key = label) => <Pressable key={key} accessibilityRole="button" onPress={action} style={({ pressed }) => [styles.formChip, pressed && { opacity: 0.6 }]}>
    <Text style={[styles.formChipText, strong && styles.formChipPrimary]}>{label}</Text>
  </Pressable>;
  const name = form.kind === 'event' ? '일정' : '할 일';
  if (form.cancelled || form.conflict) return <View style={styles.form}><Text style={styles.formNote}>{form.conflict ?? '작업을 취소했어요.'}</Text></View>;
  if (form.savedId) return <View style={styles.form}>
    <Text style={styles.aiText}>{form.pending ? '기기에 저장했어요. 공유 공간 동기화가 대기 중이에요.' : `${name}을 저장했어요.`}</Text>
    <View style={styles.formRow}>{chip(`${name} 열기`, () => onAction('open'), true)}</View>
  </View>;
  const { target, candidates, fields } = form;
  if (form.action === 'change' && !target) return <View style={styles.form}>
    <Text style={styles.aiText}>이름이 같은 항목이 있어요. 변경할 항목을 골라 주세요.</Text>
    <View style={styles.formRow}>
      {candidates.map(item => chip(`${item.title} (${item.date}, ${item.status})`, () => onAction('target', item.id), false, item.id))}
      {chip('취소', () => onAction('cancel'))}
    </View>
  </View>;
  return <View style={styles.form}>
    <Text style={styles.aiText}>{target ? `${target.title} (${target.date})\n${target.status} → ${fields.status}`
      : `${fields.title}\n${fields.date}${fields.start ? ' ' + fields.start : ''}`}</Text>
    {!!form.overlap && <Text style={styles.formNote}>같은 시간에 다른 항목이 있어요.</Text>}
    <View style={styles.formRow}>
      {chip(target ? '상태 변경' : `${name} 추가`, () => onAction('save'), true)}
      {chip('취소', () => onAction('cancel'))}
    </View>
  </View>;
}

function MessageBubble({ message, onOpenSource, onMakeDoc, onProject, onTask, onCommand, onDraft }) {
  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        {message.attachments?.length > 0 && (
          <View style={styles.sentFiles}>
            {message.attachments.map((a) => (
              <View key={a.id} style={styles.sentFile} accessibilityLabel={`${a.kind === 'image' ? '사진' : a.kind === 'audio' ? '음성' : '파일'} ${a.name}`}>
                <Icon name={a.kind === 'image' ? 'image' : a.kind === 'audio' ? 'mic' : 'file'} size={14} color={a.warning ? colors.coral : colors.mintDark} />
                <View style={{ flexShrink: 1 }}>
                  <Text style={styles.sentFileText} numberOfLines={1}>{a.name}</Text>
                  {!!a.warning && <Text style={styles.sentFileWarning}>{a.warning}</Text>}
                </View>
              </View>
            ))}
          </View>
        )}
        <View style={styles.userBubble}>
          <Text style={styles.userText} selectable>{message.text}</Text>
        </View>
      </View>
    );
  }

  const sources = message.done && message.sources ? message.sources : [];
  return (
    <View style={styles.aiRow}>
      <View style={styles.aiCol}>
        <View style={[styles.aiBubble, styles.aiBubbleFit, message.error && styles.errorBubble]}>
          <Text style={[styles.aiText, message.error && styles.errorText]} selectable>{message.text}</Text>
        </View>
        {message.projectForm && <ProjectForm form={message.projectForm} onAction={(...args) => onProject(message, ...args)} />}
        {message.taskForm && <TaskForm form={message.taskForm} onAction={(...args) => onTask(message, ...args)} />}
        {message.chatCommand && <Pressable accessibilityRole="button" style={({ pressed }) => [styles.formChip, styles.formChipStart, pressed && { opacity: 0.6 }]} onPress={() => onCommand(message.chatCommand)}>
          <Text style={[styles.formChipText, styles.formChipPrimary]}>작업 검토</Text>
        </Pressable>}
        {message.documentDraft && <View style={styles.formRow}>
          {message.documentDraft.cancelled ? <Text style={styles.formNote}>초안을 취소했어요.</Text>
            : <>
              <Pressable accessibilityRole="button" style={({ pressed }) => [styles.formChip, pressed && { opacity: 0.6 }]} onPress={() => onDraft(message, false)}>
                <Text style={[styles.formChipText, styles.formChipPrimary]}>{message.documentDraft.savedId ? '문서 열기' : '문서 만들기'}</Text>
              </Pressable>
              {!message.documentDraft.savedId && <Pressable accessibilityRole="button" style={({ pressed }) => [styles.formChip, pressed && { opacity: 0.6 }]} onPress={() => onDraft(message, true)}>
                <Text style={styles.formChipText}>취소</Text>
              </Pressable>}
            </>}
        </View>}
        {/* Notion AI의 "페이지로 만들기"처럼: 답의 제목, 목록, 체크리스트, 표가 실제 블록이 된 새 문서 */}
        {message.done && !message.error && !message.projectForm && !message.taskForm && !message.documentLookup && !message.toolResult && !!onMakeDoc && (
          <Pressable accessibilityRole="button" onPress={() => onMakeDoc(message)} hitSlop={6} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 36 }, pressed && { opacity: 0.6 }]}>
            <Icon name="file" size={15} color={colors.muted} /><Text style={{ fontSize: font.caption + 1, color: colors.muted }}>문서로 만들기</Text>
          </Pressable>
        )}
        {sources.length > 0 && (
          <View style={styles.sources}>
            <Text style={styles.sourcesLabel}>출처{sources.some((s) => s.route) ? ', 누르면 해당 위치로 이동해요' : ''}</Text>
            <View style={styles.sourceChips}>
              {sources.map((src) => (
                <Pressable
                  key={src.id}
                  accessibilityRole={src.route ? 'button' : 'text'}
                  accessibilityLabel={src.route ? `출처 ${sourceLabels[src.type] ?? '기록'} ${src.title} 열기` : `첨부 ${src.title}`}
                  disabled={!src.route}
                  onPress={() => onOpenSource(src)}
                  style={({ pressed }) => [styles.sourceChip, pressed && { backgroundColor: colors.mintSoft }]}
                >
                  <Icon name={sourceIcon(src)} size={15} color={colors.mintDark} />
                  <Text style={styles.sourceText} numberOfLines={1}>{src.title}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

export default function AiChatScreen({ navigation, route: navRoute }) {
  // 왼쪽 위: 사이드 메뉴로 열었으면 ☰, 다른 화면(홈의 ✦ 등)에서 왔으면 ‹
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

  // ---------- 상태 ----------
  const restored = useRef(navRoute?.params?.chatId ? getChat(navRoute.params.chatId) : null).current;
  const [chatId, setChatId] = useState(() => restored?.id ?? randomUUID()); // 지금 대화의 기록 id
  const [messages, setMessages] = useState(() => (restored?.messages ?? []).map((m) => (m.role === 'ai' ? { ...m, done: true } : m))); // { id, role, text, done, sources, attachments, error }
  const [input, setInput] = useState(() => String(navRoute?.params?.initialPrompt ?? ''));
  const [status, setStatus] = useState('idle');              // 'idle' | 'thinking' | 'streaming'
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [attachments, setAttachments] = useState([]);        // 보내기 전 첨부 { id, name, kind, status, text, error }
  // 이 대화에서 이미 보낸 첨부의 글자: 뒤이은 질문("예산은?")에도 같이 보냄. 기기 기록에는 저장하지 않음
  const chatFiles = useRef([]);
  const [panel, setPanel] = useState(null);                  // 'history' | 'route' | 'attach' | 'archive' | null
  const [consentBusy, setConsentBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const [usage, setUsage] = useState({ data: null, error: '' }); // 서버 기준 이번 달 사용량
  const [headerBottom, setHeaderBottom] = useState(0);           // 업로드된 파일 창이 여기까지 올라옴
  const [startedAt, setStartedAt] = useState(() => restored?.updatedAt ?? null); // 대화 위 시간 구분선 (새 대화: 첫 질문 시각 · 불러온 대화: 저장 시각)

  const openUsage = async () => {
    setPanel('usage');
    setUsage((u) => ({ data: u.data, error: '' }));
    try { setUsage({ data: await loadAiUsage(), error: '' }); }
    catch (e) { setUsage({ data: null, error: e?.message || '사용량을 불러오지 못했어요' }); }
  };

  const listRef = useRef(null);
  const timers = useRef({ think: null, type: null });
  const dirty = useRef(false);            // 이번 화면에서 새로 주고받은 내용이 있는지 (불러오기만 한 대화는 다시 저장 안 함)
  const extractAbort = useRef(null);
  const nextId = useCallback(() => randomUUID(), []);

  const clearTimers = useCallback(() => {
    clearTimeout(timers.current.think);
    clearInterval(timers.current.type);
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  useEffect(() => () => extractAbort.current?.abort(), []);

  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, () => setKeyboardUp(true));
    const b = Keyboard.addListener(hideEvt, () => setKeyboardUp(false));
    return () => { a.remove(); b.remove(); };
  }, []);

  // 답이 끝나면(쉬는 상태) 지금 대화를 기록에 저장하고, 첫 답이 나온 대화는 내용을 보고 제목을 만듦
  const titled = useRef(new Set()); // 이번 화면에서 이미 제목을 요청한 대화 (실패해도 다시 요청하지 않음)
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
          .catch(() => { /* 제목 만들기 실패: 첫 질문 제목을 그대로 둠 */ });
      }
    }
  }, [status, messages, chatId]);

  // ---------- 제목 수정 ----------
  const [renaming, setRenaming] = useState(null); // { id, value }
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

  // ---------- 첨부 ----------
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

  // ---------- 메시지 보내기 ----------
  const requestRef = useRef(null);
  const actionSaves = useRef(new Set());
  useEffect(() => () => requestRef.current?.abort(), []);
  const send = useCallback(
    async (raw) => {
      const text = raw.trim() || (ready.length ? ATTACH_ONLY_QUESTION : '');
      if (!text || status !== 'idle' || reading) return;
      const taskAction = !ready.length && parseTaskAction(text, todayIn(aiPolicy().timezone));
      if (taskAction) {
        const candidates = taskAction.action === 'change' ? queryTasks({ kind: taskAction.kind, title: taskAction.title })
          .filter(task => !readPreference(`ai-excluded:${task.id}`, false)).map(taskSnapshot) : [];
        const canDraft = !taskAction.error && (taskAction.action === 'create' || candidates.length);
        const form = canDraft ? {
          ...taskAction, candidates, scope: taskScope(), target: candidates.length === 1 ? candidates[0] : null,
          ...(taskAction.action === 'create' && {
            creationId: randomUUID(),
            overlap: Boolean(findOverlap({ ...taskAction.fields, start: taskAction.fields.start ?? '', end: '' })),
          }),
        } : null;
        dirty.current = true;
        if (!messages.length) setStartedAt(Date.now());
        setInput('');
        setMessages(previous => [...previous, { id: nextId(), role: 'user', text },
          { id: nextId(), role: 'ai', done: true, toolResult: true, sources: [],
            text: taskAction.error || (form ? '저장할 내용을 확인해 주세요.' : '현재 공간에서 해당 항목을 찾지 못했어요.'),
            ...(form && { taskForm: form }) }]);
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
        const userId = nextId(), aiId = nextId();
        setInput('');
        setMessages(previous => [...previous, { id: userId, role: 'user', text },
          { id: aiId, role: 'ai', done: true, ...local }]);
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
      // 새 첨부가 앞, 앞서 보낸 첨부가 뒤
      chatFiles.current = [...sentFiles, ...chatFiles.current.filter((f) => !sentFiles.some((s) => s.id === f.id))];
      try {
        answer = await askFromDevice(text, controller.signal, {
          history,
          attachments: turnFiles,
          fileVaultOnly: turnFiles.some(file => file.sourceScope === 'vault'),
          getCatalog: getChatCatalog,
        });
      }
      catch (error) {
        if (!controller.signal.aborted) setMessages((prev) => [...prev, { id: aiId, role: 'ai', text: errorText(error), done: true, sources: [], error: true }]);
        if (requestRef.current === controller) setStatus('idle');
        return;
      }
      if (controller.signal.aborted || requestRef.current !== controller) return;
      if (answer.attachmentWarnings?.length) {
        const omittedIds = new Set(answer.attachmentWarnings.map((file) => file.id));
        setMessages((prev) => prev.map((message) => message.id === userId ? {
          ...message,
          attachments: message.attachments.map((file) => omittedIds.has(file.id)
            ? { ...file, warning: '이번 요청의 AI 자료 한도를 넘어 제외됐어요' }
            : file),
        } : message));
        setBanner(`AI 요청 자료 한도를 넘어 이번 답변에서 제외된 파일: ${answer.attachmentWarnings.map(file => file.name).join(', ')}`);
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

  // 정지: 지금까지 나온 글자는 남기고 멈춤
  const stop = () => {
    requestRef.current?.abort();
    requestRef.current = null;
    clearTimers();
    setMessages((prev) => prev.map((m) => (m.role === 'ai' && !m.done ? { ...m, done: true } : m)));
    setStatus('idle');
  };

  // 진행 중인 답을 멈추고 화면을 비움 (지금 대화는 이미 기록에 저장돼 있음)
  const reset = (next = { id: randomUUID(), messages: [], at: null }) => {
    requestRef.current?.abort();
    requestRef.current = null;
    clearTimers();
    extractAbort.current?.abort();
    extractAbort.current = null;
    if (dirty.current && messages.length) saveChat(chatId, messages.map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
    dirty.current = false;
    chatFiles.current = []; // 불러온 대화에는 첨부 글자가 없음 (기기에 저장하지 않음)
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
  // 작업 검토·출처·생성 항목 화면으로 이동했다가 뒤로 돌아와도 지금 대화가 유지되게 저장하고 id를 남김
  const navigateFromChat = (targetRoute, params) => {
    if (messages.length) {
      if (dirty.current || !getChat(chatId)) saveChat(chatId, messages.map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
      dirty.current = false;
      navigation.setParams?.({ chatId });
    }
    navigation.navigate(targetRoute, params);
  };

  // ---------- 고정 ----------
  const pinned = !!chats.find((c) => c.id === chatId)?.pinnedAt;
  const togglePin = () => {
    setPanel(null);
    const ok = setPinned(chatId, !pinned, messages.map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
    setBanner(!ok ? '답이 끝난 뒤에 고정할 수 있어요' : pinned ? '고정을 해제했어요' : '이 대화를 고정했어요. 이전 대화 맨 위에 보여요');
  };

  // ---------- 이 대화에 올린 파일 ----------
  const chatUploads = messages.flatMap((m) => (m.role === 'user' ? (m.attachments ?? []).map((a) => ({ ...a, messageId: m.id, question: m.text })) : []));
  const jumpTo = (messageId) => {
    setPanel(null);
    const index = messages.findIndex((m) => m.id === messageId);
    if (index >= 0) setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 }), 250);
  };
  // 지금 대화를 기록에서 지우고 빈 대화로 (reset이 다시 저장하지 않도록 dirty를 먼저 내림)
  const deleteCurrent = () => {
    const id = chatId;
    dirty.current = false;
    reset();
    deleteChat(id);
  };
  const openChat = (chat) => reset({ id: chat.id, messages: chat.messages.map((m) => ({ ...m, done: true })), at: chat.updatedAt });

  // ---------- AI 선택 · 전송 허용 ----------
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
  const allow = () => toggleSending(true);

  const canLookup = !chatAttachmentsForTurn(input, ready, chatFiles.current).length && documentLookupTerms(input).length > 0;
  const canSend = (input.trim().length > 0 || ready.length > 0) && status === 'idle' && !reading && (routeReady || canLookup);

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={styles.flex}>
        {/* 머리글: 왼쪽 뒤로 가기 · 가운데 제목 · 오른쪽 [새 채팅 | 더보기] (이전 대화는 더보기 안, AI 선택·사용량은 입력창 오른쪽 아래) */}
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]} onLayout={(e) => setHeaderBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
          {/* 대화 중에는 대화 제목 (자동으로 만든 제목 또는 사용자가 바꾼 제목) · 양옆 버튼과 상관없이 정가운데 */}
          <View pointerEvents="none" style={[styles.headerTitleWrap, { top: insets.top + spacing.sm }]}>
            <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
              {(messages.length > 0 && chats.find((c) => c.id === chatId)?.title) || 'AI 채팅'}
            </Text>
          </View>
          {lead.hidden ? <View style={{ width: 40 }} /> : <CircleButton icon="chevronLeft" label="뒤로 가기" onPress={lead.onPress} />}
          {/* 첫 화면: 이전 대화 하나 · 대화 중: [새 채팅] [더보기] */}
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
            <Pressable accessibilityRole="button" disabled={consentBusy} onPress={allow} style={[styles.noticeBtn, consentBusy && { opacity: 0.5 }]}>
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
            {/* Notion AI처럼 빈 화면은 이름만 (예시 질문 칩 없음) */}
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
              <MessageBubble message={item} onOpenSource={(src) => src.route && navigateFromChat(src.route, openParams(src.type, src.id))}
                onCommand={({ command, originalRequest, memoId, revision, scope }) => {
                  Keyboard.dismiss();
                  navigateFromChat(ROUTES.AppCommand, { command, originalRequest, memoId, fromChat: { ...scope, revision } });
                }}
                onDraft={(message, cancelled) => {
                  const draft = message.documentDraft;
                  const scope = taskScope();
                  const own = runtime();
                  if (scope.workspaceId !== draft.scope.workspaceId || scope.accountId !== draft.scope.accountId
                      || own.closedSpaces.has(scope.workspaceId)) return setBanner('초안을 작성한 공간에서 열어 주세요.');
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
                    if (JSON.stringify(latest?.sections) !== JSON.stringify(draft.sections)) return setBanner('초안에 사용한 항목이 바뀌었어요. 다시 요청해 주세요.');
                    actionSaves.current.add(message.id);
                    try {
                      const savedId = createAiDocument(own, { title: draft.title, text: draft.text, pending: false }, { read: readPreference, write: writePreference }, randomUUID);
                      next = { ...next, savedId };
                    } catch (error) { actionSaves.current.delete(message.id); return setBanner(error.message); }
                  }
                  dirty.current = true;
                  setMessages(previous => previous.map(entry => entry.id === message.id ? { ...entry, documentDraft: next } : entry));
                }}
                onTask={async (message, action, id) => {
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
                      if (form.target && readPreference(`ai-excluded:${form.target.id}`, false)) throw new Error('이 항목은 AI 작업에서 제외됐어요.');
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
                  setMessages(previous => previous.map(entry => entry.id === message.id ? { ...entry, taskForm: form } : entry));
                }}
                onProject={async (message, action, field, value) => {
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
                      if (target && readPreference(`ai-excluded:${target.id}`, false)) throw new Error('이 프로젝트는 AI 작업에서 제외됐어요.');
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
                }}
                onMakeDoc={(answer) => {
                  try {
                    const question = messages[messages.indexOf(answer) - 1]?.text ?? '';
                    const title = (/^#{1,6}\s+(.+)$/m.exec(answer.text)?.[1] || question || answer.text.split('\n')[0]).replace(/\*\*/g, '').trim().slice(0, 40);
                    const id = createAiDocument(runtime(), { title, text: answer.text }, { read: readPreference, write: writePreference }, randomUUID);
                    navigateFromChat(ROUTES.MemoEdit, { memoId: id });
                  } catch (e) { setBanner(e.message); }
                }} />
            )}
            contentContainerStyle={styles.list}
            ListHeaderComponent={startedAt ? <Text style={styles.dayDivider}>{dayLabel(startedAt)}</Text> : null}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            // 아직 그려지지 않은 메시지로 이동할 때: 대략 위치로 먼저 옮긴 뒤 다시 시도
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

      {/* ---------- 보내기 전 첨부 ---------- */}
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

      {/* ---------- 입력창 + 오른쪽 아래 도구 (AI 선택 · 사용량) ---------- */}
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
            {/* 색 점 대신 글자: 쓸 수 없으면 '사용 불가'를 붙임 */}
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

      {/* ---------- 첨부 종류 고르기 ---------- */}
      <Modal transparent visible={panel === 'attach'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPanel(null)}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>첨부하기</Text>
            <Pressable accessibilityRole="button" onPress={() => addFiles('image')} style={styles.option}>
              <Text style={styles.optionName}>사진</Text>
              <Text style={styles.optionSub}>사진 속 글자를 읽어서 함께 보내요 (클라우드 AI, 월 사용 횟수 차감)</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => addFiles('file')} style={styles.option}>
              <Text style={styles.optionName}>파일</Text>
              <Text style={styles.optionSub}>PDF, Word, PowerPoint, 텍스트 파일에서 글자를 꺼내 함께 보내요</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setPanel('archive')} style={styles.option}>
              <Text style={styles.optionName}>파일 보관함에서 선택</Text>
              <Text style={styles.optionSub}>기기 또는 현재 공유 공간에 저장된 파일을 첨부해요</Text>
            </Pressable>
            <Text style={styles.sheetNote}>파일은 대화 기록에 저장되지 않지만, 처리에 필요한 내용은 서버로 전송될 수 있어요. 읽을 수 없는 형식이나 처리 한도를 넘은 파일만 따로 안내해요.</Text>
          </View>
        </Pressable>
      </Modal>

      {/* ---------- AI 선택 ---------- */}
      <Modal transparent visible={panel === 'route'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPanel(null)}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>어떤 AI로 답할까요?</Text>
            {['external', 'self_hosted'].map((id) => {
              const on = id === route;
              const off = id === 'self_hosted' && !LOCAL_AI_AVAILABLE;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: off }}
                  disabled={off}
                  onPress={() => chooseRoute(id)}
                  style={[styles.option, on && styles.optionOn, off && { opacity: 0.5 }]}
                >
                  <Text style={styles.optionName}>{AI_ROUTE_LABEL[id]}{on ? ', 사용 중' : off ? ', 준비 중' : ''}</Text>
                  <Text style={styles.optionSub}>
                    {id === 'external' ? '외부 AI 제공자가 답해요. 빠르고 사진 글자 인식도 돼요' : '팀 서버의 자체 모델이 답해요. 외부 AI로 넘기지 않아요 (서버 연결 후 사용)'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>

      {/* ---------- 더보기 메뉴 (오른쪽 위) ---------- */}
      <Modal transparent visible={panel === 'more'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setPanel(null)}>
          {/* 대화 중에만 열림 (첫 화면은 말풍선 버튼으로 이전 대화만). 아이콘 + 글자 */}
          <View style={[styles.menu, { top: (headerBottom || insets.top + 60) + spacing.xs }]} accessibilityViewIsModal>
            {[
              { key: 'history', label: '이전 대화', icon: 'history', onPress: () => setPanel('history') },
              { key: 'rename', label: '제목 수정', icon: 'pencil', onPress: () => startRename(null) },
              { key: 'pin', label: pinned ? '고정 해제' : '고정', icon: null, onPress: togglePin }, // 압정 모양은 공용 아이콘에 없어 ChatIcons 것을 씀
              { key: 'files', label: `업로드된 파일${chatUploads.length ? ` ${chatUploads.length}` : ''}`, icon: 'paperclip', onPress: () => setPanel('files') },
              { key: 'delete', label: '삭제', icon: 'trash', onPress: deleteCurrent, danger: true },
            ].map(({ key, label, icon, onPress, danger }) => (
              <Pressable key={key} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}>
                {icon ? <Icon name={icon} size={20} color={danger ? colors.coral : colors.ink} /> : <PinIcon size={20} color={colors.ink} />}
                <Text style={[styles.menuText, danger && { color: colors.coral }]}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      {/* ---------- 이번 달 AI 사용량 (서버 기준) ---------- */}
      <Modal transparent visible={panel === 'usage'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPanel(null)}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>이번 달 AI 사용량</Text>
            {usage.error ? (
              <Text style={[styles.optionSub, { color: colors.coral }]}>{usage.error}</Text>
            ) : !usage.data ? (
              <ActivityIndicator color={colors.mintDark} style={{ alignSelf: 'flex-start', marginVertical: spacing.md }} />
            ) : (
              <>
                <Text style={styles.optionSub}>요금제 {PLANS[usage.data.plan].name}</Text>
                {usage.data.items.map((u) => {
                  const ratio = u.limit > 0 ? Math.min(1, u.used / u.limit) : 0;
                  return (
                    <View key={u.key} style={styles.usageRow}>
                      <View style={styles.usageHead}>
                        <Text style={styles.usageLabel}>{u.label}</Text>
                        <Text style={styles.usageNum}>{u.used}/{u.limit}회, 남은 {u.remaining}회</Text>
                      </View>
                      <View style={styles.usageTrack}>
                        <View style={[styles.usageFill, { width: `${ratio * 100}%`, backgroundColor: ratio >= 0.9 ? colors.coral : colors.mint }]} />
                      </View>
                    </View>
                  );
                })}
              </>
            )}
            <Pressable accessibilityRole="button" onPress={() => { setPanel(null); navigation.navigate(ROUTES.Subscription); }} style={styles.option}>
              <Text style={styles.optionName}>요금제 보기</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* ---------- 제목 수정 ---------- */}
      <Modal transparent visible={!!renaming} animationType="fade" onRequestClose={() => setRenaming(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>제목 수정</Text>
            <TextInput
              style={styles.renameInput}
              value={renaming?.value ?? ''}
              onChangeText={(value) => setRenaming((r) => (r ? { ...r, value } : r))}
              onSubmitEditing={saveRename}
              maxLength={TITLE_MAX}
              autoFocus
              selectTextOnFocus
              placeholder="대화 제목"
              placeholderTextColor={colors.muted}
              accessibilityLabel="대화 제목"
            />
            <Text style={styles.sheetNote}>{(renaming?.value ?? '').length} / {TITLE_MAX}자. 직접 바꾼 제목은 AI가 다시 바꾸지 않아요</Text>
            <View style={styles.renameRow}>
              <Pressable accessibilityRole="button" onPress={() => setRenaming(null)} style={[styles.renameBtn, styles.renameCancel]}>
                <Text style={styles.renameCancelText}>취소</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={saveRename} style={[styles.renameBtn, styles.renameSave]}>
                <Text style={styles.renameSaveText}>저장</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* ---------- 업로드된 파일 (아래에서 머리글 바로 아래까지 올라오는 창) ---------- */}
      <UpSheet visible={panel === 'files'} top={headerBottom} title="업로드된 파일" onClose={() => setPanel(null)}>
        {chatUploads.length === 0 ? (
          <Text style={styles.historyEmpty}>올린 사진이나 파일이 없어요</Text>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing.sm }}>
            {chatUploads.map((u) => (
              <Pressable
                key={`${u.messageId}:${u.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${u.name}, 올린 질문으로 이동`}
                onPress={() => jumpTo(u.messageId)}
                style={({ pressed }) => [styles.fileItem, pressed && styles.pressed]}
              >
                <View style={styles.fileBadge}>
                  <Icon name={u.kind === 'image' ? 'image' : 'file'} size={18} color={colors.mintDark} />
                  <Text style={styles.fileBadgeText}>{u.kind === 'image' ? '사진' : u.kind === 'document' ? '문서' : '파일'}</Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.optionName} numberOfLines={1}>{u.name}</Text>
                  <Text style={styles.optionSub} numberOfLines={1}>{u.question}</Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </UpSheet>

      <UpSheet visible={panel === 'archive'} top={headerBottom} title="파일 보관함에서 선택" onClose={() => setPanel(null)}>
        {vaultFiles.length === 0 ? (
          <Text style={styles.historyEmpty}>AI가 읽을 수 있는 파일이 없어요. 먼저 파일 보관함에 파일을 추가해 주세요.</Text>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing.sm }}>
            {vaultFiles.map((file) => {
              const storage = file.storage || 'local';
              const selected = attachments.some((a) => a.archiveFileId === file.id && a.archiveStorage === storage);
              const disabled = status !== 'idle' || selected;
              return (
                <Pressable
                  key={`${storage}:${file.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${file.name}${selected ? ', 이미 첨부됨' : ', AI 채팅에 첨부'}`}
                  accessibilityState={{ disabled, selected }}
                  disabled={disabled}
                  onPress={() => addVaultFile(file)}
                  style={({ pressed }) => [styles.fileItem, disabled && { opacity: 0.55 }, pressed && !disabled && styles.pressed]}
                >
                  <View style={styles.fileBadge}>
                    <Icon name="file" size={18} color={colors.mintDark} />
                    <Text style={styles.fileBadgeText}>{storage === 'cloud' ? '공유' : '기기'}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.optionName} numberOfLines={1}>{file.name}</Text>
                    <Text style={styles.optionSub} numberOfLines={1}>
                      {selected ? '이미 첨부됨' : file.text ? '내용 인식 완료. 선택해 첨부' : '선택하면 파일 내용을 읽어요'}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </UpSheet>

      {/* ---------- 이전 대화 (오른쪽에서 밀려 나오는 창) ---------- */}
      <SlidePanel visible={panel === 'history'} title="이전 대화" onClose={() => setPanel(null)}>
        {chats.length === 0 ? (
          <Text style={styles.historyEmpty}>저장된 대화가 없어요</Text>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing.sm }}>
            {sortChats(chats).map((c) => (
              <View key={c.id} style={[styles.historyItem, c.id === chatId && styles.optionOn]}>
                <Pressable accessibilityRole="button" accessibilityLabel={`${c.pinnedAt ? '고정된 ' : ''}${c.title} 대화 열기`} onPress={() => openChat(c)} style={{ flex: 1, gap: 2 }}>
                  <View style={styles.historyTitleRow}>
                    {!!c.pinnedAt && <View style={styles.pinTag}><Text style={styles.pinTagText}>고정</Text></View>}
                    <Text style={[styles.optionName, { flexShrink: 1 }]} numberOfLines={1}>{c.title}</Text>
                  </View>
                  <Text style={styles.optionSub}>{when(c.updatedAt)}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`${c.title} 제목 수정`} onPress={() => startRename(c)} hitSlop={8} style={({ pressed }) => [styles.rowIconBtn, pressed && styles.pressed]}>
                  <Icon name="pencil" size={17} color={colors.mintDark} />
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`${c.title} 대화 삭제`} onPress={() => (c.id === chatId ? deleteCurrent() : deleteChat(c.id))} hitSlop={8} style={({ pressed }) => [styles.rowIconBtn, pressed && styles.pressed]}>
                  <Icon name="trash" size={17} color={colors.coral} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
      </SlidePanel>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  flex: { flex: 1 },
  // ----- 머리글 -----
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingBottom: spacing.md, backgroundColor: colors.cream },
  // 오른쪽 버튼이 두 개(88)여도 제목이 겹치지 않도록 양옆 여백을 넉넉히
  headerTitleWrap: { position: 'absolute', left: 112, right: 112, height: 40, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: font.header, fontWeight: '800', color: colors.ink },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  pressed: { backgroundColor: colors.mintSoft },
  rowIconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  menuBackdrop: { flex: 1 },
  menu: { position: 'absolute', right: spacing.lg, minWidth: 220, paddingVertical: spacing.sm, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, ...shadow.float, shadowColor: '#263935', shadowOpacity: 0.14 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.md, marginHorizontal: spacing.xs },
  menuText: { fontSize: font.body + 1, fontWeight: '700', color: colors.ink },
  menuLine: { height: 1, backgroundColor: colors.line, marginVertical: spacing.xs },
  historyTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  renameInput: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, paddingHorizontal: spacing.lg, fontSize: font.bodyLg, color: colors.ink },
  renameRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  renameBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  renameCancel: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  renameCancelText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  renameSave: { backgroundColor: colors.action },
  renameSaveText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.onPrimary },
  pinTag: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: colors.mintSoft },
  pinTagText: { fontSize: 11, fontWeight: '800', color: colors.mintDark },
  fileItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  fileBadge: { width: 36, alignItems: 'center', justifyContent: 'center', gap: 1 },
  fileBadgeText: { fontSize: 11, color: colors.muted },
  panelSection: { fontSize: font.caption, fontWeight: '800', color: colors.muted, marginTop: spacing.md },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },

  // ----- 도구 줄 -----
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  inputArea: { backgroundColor: colors.cream, paddingHorizontal: spacing.md, paddingTop: spacing.sm },
  inputTools: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: 6, paddingBottom: 6 },
  usageRow: { gap: 6, paddingVertical: spacing.xs },
  usageHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.sm },
  usageLabel: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  usageNum: { fontSize: font.caption, color: colors.muted },
  usageTrack: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
  usageFill: { height: 8, borderRadius: 4 },
  routeChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line },
  routeText: { fontSize: font.caption + 1, fontWeight: '700', color: colors.ink },
  newChatBtn: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.mintSoft },
  newChatText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  notice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.coralSoft, borderWidth: 1, borderColor: colors.coral },
  noticeText: { flex: 1, fontSize: font.caption + 1, color: colors.ink, lineHeight: 19 },
  noticeBtn: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.action },
  noticeBtnText: { fontSize: font.caption, fontWeight: '800', color: colors.onPrimary },
  banner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.mintSoft },
  bannerText: { flex: 1, fontSize: font.caption + 1, color: colors.ink },

  // ----- 대화가 없을 때 -----
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: 15, color: colors.muted, marginTop: spacing.sm },

  // ----- 대화 목록 -----
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg, gap: spacing.lg },
  dayDivider: { alignSelf: 'center', fontSize: font.caption, color: colors.muted },
  userRow: { alignItems: 'flex-end', gap: 6 },
  // 내 말풍선: 진한 민트 · 오른쪽 아래 모서리만 덜 둥글게
  userBubble: { maxWidth: '80%', backgroundColor: colors.action, paddingHorizontal: spacing.lg, paddingVertical: 11, borderRadius: radius.card, borderBottomRightRadius: 6 },
  userText: { fontSize: font.bodyLg, color: colors.onPrimary, lineHeight: 22 },
  sentFiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, maxWidth: '80%' },
  sentFile: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, maxWidth: '100%' },
  sentFileText: { flexShrink: 1, fontSize: font.caption, fontWeight: '700', color: colors.ink },
  sentFileWarning: { fontSize: 10, color: colors.coral },
  aiRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  // AI 말풍선: 흰 바탕 + 얇은 테두리
  aiBubble: { maxWidth: '100%', paddingVertical: 2 },
  form: { gap: spacing.sm, marginTop: spacing.xs },
  formRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  formChip: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center' },
  formChipStart: { alignSelf: 'flex-start' },
  formChipPrimary: { color: colors.ink, fontWeight: '600' },
  formChipText: { fontSize: 13, color: colors.muted },
  formNote: { fontSize: font.caption + 1, color: colors.muted, lineHeight: 19 },
  aiText: { fontSize: font.bodyLg, color: colors.ink, lineHeight: 22 },
  errorBubble: {},
  errorText: { color: colors.coral, fontSize: font.body },
  aiCol: { flex: 1, gap: spacing.sm },
  aiBubbleFit: { alignSelf: 'flex-start', maxWidth: '100%' },
  sources: { gap: 6 },
  sourcesLabel: { fontSize: font.caption, color: colors.muted },
  sourceChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  // 출처 칩: 흰 바탕 + 테두리, 아이콘 + 굵은 제목
  sourceChip: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line },
  sourceText: { flexShrink: 1, fontSize: font.caption + 1, fontWeight: '800', color: colors.ink },

  // ----- 보내기 전 첨부 -----
  pendingBar: { flexGrow: 0, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  pendingRow: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  pending: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  pendingError: { borderColor: colors.coral },
  pendingName: { fontSize: font.caption, fontWeight: '700', color: colors.ink },
  pendingSub: { fontSize: 11, color: colors.muted },

  // ----- 입력창 -----
  inputBox: { borderRadius: 22, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  toolBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: 44, maxHeight: 140, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 6, fontSize: 15, color: colors.ink },
  sendBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  sendOn: { backgroundColor: colors.action },
  sendOff: { backgroundColor: colors.line },

  // ----- 창 -----
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  sheet: { width: '100%', maxWidth: 380, backgroundColor: colors.cream, borderRadius: radius.lg + 4, padding: spacing.xl, gap: spacing.sm, borderWidth: 1, borderColor: colors.line },
  sheetTitle: { fontSize: font.title - 2, fontWeight: '800', color: colors.ink, marginBottom: spacing.xs },
  sheetNote: { fontSize: font.caption, color: colors.muted, marginTop: spacing.xs, lineHeight: 17 },
  option: { minHeight: 44, justifyContent: 'center', paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: 'transparent', gap: 2 },
  optionOn: { borderColor: colors.ink },
  optionName: { fontSize: font.bodyLg - 1, fontWeight: '500', color: colors.ink },
  optionSub: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  historySheet: { maxWidth: 420 },
  historyHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  historyEmpty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.lg },
  historyItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48, padding: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: 'transparent' },
});
