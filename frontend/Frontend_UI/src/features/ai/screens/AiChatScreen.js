// ============================================================
// AiChatScreen.js — AI 채팅 화면
//   이전 대화(기기에 저장) · 새 채팅 · 사진/파일 첨부 · 클라우드/로컬 AI 선택
// ============================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
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
import { askFromDevice, titleForChat } from '../../../integration/runtime';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
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
import { MAX_ATTACHMENTS, describe, extract, pickAttachments } from '../../../services/ai/ChatAttachments';
import { chatErrorMessage } from '../../../lib/stella/ai-chat';
import { colors, font, radius, shadow, spacing } from '../../../shared/theme/theme';

// 대화가 비어 있을 때 보여줄 "추천 질문" 버튼들. 누르면 그 문장이 바로 전송됩니다.
const SUGGESTIONS = ['중간고사 일정 알려줘', '회의 내용 요약해줘', '발표 자료 어디 있어?', '장보기 목록 알려줘'];
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
const sourceIcon = (src) => (!src.route ? 'paperclip' : src.type === 'memo' ? 'file' : 'calendar');

// AI 쪽 동그란 얼굴 (연한 민트 원 + 반짝이 아이콘)
function Avatar() {
  return (
    <View style={styles.avatar}>
      <Icon name="sparkles" size={16} color={colors.mintDark} />
    </View>
  );
}

// ------------------------------------------------------------
// 입력 중 표시 (● ● ● 가 차례로 깜빡임 · 시안: 진한 민트 → 민트 → 연한 색)
// ------------------------------------------------------------
const DOT_COLORS = [colors.mintDark, colors.mint, colors.line];
function TypingDots() {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.45))).current;
  useEffect(() => {
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.45, duration: 300, useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots]);
  return (
    <View style={styles.aiRow} accessibilityLabel="답변 준비 중">
      <Avatar />
      <View style={[styles.aiBubble, styles.dotsBubble]}>
        {dots.map((v, i) => (
          <Animated.View key={i} style={[styles.dot, { backgroundColor: DOT_COLORS[i], opacity: v }]} />
        ))}
      </View>
    </View>
  );
}

// ------------------------------------------------------------
// 말풍선 하나 (내 메시지 / AI 메시지)
// ------------------------------------------------------------
function MessageBubble({ message, onOpenSource }) {
  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        {message.attachments?.length > 0 && (
          <View style={styles.sentFiles}>
            {message.attachments.map((a) => (
              <View key={a.id} style={styles.sentFile} accessibilityLabel={`${a.kind === 'image' ? '사진' : '파일'} ${a.name}`}>
                <Icon name={a.kind === 'image' ? 'image' : 'file'} size={14} color={colors.mintDark} />
                <Text style={styles.sentFileText} numberOfLines={1}>{a.name}</Text>
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
      <Avatar />
      <View style={styles.aiCol}>
        <View style={[styles.aiBubble, styles.aiBubbleFit, message.error && styles.errorBubble]}>
          <Text style={[styles.aiText, message.error && styles.errorText]} selectable>{message.text}</Text>
        </View>
        {sources.length > 0 && (
          <View style={styles.sources}>
            <Text style={styles.sourcesLabel}>출처{sources.some((s) => s.route) ? ' · 누르면 해당 위치로 이동해요' : ''}</Text>
            <View style={styles.sourceChips}>
              {sources.map((src) => (
                <Pressable
                  key={src.id}
                  accessibilityRole={src.route ? 'button' : 'text'}
                  accessibilityLabel={src.route ? `출처 ${src.type === 'memo' ? '메모' : '일정'} ${src.title} 열기` : `첨부 ${src.title}`}
                  disabled={!src.route}
                  onPress={() => onOpenSource(src)}
                  style={({ pressed }) => [styles.sourceChip, pressed && { backgroundColor: colors.mintSoft }]}
                >
                  {/* 종류는 아이콘으로 구분 (메모 = 문서, 일정 = 달력, 첨부 = 클립) */}
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

export default function AiChatScreen({ navigation }) {
  // 왼쪽 위: 사이드 메뉴로 열었으면 ☰, 다른 화면(홈의 ✦ 등)에서 왔으면 ‹
  const lead = useLeadAction(navigation.goBack);
  const insets = useSafeAreaInsets();
  const settings = useSettings();
  const ai = settings.ai ?? {};
  const route = ai.route === 'self_hosted' ? 'self_hosted' : 'external';
  const routeReady = route === 'external' || LOCAL_AI_AVAILABLE;
  const allowed = !ai.transmissionDisabled && ai.consent?.[route] === true;
  const chats = useChats();

  // ---------- 상태 ----------
  const [chatId, setChatId] = useState(() => randomUUID()); // 지금 대화의 기록 id
  const [messages, setMessages] = useState([]);              // { id, role, text, done, sources, attachments, error }
  const [input, setInput] = useState('');
  const [status, setStatus] = useState('idle');              // 'idle' | 'thinking' | 'streaming'
  const [keyboardUp, setKeyboardUp] = useState(false);
  const [attachments, setAttachments] = useState([]);        // 보내기 전 첨부 { id, name, kind, status, text, error }
  // 이 대화에서 이미 보낸 첨부의 글자: 뒤이은 질문("예산은?")에도 같이 보냄. 기기 기록에는 저장하지 않음
  const chatFiles = useRef([]);
  const [panel, setPanel] = useState(null);                  // 'history' | 'route' | 'attach' | null
  const [consentBusy, setConsentBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const [usage, setUsage] = useState({ data: null, error: '' }); // 서버 기준 이번 달 사용량
  const [headerBottom, setHeaderBottom] = useState(0);           // 업로드된 파일 창이 여기까지 올라옴
  const [startedAt, setStartedAt] = useState(null);              // 대화 위 시간 구분선 (새 대화: 첫 질문 시각 · 불러온 대화: 저장 시각)

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
      const answer = messages.find((m) => m.role === 'ai' && !m.error && m.text)?.text;
      if (chat?.titleSource === 'question' && question && answer && !titled.current.has(chatId)) {
        titled.current.add(chatId);
        const id = chatId;
        titleForChat(question, answer)
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
    setPanel(null);
    let assets;
    try { assets = await pickAttachments(mode); } catch { return setBanner('파일을 고르지 못했어요'); }
    const room = MAX_ATTACHMENTS - attachments.length;
    if (assets.length > room) setBanner(`첨부는 한 번에 ${MAX_ATTACHMENTS}개까지예요`);
    const items = assets.slice(0, Math.max(0, room)).map(describe);
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
  const removeAttachment = (id) => setAttachments((prev) => prev.filter((a) => a.id !== id));
  const reading = attachments.some((a) => a.status === 'reading');
  const ready = attachments.filter((a) => a.status === 'ready');

  // ---------- 메시지 보내기 ----------
  const requestRef = useRef(null);
  useEffect(() => () => requestRef.current?.abort(), []);
  const send = useCallback(
    async (raw) => {
      const text = raw.trim() || (ready.length ? ATTACH_ONLY_QUESTION : '');
      if (!text || status !== 'idle' || reading) return;
      if (!routeReady) return setBanner('로컬 AI는 아직 연결 전이에요. 클라우드 AI로 바꿔 주세요');

      const aiId = nextId();
      const sentFiles = ready.map(({ id, name, kind, text: body }) => ({ id, name, kind, text: body }));
      const history = messages.filter((m) => !m.error && m.text).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }));
      dirty.current = true;
      if (!messages.length) setStartedAt(Date.now());
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text, attachments: sentFiles }]);
      setInput('');
      setAttachments([]);
      extractAbort.current = null;
      setStatus('thinking');

      addUsage('question');
      const controller = new AbortController(); requestRef.current = controller;
      let answer;
      // 새 첨부가 앞, 앞서 보낸 첨부가 뒤 (서버에 한 번에 보내는 첨부는 최대 3개)
      chatFiles.current = [...sentFiles, ...chatFiles.current.filter((f) => !sentFiles.some((s) => s.id === f.id))].slice(0, MAX_ATTACHMENTS);
      try { answer = await askFromDevice(text, controller.signal, { history, attachments: chatFiles.current }); }
      catch (error) {
        if (!controller.signal.aborted) setMessages((prev) => [...prev, { id: aiId, role: 'ai', text: errorText(error), done: true, sources: [], error: true }]);
        if (requestRef.current === controller) setStatus('idle');
        return;
      }
      if (controller.signal.aborted || requestRef.current !== controller) return;
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
  };
  const newChat = () => reset();

  // ---------- 고정 ----------
  const pinned = !!chats.find((c) => c.id === chatId)?.pinnedAt;
  const togglePin = () => {
    setPanel(null);
    const ok = setPinned(chatId, !pinned, messages.map((m) => (m.role === 'ai' ? { ...m, done: true } : m)));
    setBanner(!ok ? '답이 끝난 뒤에 고정할 수 있어요' : pinned ? '고정을 해제했어요' : '이 대화를 고정했어요 · 이전 대화 맨 위에 보여요');
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

  const canSend = (input.trim().length > 0 || ready.length > 0) && status === 'idle' && !reading && routeReady;

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
            <View style={styles.emptyIconWrap}>
              <Icon name="sparkles" size={30} color={colors.mintDark} />
            </View>
            <Text style={styles.emptyTitle}>무엇을 도와드릴까요?</Text>
            <Text style={styles.emptySub}>앱에 저장된 기록과 첨부한 사진·파일을 바탕으로 답해드려요</Text>
            <View style={styles.chips}>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} accessibilityRole="button" onPress={() => send(s)} style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.mintSoft }]}>
                  <Text style={styles.chipText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => (
              <MessageBubble message={item} onOpenSource={(src) => src.route && navigation.navigate(src.route, openParams(src.type, src.id))} />
            )}
            contentContainerStyle={styles.list}
            ListHeaderComponent={startedAt ? <Text style={styles.dayDivider}>{dayLabel(startedAt)}</Text> : null}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            // 아직 그려지지 않은 메시지로 이동할 때: 대략 위치로 먼저 옮긴 뒤 다시 시도
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
              setTimeout(() => listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 }), 100);
            }}
            ListFooterComponent={status === 'thinking' ? <TypingDots /> : null}
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
              {a.status !== 'reading' && <Icon name={a.kind === 'image' ? 'image' : 'file'} size={16} color={a.status === 'error' ? colors.coral : colors.mintDark} />}
              <View style={{ maxWidth: 180 }}>
                <Text style={styles.pendingName} numberOfLines={1} accessibilityLabel={`${a.kind === 'image' ? '사진' : '파일'} ${a.name}`}>{a.name}</Text>
                <Text style={[styles.pendingSub, a.status === 'error' && { color: colors.coral }]} numberOfLines={2}>
                  {a.status === 'reading' ? (a.kind === 'image' ? '사진 글자 읽는 중…' : '글자 꺼내는 중…') : a.status === 'ready' ? `글자 ${a.text.length.toLocaleString()}자 준비됨` : a.error}
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
      <View style={styles.inputBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="사진이나 파일 첨부"
          disabled={status !== 'idle' || attachments.length >= MAX_ATTACHMENTS}
          onPress={() => setPanel('attach')}
          style={[styles.attachBtn, (status !== 'idle' || attachments.length >= MAX_ATTACHMENTS) && { opacity: 0.4 }]}
        >
          <Icon name="plus" size={22} color={colors.mintDark} />
        </Pressable>
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
        {status === 'idle' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="전송"
            accessibilityState={{ disabled: !canSend }}
            onPress={() => send(input)}
            disabled={!canSend}
            style={[styles.sendBtn, canSend ? styles.sendOn : styles.sendOff]}
          >
            <Icon name="arrowUp" size={22} color={colors.white} strokeWidth={2.4} />
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="답변 중지" onPress={stop} style={({ pressed }) => [styles.sendBtn, styles.sendOn, pressed && { opacity: 0.85 }]}>
            <Icon name="stop" size={20} color={colors.white} />
          </Pressable>
        )}
      </View>
      <View style={styles.inputTools}>
        <Pressable accessibilityRole="button" accessibilityLabel={`AI 선택, 지금 ${AI_ROUTE_LABEL[route]}`} onPress={() => setPanel('route')} style={styles.routeChip}>
          <View style={[styles.routeDot, { backgroundColor: !routeReady ? colors.muted : allowed ? colors.mint : colors.coral }]} />
          <Text style={styles.routeText}>{AI_ROUTE_LABEL[route]}</Text>
          <Icon name="chevronDown" size={14} color={colors.muted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="이번 달 AI 사용량" onPress={openUsage} style={styles.routeChip}>
          <Text style={styles.routeText}>사용량</Text>
        </Pressable>
      </View>
      </View>

      {/* ---------- 첨부 종류 고르기 ---------- */}
      <Modal transparent visible={panel === 'attach'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPanel(null)}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>첨부하기</Text>
            <Pressable accessibilityRole="button" onPress={() => addFiles('image')} style={styles.option}>
              <Text style={styles.optionName}>사진</Text>
              <Text style={styles.optionSub}>사진 속 글자를 읽어서 함께 보내요 (클라우드 AI · 월 사용 횟수 차감)</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => addFiles('file')} style={styles.option}>
              <Text style={styles.optionName}>파일</Text>
              <Text style={styles.optionSub}>PDF·Word·PowerPoint·텍스트의 글자를 꺼내서 함께 보내요</Text>
            </Pressable>
            <Text style={styles.sheetNote}>파일은 저장되지 않고, 꺼낸 글자만 질문과 함께 보내요. 한 번에 {MAX_ATTACHMENTS}개까지.</Text>
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
                  <Text style={styles.optionName}>{AI_ROUTE_LABEL[id]}{on ? ' · 사용 중' : off ? ' · 준비 중' : ''}</Text>
                  <Text style={styles.optionSub}>
                    {id === 'external' ? '외부 AI 제공자가 답해요. 빠르고 사진 글자 인식도 돼요' : '팀 서버의 자체 모델이 답해요. 외부 AI로 넘기지 않아요 (서버 연결 후 사용)'}
                  </Text>
                </Pressable>
              );
            })}
            <Text style={styles.sheetNote}>AI를 바꾸면 그 AI로 자료를 보내는 허용을 다시 받아요.</Text>
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
                <Text style={styles.optionSub}>요금제 · {PLANS[usage.data.plan].name}</Text>
                {usage.data.items.map((u) => {
                  const ratio = u.limit > 0 ? Math.min(1, u.used / u.limit) : 0;
                  return (
                    <View key={u.key} style={styles.usageRow}>
                      <View style={styles.usageHead}>
                        <Text style={styles.usageLabel}>{u.label}</Text>
                        <Text style={styles.usageNum}>{u.used} / {u.limit}회 · 남은 {u.remaining}회</Text>
                      </View>
                      <View style={styles.usageTrack}>
                        <View style={[styles.usageFill, { width: `${ratio * 100}%`, backgroundColor: ratio >= 0.9 ? colors.coral : colors.mint }]} />
                      </View>
                    </View>
                  );
                })}
              </>
            )}
            <Text style={styles.sheetNote}>매달 1일(한국 시간)에 다시 채워져요. 요금제를 바꾸면 한도도 바로 바뀌어요.</Text>
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
            <Text style={styles.sheetNote}>{(renaming?.value ?? '').length} / {TITLE_MAX}자 · 직접 바꾼 제목은 AI가 다시 바꾸지 않아요</Text>
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
          <Text style={styles.historyEmpty}>이 대화에 올린 사진·파일이 없어요. 입력창 왼쪽 + 버튼으로 올릴 수 있어요.</Text>
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
                  <Text style={styles.optionSub} numberOfLines={1}>질문 · {u.question}</Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )}
        <Text style={styles.sheetNote}>파일은 저장하지 않고, 꺼낸 글자만 이 대화 동안 질문과 함께 보내요. 누르면 그 파일을 올린 질문으로 이동해요.</Text>
      </UpSheet>

      {/* ---------- 이전 대화 (오른쪽에서 밀려 나오는 창) ---------- */}
      <SlidePanel visible={panel === 'history'} title="이전 대화" onClose={() => setPanel(null)}>
        {chats.length === 0 ? (
          <Text style={styles.historyEmpty}>아직 저장된 대화가 없어요. 질문하면 이 기기에 자동으로 저장돼요.</Text>
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
        <Text style={styles.sheetNote}>대화는 이 기기에만, 지금 공간별로 최대 50개 저장돼요.</Text>
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
  menu: { position: 'absolute', right: spacing.lg, minWidth: 220, paddingVertical: spacing.sm, borderRadius: radius.card, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, ...shadow.float, shadowColor: '#263935', shadowOpacity: 0.14 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.md, marginHorizontal: spacing.xs },
  menuText: { fontSize: font.body + 1, fontWeight: '700', color: colors.ink },
  menuLine: { height: 1, backgroundColor: colors.line, marginVertical: spacing.xs },
  historyTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  renameInput: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: spacing.lg, fontSize: font.bodyLg, color: colors.ink },
  renameRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  renameBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  renameCancel: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  renameCancelText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  renameSave: { backgroundColor: colors.mintDark },
  renameSaveText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  pinTag: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: colors.mintSoft },
  pinTagText: { fontSize: 11, fontWeight: '800', color: colors.mintDark },
  fileItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.card, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  fileBadge: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center', gap: 1 },
  fileBadgeText: { fontSize: 10, fontWeight: '800', color: colors.mintDark },
  panelSection: { fontSize: font.caption, fontWeight: '800', color: colors.muted, marginTop: spacing.md },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },

  // ----- 도구 줄 -----
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  inputArea: { backgroundColor: colors.cream, borderTopWidth: 1, borderTopColor: colors.line },
  inputTools: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: 6 },
  usageRow: { gap: 6, paddingVertical: spacing.xs },
  usageHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.sm },
  usageLabel: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  usageNum: { fontSize: font.caption, color: colors.muted },
  usageTrack: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
  usageFill: { height: 8, borderRadius: 4 },
  routeChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: radius.pill, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  routeDot: { width: 8, height: 8, borderRadius: 4 },
  routeText: { fontSize: font.caption + 1, fontWeight: '700', color: colors.ink },
  newChatBtn: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: 999, backgroundColor: colors.mintSoft },
  newChatText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  notice: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.coralSoft, borderWidth: 1, borderColor: colors.coral },
  noticeText: { flex: 1, fontSize: font.caption + 1, color: colors.ink, lineHeight: 19 },
  noticeBtn: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.pill, backgroundColor: colors.mintDark },
  noticeBtnText: { fontSize: font.caption, fontWeight: '800', color: colors.white },
  banner: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginHorizontal: spacing.lg, marginBottom: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.mintSoft },
  bannerText: { flex: 1, fontSize: font.caption + 1, color: colors.ink },

  // ----- 대화가 없을 때 -----
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyIconWrap: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  emptyTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  emptySub: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.lg },
  chip: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm + 2, borderRadius: radius.pill, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  chipText: { fontSize: font.body, fontWeight: '600', color: colors.ink },

  // ----- 대화 목록 -----
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.lg, gap: spacing.lg },
  dayDivider: { alignSelf: 'center', fontSize: font.caption, color: colors.muted },
  userRow: { alignItems: 'flex-end', gap: 6 },
  // 내 말풍선: 진한 민트 · 오른쪽 아래 모서리만 덜 둥글게
  userBubble: { maxWidth: '80%', backgroundColor: colors.mintDark, paddingHorizontal: spacing.lg, paddingVertical: 11, borderRadius: radius.card, borderBottomRightRadius: 6 },
  userText: { fontSize: 15, color: colors.white, lineHeight: 22 },
  sentFiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, maxWidth: '80%' },
  sentFile: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, maxWidth: '100%' },
  sentFileText: { flexShrink: 1, fontSize: font.caption, fontWeight: '700', color: colors.ink },
  aiRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center' },
  // AI 말풍선: 흰 바탕 + 얇은 테두리
  aiBubble: { maxWidth: '80%', backgroundColor: colors.white, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line },
  aiText: { fontSize: 15, color: colors.ink, lineHeight: 22 },
  errorBubble: { borderColor: colors.coral, backgroundColor: colors.coralSoft },
  errorText: { color: colors.ink, fontSize: font.body },
  aiCol: { flex: 1, maxWidth: '88%', gap: spacing.sm },
  aiBubbleFit: { alignSelf: 'flex-start', maxWidth: '100%' },
  sources: { gap: 6 },
  sourcesLabel: { fontSize: font.caption, color: colors.muted },
  sourceChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  // 출처 칩: 흰 바탕 + 테두리, 아이콘 + 굵은 제목
  sourceChip: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  sourceText: { flexShrink: 1, fontSize: font.caption + 1, fontWeight: '800', color: colors.ink },
  dotsBubble: { flexDirection: 'row', gap: 5, alignItems: 'center', paddingVertical: 14 },
  dot: { width: 7, height: 7, borderRadius: 4 },

  // ----- 보내기 전 첨부 -----
  pendingBar: { flexGrow: 0, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  pendingRow: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  pending: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  pendingError: { borderColor: colors.coral },
  pendingName: { fontSize: font.caption, fontWeight: '700', color: colors.ink },
  pendingSub: { fontSize: 11, color: colors.muted },

  // ----- 입력창 -----
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  attachBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  input: { flex: 1, minHeight: 46, maxHeight: 120, paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12, fontSize: 15, color: colors.ink, backgroundColor: colors.white, borderRadius: 23, borderWidth: 1, borderColor: colors.line },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', marginBottom: 1 },
  sendOn: { backgroundColor: colors.mintDark },
  sendOff: { backgroundColor: colors.mintDark, opacity: 0.35 },

  // ----- 창 -----
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  sheet: { width: '100%', maxWidth: 380, backgroundColor: colors.cream, borderRadius: radius.lg + 4, padding: spacing.xl, gap: spacing.sm, borderWidth: 1, borderColor: colors.line },
  sheetTitle: { fontSize: font.title - 2, fontWeight: '800', color: colors.ink, marginBottom: spacing.xs },
  sheetNote: { fontSize: font.caption, color: colors.muted, marginTop: spacing.xs, lineHeight: 17 },
  option: { padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, gap: 2 },
  optionOn: { borderColor: colors.mintDark, borderWidth: 1.5, backgroundColor: colors.mintSoft },
  optionName: { fontSize: font.bodyLg - 1, fontWeight: '800', color: colors.ink },
  optionSub: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  historySheet: { maxWidth: 420 },
  historyHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  close: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  historyEmpty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.lg },
  historyItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
});
