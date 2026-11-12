// ============================================================
// MemoEditScreen.js — 메모 쓰기 / 편집 화면 (글자 + 손글씨)
// ============================================================
// 이 화면으로 오는 길
//   - 메모 화면의 ＋ 버튼          → 새 메모 (route.params 없음)
//   - 메모 화면의 메모 카드         → 그 메모 편집 (route.params.memoId)
//
// 입력 방식 3가지 (스토리보드 "편집 도구")
//   ⌨ 키보드 : 키보드로 글자 입력
//   ✎ 펜     : 손가락/펜으로 메모 영역에 직접 필기 (색, 굵기 선택)
//   ⌫ 지우개  : 필기한 획을 문지르는 대로 지움
//   ✋ 이동   : 필기 중에는 한 손가락이 "그리기"라서, 페이지를 위아래로 넘기려면 이 모드로 바꿈
//   ↶ ↷      : 이전 / 다음 (되돌리기 / 다시 실행. 글자 입력, 필기, 지우기 모두)
//   Aa 변환   : 써 둔 손글씨를 글자로 바꿈. 바꿀 영역을 끌어서 지정하거나 [전체 변환]. 변환된 글자는 본문 끝에 들어가고
//              (키보드로 고칠 수 있음) 변환한 필기는 사라짐. 인식은 handwriting.js, 영역 지정은 SelectionOverlay.js
//   ✦ 요약    : 메모 글자를 짧게 요약해 보여주고, 확인하면 본문 끝에 추가 (★ 지금은 임시 요약. 서버 연결 시 AiSummary.js 만 교체)
//
// 메모 영역은 세로로 긴 "페이지"입니다. 글자/필기가 아래로 가면 페이지가 자동으로 늘어납니다.
//
// 저장 방식: "나갈 때 자동 저장" (뒤로가기, 완료, 안드로이드 뒤로가기, 메뉴로 이동 모두)
//   - 글자도 필기도 없으면 새 메모는 저장하지 않고, 기존 메모는 삭제됨
// 필기(strokes)는 메모에 함께 저장됩니다. (저장소는 MemoStore.js, 그리기는 InkCanvas.js)
//
// props (AppNavigator 가 넣어줌)
//   navigation : 화면 이동 도구
//   route      : { name, params: { memoId } }   (memoId 가 없으면 새 메모)

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
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
import { useInsets as useSafeAreaInsets } from '../../../shared/hooks/useInsets';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import InkCanvas from '../components/InkCanvas';
import PhotoStrip from '../components/PhotoStrip';
import MemoLinks from '../components/MemoLinks';
import { ROUTES } from '../../../navigation/routes';
import { analyzeText } from '../../../services/ai/AiAnalyze';
import SelectionOverlay from '../components/SelectionOverlay';
import { recognizeStrokes } from '../../../services/ai/Handwriting';
import { strokesInRect } from '../utils/InkUtils';
import useSwipeToOpenMenu from '../../../navigation/useSwipeToOpenMenu';
import { STORAGE_INFO, addMemo, deleteMemoForever, getMemo, trashMemo, updateMemo } from '../../../data/memos/MemoStore';
import { projectOf, setItemProject, useProjects } from '../../../data/projects/ProjectStore';
import { summarizeText } from '../../../services/ai/AiSummary';
import { addUsage } from '../../../data/settings/SettingsStore';
import { ErrorModal } from '../../error/components/ErrorViews';
import { classifyError, isOfflineMode } from '../../../services/device/Network';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

// 펜 색 / 굵기 선택지
const PEN_COLORS = [colors.ink, colors.coral, colors.mintDark, '#4A6FA5'];
const PEN_WIDTHS = [2, 4, 8];

// 도구 줄의 버튼 하나 (아이콘 + 작은 글자)
function ToolBtn({ icon, label, active, disabled, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.tool, active && styles.toolOn, disabled && { opacity: 0.35 }]}
    >
      <Text style={[styles.toolIcon, active && styles.toolIconOn]}>{icon}</Text>
      <Text style={[styles.toolLabel, active && styles.toolIconOn]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

export default function MemoEditScreen({ navigation, route }) {
  const menuSwipe = useSwipeToOpenMenu();
  const insets = useSafeAreaInsets();

  const memoId = route.params?.memoId;
  // 편집할 기존 메모 (새 메모면 null). 화면이 열릴 때 한 번만 찾음
  const original = useMemo(() => (memoId ? getMemo(memoId) : null), [memoId]);

  // ---------- 입력 상태 ----------
  const [title, setTitle] = useState(original ? original.title : '');
  const [body, setBody] = useState(original ? original.body : '');
  const [strokes, setStrokes] = useState(original?.strokes || []); // 손글씨 획들
  const [mode, setMode] = useState('keyboard');   // 'keyboard' | 'pen' | 'eraser' | 'move' | 'convert'
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1]);
  const [confirmDelete, setConfirmDelete] = useState(false); // 삭제 확인 창 표시 여부
  const [keyboardUp, setKeyboardUp] = useState(false);       // 키보드가 올라와 있나 (아래 여백 조절용)
  const [notice, setNotice] = useState('');                  // 잠깐 보여주는 안내 글자
  const [errView, setErrView] = useState(null); // 오류 안내 창 { kind:'network'|'server', retry }
  const [converting, setConverting] = useState(false);       // 손글씨를 글자로 바꾸는 중인가
  const bodyRef = useRef(null);

  // ---------- 프로젝트 (이 메모가 들어갈 "상위 폴더") ----------
  // 기존 메모는 지금 속한 프로젝트, 새 메모는 프로젝트 화면에서 넘겨준 projectId (없으면 없음)
  const projects = useProjects();
  const [projectId, setProjectId] = useState(() =>
    original ? projectOf('memos', original.id)?.id ?? null : route.params?.projectId ?? null,
  );
  const [pickingProject, setPickingProject] = useState(false);
  const projectName = projects.find((p) => p.id === projectId)?.title;

  // ---------- 페이지(스크롤되는 메모 영역) 크기 ----------
  const scrollRef = useRef(null);
  const scrollY = useRef(0);
  const [viewH, setViewH] = useState(400);   // 화면에 보이는 메모 영역 높이

  // ---------- "나갈 때 자동 저장" 을 위한 준비 ----------
  // 화면이 사라질 때 실행되는 코드는 "그때의 최신 입력값"이 필요해서 ref 에 계속 복사해 둡니다.
  const latest = useRef({ title, body, strokes, projectId });
  latest.current = { title, body, strokes, projectId };
  const skipSave = useRef(false);                          // true 면 나갈 때 저장하지 않음 (삭제한 경우)
  const savedId = useRef(original ? original.id : null);   // 기존 메모의 번호 (새 메모면 null)

  // 이 화면이 사라질 때(어떤 방법으로 나가든) 한 번 실행됨
  useEffect(
    () => () => {
      if (skipSave.current) return;
      const t = latest.current.title.trim();
      const b = latest.current.body.trim();
      const s = latest.current.strokes;
      const id = savedId.current;
      const empty = !t && !b && s.length === 0; // 글자도 필기도 없음

      if (!id) {
        // 새 메모: 내용이 있을 때만 추가
        if (!empty) {
          const m = addMemo({ title: t, body: b, strokes: s });
          if (b) analyzeText({ sourceType: 'memo', sourceId: m.id, sourceTitle: t || b.slice(0, 20), text: b });
          if (latest.current.projectId) setItemProject('memos', m.id, latest.current.projectId);
        }
        return;
      }
      // 기존 메모
      if (empty) {
        deleteMemoForever(id); // 전부 지웠으면 빈 메모는 휴지통 없이 바로 삭제
        return;
      }
      const current = getMemo(id);
      const changed =
        current &&
        (current.title !== t ||
          current.body !== b ||
          JSON.stringify(current.strokes || []) !== JSON.stringify(s));
      if (changed) {
        updateMemo(id, { title: t, body: b, strokes: s }); // 바뀐 게 있을 때만 수정(수정일이 괜히 바뀌지 않게)
        if (b && current.body !== b) analyzeText({ sourceType: 'memo', sourceId: id, sourceTitle: t || b.slice(0, 20), text: b });
      }
      // 프로젝트를 바꿨으면 연결도 바꿈
      const nowProject = projectOf('memos', id)?.id ?? null;
      if (nowProject !== latest.current.projectId) setItemProject('memos', id, latest.current.projectId);
    },
    [],
  );

  // ---------- 되돌리기 / 다시 실행 ----------
  // hist.list : 지금까지의 "상태 사진" 목록 ({ body, strokes }). hist.i : 지금 보고 있는 사진 번호
  const hist = useRef({ list: [{ body: original ? original.body : '', strokes: original?.strokes || [] }], i: 0 });
  const textTimer = useRef(null); // 글자 입력은 잠깐 멈췄을 때 한 번에 기록(글자마다 기록하면 되돌리기가 너무 잘게 쪼개짐)
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncButtons = () => {
    setCanUndo(hist.current.i > 0);
    setCanRedo(hist.current.i < hist.current.list.length - 1);
  };

  // 현재 상태를 기록. 직전 기록과 같으면 무시
  const record = useCallback(() => {
    const h = hist.current;
    const snap = { body: latest.current.body, strokes: latest.current.strokes };
    const cur = h.list[h.i];
    if (cur.body === snap.body && cur.strokes === snap.strokes) return;
    h.list = h.list.slice(0, h.i + 1); // 되돌린 뒤 새로 쓰면 "다시 실행" 기록은 버림
    h.list.push(snap);
    if (h.list.length > 100) h.list.shift(); // 최대 100단계
    h.i = h.list.length - 1;
    syncButtons();
  }, []);

  // 아직 기록 안 된 글자 입력이 있으면 지금 기록
  const flushText = useCallback(() => {
    if (textTimer.current) {
      clearTimeout(textTimer.current);
      textTimer.current = null;
      record();
    }
  }, [record]);
  useEffect(() => () => clearTimeout(textTimer.current), []);

  const onChangeBody = (t) => {
    setBody(t);
    clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      textTimer.current = null;
      record(); // 이 시점엔 latest.current 가 이미 새 글자로 갱신돼 있음
    }, 700);
  };

  // 필기를 하나 그렸거나 지웠을 때 (InkCanvas 가 호출)
  const onStrokesChange = (next) => {
    flushText();
    latest.current = { ...latest.current, strokes: next }; // 기록 함수가 새 값을 보도록 먼저 갱신
    setStrokes(next);
    record();
  };

  const restore = (snap) => {
    latest.current = { ...latest.current, body: snap.body, strokes: snap.strokes };
    setBody(snap.body);
    setStrokes(snap.strokes);
    syncButtons();
  };
  const undo = () => {
    flushText();
    const h = hist.current;
    if (h.i > 0) {
      h.i -= 1;
      restore(h.list[h.i]);
    }
  };
  const redo = () => {
    const h = hist.current;
    if (h.i < h.list.length - 1) {
      h.i += 1;
      restore(h.list[h.i]);
    }
  };

  // ---------- 모드 전환 ----------
  const chooseMode = (m) => {
    setMode(m);
    if (m === 'keyboard') {
      setTimeout(() => bodyRef.current?.focus(), 0);
    } else {
      Keyboard.dismiss(); // 키보드 모드가 아닐 땐 키보드를 내려서 메모 공간을 넓게
    }
  };

  // ---------- 손글씨 → 글자 변환 ----------
  // 글자와 필기를 "한 번에" 바꾸고 되돌리기 기록도 한 단계로 남김
  const commitBoth = (nextStrokes, nextBody) => {
    flushText();
    latest.current = { ...latest.current, strokes: nextStrokes, body: nextBody };
    setStrokes(nextStrokes);
    setBody(nextBody);
    record();
  };

  // targetStrokes(바꿀 필기들)를 글자로 인식해서 본문 끝에 넣고, 그 필기는 지움
  const convert = async (targetStrokes) => {
    if (targetStrokes.length === 0) {
      showNotice('선택한 영역에 손글씨가 없어요');
      return;
    }
    if (isOfflineMode()) {
      setErrView({ kind: 'network', retry: () => convert(targetStrokes) }); // 오프라인 모드에서는 연결 안내를 다시 보여줌
      return;
    }
    setConverting(true);
    try {
      const text = await recognizeStrokes(targetStrokes);
      addUsage('convert'); // 설정 > AI 이용량 집계
      if (!text) {
        showNotice('글자를 알아보지 못했어요. 또박또박 써 보세요');
        return; // 필기는 그대로 둠
      }
      const gone = new Set(targetStrokes.map((st) => st.id));
      const cur = latest.current.body;
      const nextBody = cur ? `${cur}${cur.endsWith('\n') ? '' : '\n'}${text}` : text;
      commitBoth(latest.current.strokes.filter((st) => !gone.has(st.id)), nextBody);
      chooseMode('keyboard'); // 바로 글자를 고칠 수 있게 키보드 모드로
      showNotice('글자로 바꿨어요. 틀린 글자는 직접 고쳐 주세요');
    } catch (e) {
      setErrView({ kind: classifyError(e), retry: () => convert(targetStrokes) }); // 필기는 그대로 남아 있음
    } finally {
      setConverting(false);
    }
  };

  // 글자 내용의 높이를 "글자 수로 추정"합니다.
  // (입력창의 실제 높이를 재서 페이지 높이에 반영하면, 입력창이 페이지를 채우고 있어서
  //  "높이가 커짐 → 페이지가 커짐 → 또 커짐" 으로 끝없이 반복되는 오류가 납니다)
  //  한 줄에 16글자, 줄 높이 24px 로 넉넉하게 잡음 → 실제보다 약간 크게 나옴
  const textH = useMemo(() => {
    const lines = body.split('\n').reduce((n, ln) => n + Math.max(1, Math.ceil(Array.from(ln).length / 16)), 0);
    return lines * 24 + spacing.md;
  }, [body]);

  // 글자가 길어져서 아래 칸에 닿으면 따라서 스크롤 (키보드 입력 중이거나 손글씨 키보드 사용 중일 때만)
  useEffect(() => {
    const typing = mode === 'convert' || (bodyRef.current && bodyRef.current.isFocused && bodyRef.current.isFocused());
    if (typing && textH > scrollY.current + viewH - 30) {
      scrollRef.current?.scrollTo({ y: Math.max(0, textH - viewH + 60), animated: false });
    }
  }, [textH, mode, viewH]);

  // 필기가 가장 아래로 내려간 위치 (페이지 높이 계산용)
  const strokeBottom = useMemo(() => {
    let m = 0;
    strokes.forEach((st) => st.p.forEach((pt) => { if (pt[1] > m) m = pt[1]; }));
    return m;
  }, [strokes]);
  // 페이지 높이: 화면의 2배를 기본으로, 글자/필기가 아래로 가면 그보다 240px 더 여유를 둠
  const pageH = Math.max(viewH * 2, textH + 240, strokeBottom + 240);

  // ---------- AI 요약 (임시. 실제 요약은 AiSummary.js 가 담당) ----------
  // summary: null(창 닫힘) | { status: 'loading' | 'done' | 'error', text }
  const [summary, setSummary] = useState(null);
  const summaryReq = useRef(0); // 요청 번호: 닫았다가 다시 눌렀을 때 옛날 답이 끼어들지 않게
  const requestSummary = async () => {
    const text = latest.current.body.trim();
    if (!text) {
      showNotice(latest.current.strokes.length > 0 ? '손글씨는 [변환]으로 글자로 바꾼 뒤 요약할 수 있어요' : '요약할 내용이 없어요');
      return;
    }
    if (isOfflineMode()) {
      setErrView({ kind: 'network', retry: requestSummary });
      return;
    }
    Keyboard.dismiss();
    summaryReq.current += 1;
    const my = summaryReq.current;
    setSummary({ status: 'loading', text: '' });
    try {
      const out = await summarizeText(text);
      addUsage('summary'); // 설정 > AI 이용량 집계
      if (my === summaryReq.current) setSummary({ status: 'done', text: out });
    } catch (e) {
      if (my === summaryReq.current) {
        if (classifyError(e) === 'network') {
          setSummary(null);
          setErrView({ kind: 'network', retry: requestSummary });
        } else {
          setSummary({ status: 'error', text: '' });
        }
      }
    }
  };
  const closeSummary = () => {
    summaryReq.current += 1;
    setSummary(null);
  };
  // 요약을 본문 끝에 추가 (되돌리기 한 단계)
  const addSummary = () => {
    const cur = latest.current.body;
    const next = `${cur}${cur.endsWith('\n') ? '' : '\n'}\n[AI 요약]\n${summary.text}`;
    commitBoth(latest.current.strokes, next);
    closeSummary();
    showNotice('요약을 메모에 추가했어요');
  };

  // 준비 중인 기능 안내 (2초 뒤 사라짐)
  const noticeTimer = useRef(null);
  const showNotice = (msg) => {
    setNotice(msg);
    clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 2000);
  };
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // 키보드가 올라오면 아래 안전영역 여백을 빼서 도구 줄이 키보드에 딱 붙게 함
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

  // 삭제 확정: 저장하지 않고 나가도록 표시한 뒤 메모를 지우고 이전 화면으로
  const onDelete = () => {
    skipSave.current = true;
    if (savedId.current) trashMemo(savedId.current); // 휴지통으로 이동 (휴지통에서 복구 가능)
    setConfirmDelete(false);
    navigation.goBack();
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {/* 헤더 (여기에 밀기 제스처 연결. 입력창/필기 영역은 겹쳐서 제외) */}
      <View {...menuSwipe}>
        <ScreenHeader
          title={original ? '메모 편집' : '새 메모'}
          onBack={navigation.goBack}
          right={
            <Pressable accessibilityRole="button" accessibilityLabel="완료" onPress={navigation.goBack} hitSlop={10}>
              <Text style={styles.done}>완료</Text>
            </Pressable>
          }
        />
      </View>

      {/* ---------- 입력 영역 ---------- */}
      <View style={styles.editor}>
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={setTitle}
          placeholder="제목"
          placeholderTextColor={colors.muted}
          autoFocus={!original} // 새 메모일 때만 바로 키보드가 올라옴
          maxLength={80}
          accessibilityLabel="메모 제목"
        />

        {original && <MemoLinks memoId={original.id} navigation={navigation} />}
        {original && <PhotoStrip memoId={original.id} />}

        {/* 메모 영역: 위아래로 스크롤되는 긴 페이지. 글자 입력창 위에 필기 캔버스를 겹쳐 둠.
            펜/지우개일 땐 한 손가락이 "그리기"라서 스크롤을 잠그고, ✋ 이동 모드에서 넘김 */}
        <ScrollView
          ref={scrollRef}
          style={styles.scroll}
          scrollEnabled={mode === 'keyboard' || mode === 'move'}
          keyboardShouldPersistTaps="handled"
          onLayout={(e) => setViewH(e.nativeEvent.layout.height)}
          onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
        >
          <View style={{ height: pageH }}>
            <TextInput
              ref={bodyRef}
              style={styles.bodyInput}
              value={body}
              onChangeText={onChangeBody}
              editable={mode === 'keyboard'} // 다른 모드에서는 글자 입력 잠금
              placeholder={mode === 'keyboard' ? '내용을 입력하세요' : ''}
              placeholderTextColor={colors.muted}
              multiline
              scrollEnabled={false} // 입력창 자체는 스크롤하지 않고 위의 ScrollView 가 움직임
              textAlignVertical="top" // 안드로이드에서 글자가 위쪽부터 시작하게
              accessibilityLabel="메모 내용"
            />
            <InkCanvas strokes={strokes} mode={mode} color={penColor} width={penWidth} onChange={onStrokesChange} />
            {/* 변환 모드: 바꿀 영역을 끌어서 지정 */}
            {mode === 'convert' && !converting && (
              <SelectionOverlay onSelect={(r) => convert(strokesInRect(latest.current.strokes, r))} />
            )}
          </View>
        </ScrollView>
      </View>

      {/* ---------- 펜 옵션 (펜 모드일 때만): 색 + 굵기 ---------- */}
      {mode === 'pen' && (
        <View style={styles.penOptions}>
          <View style={styles.optGroup}>
            {PEN_COLORS.map((c) => (
              <Pressable
                key={c}
                accessibilityRole="button"
                accessibilityLabel="펜 색"
                accessibilityState={{ selected: penColor === c }}
                onPress={() => setPenColor(c)}
                hitSlop={6}
                style={[styles.colorDot, { backgroundColor: c }, penColor === c && styles.colorDotOn]}
              />
            ))}
          </View>
          <View style={styles.optGroup}>
            {PEN_WIDTHS.map((w) => (
              <Pressable
                key={w}
                accessibilityRole="button"
                accessibilityLabel={`펜 굵기 ${w}`}
                accessibilityState={{ selected: penWidth === w }}
                onPress={() => setPenWidth(w)}
                hitSlop={6}
                style={[styles.widthBox, penWidth === w && styles.widthBoxOn]}
              >
                <View style={{ width: 22, height: w, borderRadius: w / 2, backgroundColor: colors.ink }} />
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* ---------- 변환 안내 줄 (변환 버튼을 눌렀을 때) ---------- */}
      {mode === 'convert' && (
        <View style={styles.convertBar}>
          <Text style={styles.convertHint} numberOfLines={2}>
            {converting ? '글자로 바꾸는 중…' : '바꿀 손글씨 영역을 끌어서 선택하거나 [전체 변환]을 누르세요'}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={converting}
            onPress={() => convert(latest.current.strokes)}
            style={[styles.convertAll, converting && { opacity: 0.4 }]}
          >
            <Text style={styles.convertAllText}>전체 변환</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="변환 닫기" onPress={() => chooseMode('keyboard')} hitSlop={10}>
            <Text style={styles.convertClose}>✕</Text>
          </Pressable>
        </View>
      )}

      {/* ---------- 도구 줄: 입력 방식 | 이전·다음 | 요약·변환 ---------- */}
      <View style={[styles.tools, mode !== 'keyboard' && { paddingBottom: keyboardUp ? 0 : insets.bottom }]}>
        {!!notice && <Text style={styles.notice}>{notice}</Text>}
        <View style={styles.toolRow}>
          <ToolBtn icon="⌨" label="키보드" active={mode === 'keyboard'} onPress={() => chooseMode('keyboard')} />
          <ToolBtn icon="✎" label="펜" active={mode === 'pen'} onPress={() => chooseMode('pen')} />
          <ToolBtn icon="⌫" label="지우개" active={mode === 'eraser'} onPress={() => chooseMode('eraser')} />
          <ToolBtn icon="✋" label="이동" active={mode === 'move'} onPress={() => chooseMode('move')} />
          <View style={styles.sep} />
          <ToolBtn icon="↶" label="이전" disabled={!canUndo} onPress={undo} />
          <ToolBtn icon="↷" label="다음" disabled={!canRedo} onPress={redo} />
          <View style={styles.sep} />
          <ToolBtn icon="✦" label="요약" onPress={requestSummary} />
          <ToolBtn icon="Aa" label="변환" active={mode === 'convert'} onPress={() => {
            if (mode === 'convert') chooseMode('keyboard');
            else if (strokes.length === 0) showNotice('변환할 손글씨가 없어요. 펜으로 먼저 써 보세요');
            else chooseMode('convert');
          }} />
        </View>
      </View>

      {/* ---------- 아래 정보 줄: 저장 위치 + (기존 메모면) 삭제 버튼 ---------- */}
      {mode === 'keyboard' && (
      <View style={[styles.toolbar, { paddingBottom: keyboardUp ? spacing.sm : insets.bottom + spacing.sm }]}>
        <View style={styles.toolInfo}>
          <Text style={styles.toolText}>
            {STORAGE_INFO.local.icon} {STORAGE_INFO.local.label} · {STORAGE_INFO.local.desc}
          </Text>
          {original && <Text style={styles.toolSub}>마지막 수정 {original.date}</Text>}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`프로젝트 선택, 현재 ${projectName || '없음'}`}
            onPress={() => setPickingProject(true)}
            hitSlop={8}
          >
            <Text style={styles.toolProject}>{projectName || '프로젝트 선택'} ▾</Text>
          </Pressable>
        </View>
        {original && (
          <Pressable accessibilityRole="button" accessibilityLabel="메모 삭제" onPress={() => setConfirmDelete(true)} hitSlop={8}>
            <Text style={styles.delete}>🗑 삭제</Text>
          </Pressable>
        )}
      </View>
      )}

      {/* ---------- 프로젝트 고르기 창 ---------- */}
      <Modal transparent visible={pickingProject} animationType="fade" onRequestClose={() => setPickingProject(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>프로젝트 선택</Text>
            <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: spacing.sm }}>
              {[{ id: null, title: '프로젝트 없음' }, ...projects].map((p) => {
                const on = projectId === p.id;
                return (
                  <Pressable
                    key={p.id ?? 'none'}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                    onPress={() => {
                      setProjectId(p.id);
                      setPickingProject(false);
                    }}
                    style={[styles.projOpt, on && styles.projOptOn]}
                  >
                    <Text style={[styles.projOptText, on && { color: colors.white, fontWeight: '800' }]} numberOfLines={1}>
                      {p.title}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            {projects.length === 0 && <Text style={styles.toolSub}>아직 프로젝트가 없어요. 프로젝트 화면에서 먼저 만들어 주세요.</Text>}
            <Pressable accessibilityRole="button" onPress={() => setPickingProject(false)} style={styles.projClose}>
              <Text style={styles.projCloseText}>닫기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* ---------- AI 요약 창 (스토리보드 64장: 요약을 보여주고 확인 후 메모에 추가) ---------- */}
      <Modal transparent visible={summary !== null} animationType="fade" onRequestClose={closeSummary}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>✦ AI 요약</Text>
            {summary?.status === 'loading' && <Text style={styles.dialogSub}>메모를 요약하는 중…</Text>}
            {summary?.status === 'error' && (
              <Text style={styles.dialogSub}>요약에 실패했어요. 잠시 뒤 다시 시도해 주세요.</Text>
            )}
            {summary?.status === 'done' && (
              <>
                <Text style={styles.summaryText} selectable>{summary.text}</Text>
                <Text style={styles.dialogSub}>※ 임시 요약이에요 (서버 연결 전)</Text>
              </>
            )}
            <View style={styles.dialogButtons}>
              <Pressable accessibilityRole="button" onPress={closeSummary} style={[styles.dialogBtn, styles.cancelBtn]}>
                <Text style={styles.cancelText}>{summary?.status === 'done' ? '취소' : '닫기'}</Text>
              </Pressable>
              {summary?.status === 'done' && (
                <Pressable accessibilityRole="button" onPress={addSummary} style={[styles.dialogBtn, styles.addBtn]}>
                  <Text style={styles.deleteText}>메모에 추가</Text>
                </Pressable>
              )}
            </View>
          </View>
        </View>
      </Modal>

      {/* ---------- 오류 안내 창 (네트워크/서버) ---------- */}
      <ErrorModal
        kind={errView ? errView.kind : 'network'}
        visible={errView !== null}
        onClose={() => setErrView(null)}
        onRetry={() => errView && errView.retry && errView.retry()}
        onHome={() => navigation.navigate(ROUTES.Home)}
      />

      {/* ---------- 삭제 확인 창 ---------- */}
      <Modal transparent visible={confirmDelete} animationType="fade" onRequestClose={() => setConfirmDelete(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>이 메모를 삭제할까요?</Text>
            <Text style={styles.dialogSub}>휴지통으로 이동해요. 휴지통에서 복구할 수 있어요.</Text>
            <View style={styles.dialogButtons}>
              <Pressable accessibilityRole="button" onPress={() => setConfirmDelete(false)} style={[styles.dialogBtn, styles.cancelBtn]}>
                <Text style={styles.cancelText}>취소</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={onDelete} style={[styles.dialogBtn, styles.deleteBtn]}>
                <Text style={styles.deleteText}>삭제</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  done: { fontSize: font.bodyLg, fontWeight: '700', color: colors.mintDark, textAlign: 'right' },

  editor: { flex: 1, paddingHorizontal: spacing.lg },
  titleInput: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  // 글자 입력창 + 필기 캔버스가 겹치는 스크롤 영역
  scroll: { flex: 1 },
  bodyInput: {
    flex: 1, // 페이지(부모 View) 전체를 차지
    fontSize: font.bodyLg,
    lineHeight: 24,
    color: colors.ink,
    paddingTop: spacing.md,
  },

  // 펜 옵션 줄
  penOptions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.cream,
  },
  optGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  colorDot: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
  colorDotOn: { borderColor: colors.mint, transform: [{ scale: 1.15 }] },
  widthBox: { width: 40, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  widthBoxOn: { backgroundColor: colors.mintSoft },

  // 변환 안내 줄
  convertBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.mintSoft,
  },
  convertHint: { flex: 1, fontSize: font.caption, color: colors.mintDark, fontWeight: '700' },
  convertAll: { paddingHorizontal: spacing.md, minHeight: 34, borderRadius: 999, backgroundColor: colors.mintDark, justifyContent: 'center' },
  convertAllText: { fontSize: font.body, fontWeight: '700', color: colors.white },
  convertClose: { fontSize: 18, color: colors.muted },

  // 도구 줄
  tools: { borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.cream },
  notice: { textAlign: 'center', fontSize: font.caption, color: colors.mintDark, fontWeight: '700', paddingTop: spacing.sm },
  toolRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  tool: { flex: 1, minHeight: 48, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', gap: 1 },
  toolOn: { backgroundColor: colors.mintSoft },
  toolIcon: { fontSize: 20, color: colors.ink },
  toolIconOn: { color: colors.mintDark, fontWeight: '800' },
  toolLabel: { fontSize: 10, color: colors.muted },
  sep: { width: 1, height: 28, backgroundColor: colors.line, marginHorizontal: 2 },

  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.cream,
  },
  toolInfo: { gap: 2, flexShrink: 1 },
  toolText: { fontSize: font.caption, color: colors.muted },
  toolProject: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  projOpt: { minHeight: 44, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, paddingHorizontal: spacing.lg, justifyContent: 'center' },
  projOptOn: { backgroundColor: colors.mintDark, borderColor: colors.mintDark },
  projOptText: { fontSize: font.bodyLg, color: colors.ink },
  projClose: { minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm },
  projCloseText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  toolSub: { fontSize: font.caption, color: colors.muted },
  delete: { fontSize: font.body, color: colors.coral, fontWeight: '700' },

  // 삭제 확인 창
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.sm },
  dialogTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  dialogSub: { fontSize: font.body, color: colors.muted },
  dialogButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  dialogBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cancelBtn: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  cancelText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  deleteBtn: { backgroundColor: colors.coral },
  addBtn: { backgroundColor: colors.mintDark },
  summaryText: { fontSize: font.bodyLg, color: colors.ink, lineHeight: 24, marginVertical: spacing.sm },
  deleteText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.white },
});
