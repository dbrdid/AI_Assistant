// ============================================================
// AiChatScreen.js — AI 채팅 화면 (앱 전용 AI)
// ============================================================
// 모바일 AI 앱에서 흔히 보는 채팅 화면입니다.
//   - 위쪽  : 헤더 (‹ 뒤로가기, "AI 채팅" 제목, 오른쪽 ✎ = 새 대화)
//   - 가운데 : 대화 내용. 내 메시지는 오른쪽 민트색 말풍선, AI 메시지는 왼쪽 ✦ 아바타 + 흰 말풍선
//             대화가 없을 때는 인사말과 "추천 질문" 버튼이 보임
//   - 아래쪽 : 입력창 + 전송 버튼(↑). AI 가 답하는 동안에는 전송 버튼이 정지 버튼(■)으로 바뀜
//   - 사이드 메뉴 : 헤더/대화 영역에서 "왼쪽 → 오른쪽으로 밀기" 로 열 수 있음 (입력창 위에서는 글자 선택과 겹쳐서 제외)
//
// ★ 앱 전용 AI
//   이 AI 는 앱 안에 저장된 기록(메모, 파일 등)에 대해서만 질문하고 답합니다.
//     - 질문과 관련된 기록을 찾아서 그 내용으로 답하고
//     - 답변 아래에 "출처"(어떤 메모/파일을 참고했는지)를 보여줍니다. 출처를 누르면 그 기록이 있는 화면으로 이동!
//     - 앱 안에서 관련 기록을 못 찾으면 "찾지 못했다"고 답합니다. (앱 밖의 일반 질문에는 답하지 않음)
//   기록 데이터와 답변 만들기는 MemoStore.js 의 answerFromApp() 가 담당합니다.
//
// ★ 지금은 실제 AI 가 연결되어 있지 않습니다.
//   answerFromApp() 가 "키워드가 겹치는 기록을 찾아 보여주는 모형" 답변을 만들고,
//   이 화면이 그것을 글자가 하나씩 나타나는 효과로 보여줍니다.
//   나중에 진짜 AI 를 연결할 때는 answerFromApp() 안쪽만 서버 호출로 바꾸면 됩니다.
//
// props (AppNavigator 가 넣어줌)
//   navigation : 화면 이동 도구 { navigate, goBack }

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { answerFromApp, openParams } from '../../../data/memos/MemoStore';
import { addUsage } from '../../../data/settings/SettingsStore';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

// 대화가 비어 있을 때 보여줄 "추천 질문" 버튼들. 누르면 그 문장이 바로 전송됩니다.
// (MemoStore.js 의 샘플 메모/파일에 있는 내용으로 답할 수 있는 질문들)
const SUGGESTIONS = ['중간고사 일정 알려줘', '회의 내용 요약해줘', '발표 자료 어디 있어?', '장보기 목록 알려줘'];

// ------------------------------------------------------------
// 입력 중 표시 (● ● ● 가 차례로 깜빡임) — AI 가 답을 준비하는 동안 보여줍니다
// ------------------------------------------------------------
function TypingDots() {
  // 점 3개 각각의 투명도 값 (처음엔 흐리게 0.3)
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0.3))).current;

  useEffect(() => {
    // 점마다 시작 시간을 조금씩 늦춰서 "물결"처럼 보이게 함
    const loops = dots.map((v, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 160),
          Animated.timing(v, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(v, { toValue: 0.3, duration: 300, useNativeDriver: true }),
          Animated.delay((2 - i) * 160),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop()); // 사라질 때 정리
  }, [dots]);

  return (
    <View style={styles.aiRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarIcon}>✦</Text>
      </View>
      <View style={[styles.aiBubble, styles.dotsBubble]}>
        {dots.map((v, i) => (
          <Animated.View key={i} style={[styles.dot, { opacity: v }]} />
        ))}
      </View>
    </View>
  );
}

// ------------------------------------------------------------
// 말풍선 하나 (내 메시지 / AI 메시지)
// ------------------------------------------------------------
// onOpenSource(출처): AI 답변 아래 "출처" 칩을 눌렀을 때 호출 → 그 기록이 있는 화면으로 이동
function MessageBubble({ message, onOpenSource }) {
  if (message.role === 'user') {
    // 내 메시지: 오른쪽 정렬, 민트색 말풍선
    return (
      <View style={styles.userRow}>
        <View style={styles.userBubble}>
          <Text style={styles.userText} selectable>{message.text}</Text>
        </View>
      </View>
    );
  }

  // 출처는 답변이 다 나온 뒤(done)에만 보여줌
  const sources = message.done && message.sources ? message.sources : [];

  // AI 메시지: 왼쪽 정렬, 아바타(✦) + (말풍선 + 출처 칩) 세로 묶음
  return (
    <View style={styles.aiRow}>
      <View style={styles.avatar}>
        <Text style={styles.avatarIcon}>✦</Text>
      </View>
      <View style={styles.aiCol}>
        <View style={[styles.aiBubble, styles.aiBubbleFit]}>
          <Text style={styles.aiText} selectable>{message.text}</Text>
        </View>

        {sources.length > 0 && (
          <View style={styles.sources}>
            <Text style={styles.sourcesLabel}>출처 · 누르면 해당 위치로 이동해요</Text>
            <View style={styles.sourceChips}>
              {sources.map((src) => (
                <Pressable
                  key={src.id}
                  accessibilityRole="button"
                  accessibilityLabel={`출처 ${src.title} 열기`}
                  onPress={() => onOpenSource(src)}
                  style={({ pressed }) => [styles.sourceChip, pressed && { opacity: 0.6 }]}
                >
                  <Text style={styles.sourceText} numberOfLines={1}>
                    {src.type === 'memo' ? '📝 ' : src.type === 'task' ? '🗓 ' : src.type === 'project' ? '' : '📎 '}{src.title}
                  </Text>
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
  const menuSwipe = useSwipeToOpenMenu(); // "오른쪽으로 밀면 메뉴" 제스처
  const insets = useSafeAreaInsets();

  // ---------- 상태 ----------
  const [messages, setMessages] = useState([]); // 대화 목록: { id, role: 'user' | 'ai', text }
  const [input, setInput] = useState('');        // 입력창에 적힌 글자
  // status: 지금 AI 가 뭘 하고 있나
  //   'idle'      = 쉬는 중 (새 메시지를 보낼 수 있음)
  //   'thinking'  = 답을 준비하는 중 (● ● ● 표시)
  //   'streaming' = 답을 글자씩 쓰는 중 (정지 버튼으로 멈출 수 있음)
  const [status, setStatus] = useState('idle');
  const [keyboardUp, setKeyboardUp] = useState(false); // 키보드가 올라와 있나 (아래 여백 조절용)

  const listRef = useRef(null);                      // 대화 목록 (맨 아래로 스크롤할 때 사용)
  const timers = useRef({ think: null, type: null }); // 진행 중인 타이머들
  const idRef = useRef(0);                            // 메시지 번호표
  const nextId = useCallback(() => {
    idRef.current += 1;
    return String(idRef.current);
  }, []);

  // 진행 중인 타이머를 모두 멈춤
  const clearTimers = useCallback(() => {
    clearTimeout(timers.current.think);
    clearInterval(timers.current.type);
  }, []);
  // 화면이 사라질 때 타이머 정리 (이 함수 자체를 반환하면 "사라질 때 실행"됨)
  useEffect(() => clearTimers, [clearTimers]);

  // 키보드가 올라오면 아래 안전영역 여백을 빼서 입력창이 키보드에 딱 붙게 함
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEvt, () => setKeyboardUp(true));
    const b = Keyboard.addListener(hideEvt, () => setKeyboardUp(false));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);

  // ---------- 메시지 보내기 ----------
  const send = useCallback(
    (raw) => {
      const text = raw.trim();
      if (!text || status !== 'idle') return; // 빈 글자이거나 AI 가 답하는 중이면 무시

      const aiId = nextId();
      setMessages((prev) => [...prev, { id: nextId(), role: 'user', text }]); // 내 메시지 추가
      setInput('');
      setStatus('thinking'); // ● ● ● 표시 시작

      addUsage('question'); // 설정 > AI 이용량 집계
      const answer = answerFromApp(text); // 앱 안의 기록을 찾아 만든 답변 { text, sources }
      const full = answer.text;          // 보여줄 전체 답변 글자

      // 0.9초 뒤에 답변 시작: 빈 말풍선을 만들고, 30ms 마다 2글자씩 채워 넣음
      timers.current.think = setTimeout(() => {
        setMessages((prev) => [...prev, { id: aiId, role: 'ai', text: '' }]);
        setStatus('streaming');

        let shown = 0;
        timers.current.type = setInterval(() => {
          shown = Math.min(full.length, shown + 2);
          const finished = shown >= full.length;
          // 글자를 채워 넣고, 다 쓰면 done 표시(→ 출처 칩이 나타남)
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiId ? { ...m, text: full.slice(0, shown), sources: answer.sources, done: finished } : m,
            ),
          );
          if (finished) {
            clearInterval(timers.current.type);
            setStatus('idle'); // 다 썼으면 다시 쉬는 상태
          }
        }, 30);
      }, 900);
    },
    [status, nextId],
  );

  // 정지 버튼: 답변 생성을 중간에 멈춤 (지금까지 나온 글자는 그대로 남음)
  const stop = () => {
    clearTimers();
    setStatus('idle');
  };

  // 새 대화: 대화 내용을 모두 지우고 처음 상태로
  const newChat = () => {
    clearTimers();
    setMessages([]);
    setInput('');
    setStatus('idle');
  };

  const canSend = input.trim().length > 0 && status === 'idle';

  return (
    // KeyboardAvoidingView: 키보드가 올라오면 입력창이 가려지지 않게 화면을 밀어 올려 줌
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {/* 헤더 + 대화 영역: 여기에만 "오른쪽으로 밀기" 제스처를 연결 (입력창은 제외) */}
      <View style={styles.flex} {...menuSwipe}>
        <ScreenHeader
          title="AI 채팅"
          onBack={navigation.goBack}
          right={
            <Pressable accessibilityRole="button" accessibilityLabel="새 대화" onPress={newChat} hitSlop={10}>
              <Text style={styles.newChat}>✎</Text>
            </Pressable>
          }
        />

        {messages.length === 0 ? (
          // ---------- 대화가 없을 때: 인사말 + 추천 질문 ----------
          <View style={styles.empty}>
            <View style={styles.emptyIconWrap}>
              <Text style={styles.emptyIcon}>✦</Text>
            </View>
            <Text style={styles.emptyTitle}>무엇을 도와드릴까요?</Text>
            <Text style={styles.emptySub}>앱에 저장된 메모와 파일을 바탕으로 답해드려요</Text>
            <View style={styles.chips}>
              {SUGGESTIONS.map((s) => (
                <Pressable
                  key={s}
                  accessibilityRole="button"
                  onPress={() => send(s)}
                  style={({ pressed }) => [styles.chip, pressed && { backgroundColor: colors.mintSoft }]}
                >
                  <Text style={styles.chipText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          // ---------- 대화 목록 ----------
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={({ item }) => (
              <MessageBubble
                message={item}
                // 출처를 누르면: 그 기록이 있는 화면(메모/파일)으로 이동하면서 해당 항목을 강조
                onOpenSource={(src) => navigation.navigate(src.route, openParams(src.type, src.id))}
              />
            )}
            contentContainerStyle={styles.list}
            // 대화가 길어질 때마다(글자가 늘어날 때도) 맨 아래로 자동 스크롤
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            // AI 가 답을 준비하는 동안 목록 맨 끝에 ● ● ● 표시
            ListFooterComponent={status === 'thinking' ? <TypingDots /> : null}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag" // 목록을 끌면 키보드 내림
          />
        )}
      </View>

      {/* ---------- 입력창 ---------- */}
      <View style={[styles.inputBar, { paddingBottom: keyboardUp ? spacing.sm : insets.bottom + spacing.sm }]}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="앱 안의 기록에 대해 물어보세요"
          placeholderTextColor={colors.muted}
          multiline // 여러 줄 입력 가능 (줄이 늘어나면 입력창도 커짐)
          maxLength={2000}
          accessibilityLabel="메시지 입력"
        />

        {/* 전송 버튼 ↔ 정지 버튼: AI 가 답하는 중이면 ■ 정지, 아니면 ↑ 전송 */}
        {status === 'idle' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="전송"
            accessibilityState={{ disabled: !canSend }}
            onPress={() => send(input)}
            disabled={!canSend}
            style={[styles.sendBtn, canSend ? styles.sendOn : styles.sendOff]}
          >
            <Text style={styles.sendIcon}>↑</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="답변 중지" onPress={stop} style={[styles.sendBtn, styles.sendOn]}>
            <View style={styles.stopSquare} />
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  flex: { flex: 1 },
  newChat: { fontSize: 22, color: colors.ink, textAlign: 'right' },

  // ----- 대화가 없을 때 -----
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.mintSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  emptyIcon: { fontSize: 30, color: colors.mintDark },
  emptyTitle: { fontSize: font.title, fontWeight: '700', color: colors.ink },
  emptySub: { fontSize: font.body, color: colors.muted },
  // flexWrap: 'wrap' → 버튼이 한 줄에 다 안 들어가면 다음 줄로 넘어감
  chips: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.lg },
  chip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.lg + 8,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipText: { fontSize: font.body, color: colors.ink },

  // ----- 대화 목록 -----
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.lg, gap: spacing.md },
  // 내 메시지: 오른쪽 끝으로 붙임 (flex-end)
  userRow: { alignItems: 'flex-end' },
  userBubble: {
    maxWidth: '80%',
    backgroundColor: colors.mintDark,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 20,
    borderBottomRightRadius: 6, // 말풍선 꼬리 느낌
  },
  userText: { fontSize: font.bodyLg, color: colors.white, lineHeight: 22 },
  // AI 메시지: 아바타와 말풍선을 가로로 나란히, 위쪽 맞춤
  aiRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.mintSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarIcon: { fontSize: 15, color: colors.mintDark },
  aiBubble: {
    maxWidth: '80%',
    backgroundColor: colors.white,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 20,
    borderTopLeftRadius: 6,
    borderWidth: 1,
    borderColor: colors.line,
  },
  aiText: { fontSize: font.bodyLg, color: colors.ink, lineHeight: 22 },
  // 말풍선 + 출처 칩을 세로로 묶는 칸 (아바타 오른쪽 영역의 85%)
  aiCol: { width: '85%', gap: spacing.sm },
  // aiCol 안에서는 내용 길이만큼만 차지하도록 (말풍선 최대폭 제한은 aiCol 이 대신 함)
  aiBubbleFit: { alignSelf: 'flex-start', maxWidth: '100%' },
  // 출처 영역
  sources: { gap: 6 },
  sourcesLabel: { fontSize: font.caption, color: colors.muted },
  sourceChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sourceChip: {
    maxWidth: '100%',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.mintSoft,
  },
  sourceText: { fontSize: font.caption, fontWeight: '600', color: colors.mintDark },
  dotsBubble: { flexDirection: 'row', gap: 5, alignItems: 'center', paddingVertical: spacing.lg },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.muted },

  // ----- 입력창 -----
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end', // 입력창이 여러 줄로 커져도 버튼은 아래쪽에 고정
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    backgroundColor: colors.cream,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120, // 이 높이를 넘으면 안에서 스크롤
    paddingHorizontal: spacing.lg,
    paddingTop: 12, // (iOS 는 multiline 에서 위쪽 여백을 직접 줘야 글자가 가운데에 옴)
    paddingBottom: 12,
    fontSize: font.bodyLg,
    color: colors.ink,
    backgroundColor: colors.white,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: colors.line,
  },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendOn: { backgroundColor: colors.mintDark },
  sendOff: { backgroundColor: colors.line },
  sendIcon: { fontSize: 22, fontWeight: '700', color: colors.white },
  stopSquare: { width: 14, height: 14, borderRadius: 3, backgroundColor: colors.white },
});
