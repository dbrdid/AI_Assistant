import { SheetModal } from '../../../shared/components/Motion';
// ============================================================
// MemoEditScreen.js — 메모 쓰기 / 편집 화면
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
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
import MemoBlockEditor from '../components/MemoBlockEditor';
import MemoBlockReader from '../components/MemoBlockReader';
import MemoReferences from '../components/MemoReferences';
import { ROUTES } from '../../../navigation/routes';
import { analyzeText } from '../../../services/ai/AiAnalyze';
import { runtime, maybeRuntime, registerSessionFlush } from '../../../integration/runtime';
import SelectionOverlay from '../components/SelectionOverlay';
import { recognizeStrokes } from '../../../services/ai/Handwriting';
import { strokesInRect } from '../utils/InkUtils';
import { addMemo, findMemoSyncConflict, getMemo, listMemoVersions, memoTitle, setMemoParent, trashMemo, updateMemo, useMemos } from '../../../data/memos/MemoStore';
import { rankSearchRows, searchTerms } from '../../../data/memos/memoSearch.mjs';
import { useWorkspaceAccessClosed, useWorkspaces } from '../../../data/workspaces/WorkspaceStore';
import { alertUser } from '../../../data/alert';
import { shareHtmlFile, shareJsonFile, shareMarkdownFile } from '../../../services/device/ShareTextFile';
import { memoHtml, shareMemoPdf } from '../utils/shareMemoPdf';
import { memoJson, memoMarkdown } from '../utils/memoMarkdown.mjs';
import { projectOf, setItemProject, useProjects } from '../../../data/projects/ProjectStore';
import { summarizeText } from '../../../services/ai/AiSummary';
import { addUsage } from '../../../data/settings/SettingsStore';
import { ErrorModal } from '../../error/components/ErrorViews';
import { classifyError, isOfflineMode } from '../../../services/device/Network';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import Icon from '../../../shared/components/Icon';
import { CircleButton, PillButton } from '../../../shared/components/Ui';
import { dateLabel } from '../components/MemoCard';

// 펜 색 / 굵기 선택지
const PEN_COLORS = [colors.ink, colors.coral, colors.mintDark, '#4A6FA5'];
const PEN_WIDTHS = [2, 4, 8];

// 도구 줄의 버튼 하나 (아이콘 위 + 작은 글자 아래). 켜진 도구는 연한 민트 바탕 + 굵게
function ToolBtn({ icon, label, active, disabled, onPress }) {
  const tint = active ? colors.mintDark : colors.ink;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.tool, active && styles.toolOn, pressed && !active && { backgroundColor: colors.cream }, disabled && { opacity: 0.3 }]}
    >
      <Icon name={icon} size={22} color={tint} strokeWidth={active ? 2.1 : 1.8} />

    </Pressable>
  );
}

// AI 요약 글을 줄 단위로 나눔 (앞의 -, •, · , * 기호는 떼고 '·' 로 통일)
const summaryLines = (text) =>
  String(text || '')
    .split('\n')
    .map((ln) => ln.trim().replace(/^[-•·*]\s*/, ''))
    .filter(Boolean);

export default function MemoEditScreen({ navigation, route }) {
  const insets = useSafeAreaInsets();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const memoId = route.params?.memoId;
  // 편집할 기존 메모 (새 메모면 null). 화면이 열릴 때 한 번만 찾음
  const original = useMemo(() => (memoId ? getMemo(memoId) : null), [memoId]);
  const savedId = useRef(original?.id ?? null);
  const { current: workspace } = useWorkspaces();
  const accessClosed = useWorkspaceAccessClosed(workspace.id);
  const canEdit = workspace.personal || (!accessClosed && workspace.roleCode !== 'VIEWER');
  const supportsHierarchy = workspace.personal || process.env.EXPO_PUBLIC_SHARED_PAGE_HIERARCHY === 'true';
  const memos = useMemos();
  const [isParentPickerOpen, setParentPickerOpen] = useState(false);
  const [parentQuery, setParentQuery] = useState('');
  const [versions, setVersions] = useState(null);
  const [previewVersion, setPreviewVersion] = useState(null);
  const [showSaveConflict, setShowSaveConflict] = useState(false);
  const [syncConflict, setSyncConflict] = useState(null);
  const [isResolvingSyncConflict, setResolvingSyncConflict] = useState(false);
  const [syncConflictError, setSyncConflictError] = useState('');
  const resolvingSyncConflict = useRef(false);
  const exportingMarkdown = useRef(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [draftParentId, setDraftParentId] = useState(route.params?.parentMemoId ?? null);
  const persistedMemo = memos.find((memo) => memo.id === savedId.current);
  const activeMemo = supportsHierarchy && persistedMemo;
  const parentId = activeMemo ? activeMemo.parentMemoId : draftParentId;
  const parent = memos.find((memo) => memo.id === parentId);
  const children = activeMemo ? memos.filter((memo) => memo.parentMemoId === memoId) : [];
  const parentCandidates = useMemo(() => {
    if (!isParentPickerOpen) return [];
    const byId = new Map(memos.map((memo) => [memo.id, memo]));
    return memos.filter((candidate) => {
      for (let ancestor = candidate; ancestor; ancestor = byId.get(ancestor.parentMemoId)) {
        if (ancestor.id === persistedMemo?.id) return false;
      }
      return true;
    }).map(memo => ({ id: memo.id, title: memoTitle(memo) }));
  }, [isParentPickerOpen, memos, persistedMemo?.id]);
  const parentTerms = searchTerms(parentQuery);
  const matchingParents = parentTerms.length ? rankSearchRows(parentCandidates, parentTerms) : parentCandidates;

  // ---------- 입력 상태 ----------
  const [title, setTitle] = useState(original ? original.title : '');
  const [body, setBody] = useState(original ? original.body : '');
  const [showBlocks, setShowBlocks] = useState(route.params?.showBlocks === true);
  const [strokes, setStrokes] = useState(original?.strokes || []); // 손글씨 획들
  const [editMode, setMode] = useState('keyboard');
  const mode = canEdit ? editMode : 'move';
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1]);
  const [confirmDelete, setConfirmDelete] = useState(false); // 삭제 확인 창 표시 여부
  const [keyboardUp, setKeyboardUp] = useState(false);       // 키보드가 올라와 있나 (아래 여백 조절용)
  const [notice, setNotice] = useState('');                  // 잠깐 보여주는 안내 글자
  const [saveStatus, setSaveStatus] = useState('');
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
  const latest = useRef({ title, body, strokes, projectId, draftParentId });
  latest.current = { title, body, strokes, projectId, draftParentId };
  const savedDraft = useRef(latest.current);
  const savedRevision = useRef(original?.revision);
  const pendingAnalysis = useRef(false);
  const skipSave = useRef(false);                          // true 면 나갈 때 저장하지 않음 (삭제한 경우)
  const flushRef = useRef(null);
  const editorScope = useRef({ runtime: runtime(), workspaceId: workspace.id });

  // 이 화면이 사라질 때(어떤 방법으로 나가든) 한 번 실행됨
  useEffect(
    () => {
      const own = runtime(); const workspaceId = own.store.getCurrentWorkspace().id;
      const flush = ({ analyze = true, checkpoint = false } = {}) => {
        if (maybeRuntime() !== own) return;
        const currentWorkspace = own.store.getCurrentWorkspace();
        if (currentWorkspace.id !== workspaceId) return;
        if (skipSave.current) return;
        const t = latest.current.title.trim();
        const b = latest.current.body.trim();
        const s = latest.current.strokes;
        let id = savedId.current;
        const previous = savedDraft.current;
        const contentChanged = previous.title.trim() !== t || previous.body.trim() !== b || previous.strokes !== s;
        const projectChanged = previous.projectId !== latest.current.projectId;
        if (!currentWorkspace.personal && (currentWorkspace.roleCode === 'VIEWER' || own.closedSpaces.has(workspaceId))) {
          if (contentChanged || projectChanged) {
            throw Object.assign(new Error('이 공간의 편집 권한이 변경됐어요.'), { code: 'editor_permission_changed' });
          }
          return false;
        }
        const empty = !t && !b && s.length === 0; // 글자도 필기도 없음
        if (checkpoint && empty) return false;

        if (!id) {
          if (empty) return false;
          const memo = addMemo({ title: t, body: b, strokes: s, parentMemoId: latest.current.draftParentId });
          id = memo.id;
          savedId.current = id;
          savedRevision.current = memo.revision;
          pendingAnalysis.current = !!b;
          savedDraft.current = { ...latest.current, projectId: null };
        } else if (contentChanged || projectChanged) {
          const current = getMemo(id);
          if (!current || current.deletedAt !== null || (contentChanged && current.revision !== savedRevision.current)) {
            throw Object.assign(new Error('다른 곳에서 메모가 변경됐어요.'), { code: 'revision_conflict' });
          }
          if (contentChanged && empty) {
            trashMemo(id); // 휴지통에서 마지막으로 저장된 내용을 복구할 수 있음
            savedId.current = null;
            savedDraft.current = latest.current;
            pendingAnalysis.current = false;
            return true;
          }
          if (contentChanged) {
            const updated = updateMemo(id, { title: t, body: b, strokes: s }, { expectedRevision: savedRevision.current });
            savedRevision.current = updated.revision;
            if (current.body !== b) pendingAnalysis.current = !!b;
            savedDraft.current = { ...latest.current, projectId: previous.projectId };
          }
        }
        if (!checkpoint && savedDraft.current.projectId !== latest.current.projectId) {
          if (!setItemProject('memos', id, latest.current.projectId)) throw new Error('프로젝트 연결을 저장하지 못했어요.');
        }
        if (!checkpoint && pendingAnalysis.current) {
          if (analyze && getMemo(id)?.revision === savedRevision.current) {
            analyzeText({ sourceType: 'memo', sourceId: id, sourceTitle: t || b.slice(0, 20), text: b });
          }
          pendingAnalysis.current = false;
        }
        if (checkpoint) return contentChanged;
        savedDraft.current = latest.current;
        return true;
      };
      flushRef.current = flush;
      const unregister = registerSessionFlush(flush);
      return () => {
        unregister();
        try {
          flush();
        } catch (error) {
          alertUser('메모를 저장하지 못했어요', error.message);
        } finally {
          flushRef.current = null;
        }
      };
    },
    [],
  );

  const checkpointMemo = useCallback(() => {
    try {
      if (flushRef.current?.({ analyze: false, checkpoint: true })) setSaveStatus('기기에 저장됨');
    } catch (error) {
      if (error.code === 'editor_permission_changed') {
        setSaveStatus('편집 권한이 바뀌었어요. 초안 보존 중');
      } else {
        setSaveStatus(error.code === 'revision_conflict' ? '저장 충돌, 완료에서 해결' : '자동 저장 실패, 완료에서 다시 시도');
      }
    }
  }, []);
  useEffect(() => {
    if (!canEdit) return undefined;
    const previous = savedDraft.current;
    if (previous.title.trim() === title.trim() && previous.body.trim() === body.trim() && previous.strokes === strokes) {
      setSaveStatus('');
      return undefined;
    }
    if (!title.trim() && !body.trim() && strokes.length === 0) {
      setSaveStatus('');
      return undefined;
    }
    setSaveStatus('저장 대기 중');
    const timer = setTimeout(checkpointMemo, 1600);
    return () => clearTimeout(timer);
  }, [body, canEdit, checkpointMemo, strokes, title]);
  useEffect(() => {
    if (!canEdit) return undefined;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') checkpointMemo();
    });
    return () => subscription.remove();
  }, [canEdit, checkpointMemo]);

  // ---------- 되돌리기 / 다시 실행 ----------
  const hist = useRef({ list: [{ title, body, strokes }], i: 0 });
  const textTimer = useRef(null); // 글자 입력은 잠깐 멈췄을 때 한 번에 기록(글자마다 기록하면 되돌리기가 너무 잘게 쪼개짐)
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    if (!persistedMemo || persistedMemo.revision === savedRevision.current) return;
    const draft = latest.current;
    const saved = savedDraft.current;
    if (draft.title !== saved.title || draft.body !== saved.body || draft.strokes !== saved.strokes) {
      setSaveStatus('다른 곳에서 변경됨, 완료에서 해결');
      return;
    }
    const next = { ...draft, title: persistedMemo.title, body: persistedMemo.body, strokes: persistedMemo.strokes };
    savedRevision.current = persistedMemo.revision;
    savedDraft.current = { ...next, projectId: saved.projectId };
    latest.current = next;
    pendingAnalysis.current = false;
    clearTimeout(textTimer.current);
    textTimer.current = null;
    hist.current = { list: [{ title: next.title, body: next.body, strokes: next.strokes }], i: 0 };
    setCanUndo(false);
    setCanRedo(false);
    setTitle(next.title);
    setBody(next.body);
    setStrokes(next.strokes);
    setSaveStatus('');
  }, [persistedMemo]);

  const syncButtons = () => {
    setCanUndo(hist.current.i > 0);
    setCanRedo(hist.current.i < hist.current.list.length - 1);
  };

  // 현재 상태를 기록. 직전 기록과 같으면 무시
  const record = useCallback(() => {
    const h = hist.current;
    const { title, body, strokes } = latest.current;
    const snap = { title, body, strokes };
    const cur = h.list[h.i];
    if (cur.title === title && cur.body === body && cur.strokes === strokes) return;
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

  const scheduleTextRecord = () => {
    clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      textTimer.current = null;
      record(); // 이 시점엔 latest.current 가 이미 새 글자로 갱신돼 있음
    }, 700);
  };
  const onChangeBody = (text) => {
    latest.current = { ...latest.current, body: text };
    setBody(text);
    scheduleTextRecord();
  };

  // 필기를 하나 그렸거나 지웠을 때 (InkCanvas 가 호출)
  const onStrokesChange = (next) => {
    flushText();
    latest.current = { ...latest.current, strokes: next }; // 기록 함수가 새 값을 보도록 먼저 갱신
    setStrokes(next);
    record();
  };

  const restore = (snap) => {
    latest.current = { ...latest.current, title: snap.title, body: snap.body, strokes: snap.strokes };
    setTitle(snap.title);
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
      const text = await recognizeStrokes(targetStrokes, { sourceId: savedId.current });
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
      if (e?.code === 'CONSENT_REQUIRED' || e?.code === 'TRANSMISSION_DENIED') {
        showNotice('AI 설정에서 외부 AI 전송을 허용한 뒤 다시 시도해 주세요');
      } else if (e?.code === 'ROUTE_UNSUPPORTED') {
        showNotice('손글씨 변환은 클라우드 AI를 선택해야 사용할 수 있어요');
      } else if (e?.code === 'SOURCE_CHANGED') {
        showNotice('메모가 바뀌었습니다. 손글씨를 다시 변환해 주세요');
      } else if (e?.code === 'NOT_FOUND') {
        showNotice('손글씨 변환 서버가 아직 배포되지 않았어요. 서버 배포가 끝나면 다시 사용할 수 있어요');
      } else if (e?.code === 'NOT_CONFIGURED') {
        showNotice('손글씨 변환 서버 설정이 아직 완료되지 않았어요');
      } else if (e?.code === 'QUOTA_EXCEEDED') {
        showNotice('이번 달 사진과 손글씨 인식 한도를 모두 사용했어요');
      } else if (e?.code === 'NETWORK' || e?.code === 'PROVIDER_UNREACHABLE' || e?.code === 'PROVIDER_TIMEOUT') {
        showNotice('손글씨 변환 서버에 연결되지 않았어요. 인터넷과 서버 상태를 확인한 뒤 다시 시도해 주세요');
      } else if (e?.code === 'PROVIDER_ERROR' || e?.code === 'PROVIDER_BAD_RESPONSE') {
        showNotice('손글씨 변환 서버가 결과를 처리하지 못했어요. 필기는 그대로 남아 있어요');
      } else if (e?.code === 'INVALID_REQUEST' || e?.code === 'TOO_LARGE') {
        showNotice(e?.message || '손글씨를 줄이거나 영역을 나눠서 다시 시도해 주세요');
      } else if (e?.code === 'CANCELLED') {
        // 요청 취소는 사용자가 이미 다른 동작을 시작한 경우이므로 별도 안내하지 않습니다.
      } else {
        setErrView({ kind: classifyError(e), retry: () => convert(targetStrokes) }); // 필기는 그대로 남아 있음
      }
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

  // ---------- AI 요약 (실제 요청은 AiSummary.js 가 담당) ----------
  // summary: null(창 닫힘) | { status: 'loading' | 'done' | 'error', text }
  const [summary, setSummary] = useState(null);
  const summaryReq = useRef(0); // 요청 번호: 닫았다가 다시 눌렀을 때 옛날 답이 끼어들지 않게
  const summaryController = useRef(null);
  const summaryLoading = useRef(false); // 요약 중인지 (서버 답이 10초 넘게 걸림)
  useEffect(() => () => { summaryReq.current += 1; summaryController.current?.abort(); }, []);
  const requestSummary = async () => {
    // 요약 중에 [요약]을 또 누르면 진행 중인 요청이 취소되고 처음부터 다시 기다리게 되므로 무시
    if (summaryLoading.current) { showNotice('요약하는 중이에요. 잠시만 기다려 주세요'); return; }
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
    summaryLoading.current = true;
    setSummary({ status: 'loading', text: '' });
    summaryController.current?.abort();
    const controller = new AbortController(); summaryController.current = controller;
    try {
      flushRef.current?.({ analyze: false });
      const sourceTitle = latest.current.title;
      const out = await summarizeText(text, { memoId: savedId.current, signal: controller.signal });
      addUsage('summary'); // 설정 > AI 이용량 집계
      if (latest.current.body.trim() !== text || latest.current.title !== sourceTitle) throw new Error('원본이 바뀌었습니다');
      if (my === summaryReq.current) setSummary({ status: 'done', text: out.summary, sourceId: out.sourceId, sourceRevision: out.sourceRevision, originalText: text, originalTitle: sourceTitle });
    } catch (e) {
      if (my === summaryReq.current) {
        if (classifyError(e) === 'network') {
          setSummary(null);
          setErrView({ kind: 'network', retry: requestSummary });
        } else {
          setSummary({ status: 'error', text: '' });
        }
      }
    } finally {
      if (my === summaryReq.current) summaryLoading.current = false;
    }
  };
  const closeSummary = () => {
    summaryLoading.current = false; // 닫으면 요청을 취소하므로 다시 요약할 수 있음
    summaryController.current?.abort();
    summaryReq.current += 1;
    setSummary(null);
  };
  // 요약을 본문 끝에 추가 (되돌리기 한 단계)
  const addSummary = () => {
    const source = getMemo(summary.sourceId);
    if (!source || source.revision !== summary.sourceRevision || latest.current.body.trim() !== summary.originalText || latest.current.title !== summary.originalTitle) {
      closeSummary(); showNotice('원본이 바뀌었습니다. 다시 요약해 주세요'); return;
    }
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
  const saveBeforeLeaving = useCallback(() => {
    try {
      flushRef.current?.();
      return true;
    } catch (error) {
      if (error.code === 'revision_conflict' || error.code === 'editor_permission_changed') {
        setShowSaveConflict(true);
        return false;
      }
      alertUser('메모를 저장하지 못했어요', error.field === 'parentMemoId'
        ? '상위 페이지를 사용할 수 없어요. 페이지 이동에서 다른 상위 페이지나 최상위를 선택해 주세요.'
        : error.message);
      return false;
    }
  }, []);
  useEffect(() => navigation.registerHardwareBackGuard?.(saveBeforeLeaving), [navigation, saveBeforeLeaving]);
  const saveAndClose = () => { if (saveBeforeLeaving()) navigation.goBack(); };
  const saveConflictCopy = () => {
    if (skipSave.current) return;
    const scope = editorScope.current;
    if (maybeRuntime() !== scope.runtime || scope.runtime.store.getCurrentWorkspace().id !== scope.workspaceId) {
      alertUser('별도 메모를 저장하지 못했어요', '편집을 시작한 공간으로 돌아간 뒤 다시 시도해 주세요.');
      return;
    }
    const draft = latest.current;
    try {
      const copy = addMemo({ title: draft.title.trim() || '복구한 메모', body: draft.body.trim(), strokes: draft.strokes });
      skipSave.current = true;
      setShowSaveConflict(false);
      navigation.navigate(ROUTES.MemoEdit, { memoId: copy.id });
    } catch (error) {
      alertUser('별도 메모를 저장하지 못했어요', error.message);
    }
  };
  const canAccessCurrentPage = () => {
    const { runtime: own, workspaceId } = editorScope.current;
    return maybeRuntime() === own && own.store.getCurrentWorkspace().id === workspaceId && !own.closedSpaces.has(workspaceId);
  };
  const openRelatedPage = (relatedId, fromReference = false) => {
    if (!canAccessCurrentPage()) {
      alertUser('페이지를 열 수 없어요', '현재 공간에서 이 페이지를 열 수 없어요.');
      return false;
    }
    if (!memos.some(memo => memo.id === relatedId)) {
      alertUser('페이지를 열 수 없어요', '현재 공간에서 찾을 수 없는 페이지예요.');
      return false;
    }
    if (!saveBeforeLeaving()) return false;
    if (fromReference) navigation.navigate(ROUTES.MemoEdit, { memoId: relatedId, showBlocks }, { push: true });
    else navigation.navigate(ROUTES.MemoEdit, { memoId: relatedId });
    return true;
  };
  const openReferencedPage = (relatedId) => openRelatedPage(relatedId, true);
  const createChildPage = () => {
    if (!saveBeforeLeaving() || !savedId.current) return;
    navigation.navigate(ROUTES.MemoEdit, { parentMemoId: savedId.current }, { push: true });
  };
  const moveToParent = (nextParentId) => {
    try {
      if (activeMemo) setMemoParent(activeMemo.id, nextParentId);
      else setDraftParentId(nextParentId);
      setParentPickerOpen(false);
    } catch {
      alertUser('페이지를 이동하지 못했어요', '상위 페이지가 여전히 사용 가능한지 확인해 주세요.');
    }
  };
  const closeHistory = () => {
    setVersions(null);
    setPreviewVersion(null);
  };
  useEffect(() => {
    if (!accessClosed) return;
    setExportOpen(false);
    setVersions(null);
    setPreviewVersion(null);
  }, [accessClosed]);
  const openSyncConflict = async () => {
    if (resolvingSyncConflict.current) return;
    try {
      const conflict = await findMemoSyncConflict(savedId.current);
      if (conflict) {
        setSyncConflictError('');
        setSyncConflict(conflict);
      }
      else showNotice('이 문서에 해결할 동기화 문제가 없어요.');
    } catch (error) {
      alertUser('동기화 문제를 불러오지 못했어요', error.message);
    }
  };
  const closeSyncConflict = () => {
    if (!resolvingSyncConflict.current) setSyncConflict(null);
  };
  const conflictParentTitle = id => {
    if (!id) return '최상위';
    const page = memos.find(memo => memo.id === id);
    return page ? memoTitle(page) : '열 수 없는 페이지';
  };
  const resolveSyncConflict = async choice => {
    if (!syncConflict || resolvingSyncConflict.current) return;
    resolvingSyncConflict.current = true;
    setResolvingSyncConflict(true);
    setSyncConflictError('');
    try {
      const result = await syncConflict.resolve(choice);
      setSyncConflict(null);
      if (result?.hasOtherSyncIssues) showNotice('페이지 이동을 취소했어요. 동기화가 멈춘 다른 변경이 있어요.');
      else showNotice(syncConflict.isRejectedMove ? '페이지 이동을 취소했어요.' : '동기화에 사용할 변경을 선택했어요.');
    } catch (error) {
      setSyncConflictError(error.message || '충돌을 해결하지 못했어요. 다시 시도해 주세요.');
    } finally {
      resolvingSyncConflict.current = false;
      setResolvingSyncConflict(false);
    }
  };
  const loadVersionIntoEditor = () => {
    flushText();
    const { title, body, strokes } = previewVersion;
    latest.current = { ...latest.current, title, body, strokes };
    setTitle(title);
    setBody(body);
    setStrokes(strokes);
    record();
    closeHistory();
  };
  const exportMarkdown = async () => {
    if (!canAccessCurrentPage() || exportingMarkdown.current) return;
    exportingMarkdown.current = true;
    try {
      await shareMarkdownFile(memoMarkdown(latest.current));
    } catch (error) {
      alertUser('Markdown 파일을 내보내지 못했어요', error.message);
    } finally {
      exportingMarkdown.current = false;
    }
  };
  const exportCurrentPdf = async () => {
    setExportOpen(false);
    if (!canAccessCurrentPage()) return;
    try {
      await shareMemoPdf(latest.current);
    } catch (error) {
      alertUser('PDF를 내보내지 못했어요', error.message);
    }
  };
  // HTML(PDF와 같은 문서, 손글씨 포함)과 JSON(제목, 본문, 손글씨 원본)
  const exportAs = async (format) => {
    setExportOpen(false);
    if (!canAccessCurrentPage()) return;
    try {
      if (format === 'html') await shareHtmlFile(memoHtml(latest.current));
      else await shareJsonFile(memoJson(latest.current));
    } catch (error) {
      alertUser(`${format === 'html' ? 'HTML' : 'JSON'} 파일을 내보내지 못했어요`, error.message);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {/* 헤더 (여기에 밀기 제스처 연결. 입력창/필기 영역은 겹쳐서 제외) */}
      <View>
        <ScreenHeader
          title={workspace.name}
          onBack={saveAndClose}
          titleRightInset={canEdit ? 136 : undefined}
          right={<>
            {canEdit && <PillButton kind="text" label="완료" onPress={saveAndClose} />}
            <CircleButton icon="moreHorizontal" label="문서 도구 열기" onPress={() => setDetailsOpen(true)} />
          </>}
        />
      </View>

      {/* ---------- 입력 영역 ---------- */}
      <View style={styles.editor}>
        <TextInput
          style={styles.titleInput}
          value={title}
          onChangeText={(text) => {
            latest.current = { ...latest.current, title: text };
            setTitle(text);
            scheduleTextRecord();
          }}
          placeholder="제목"
          placeholderTextColor={colors.muted}
          editable={canEdit}
          autoFocus={canEdit && !original}
          maxLength={80}
          accessibilityLabel="메모 제목"
        />

        <SheetModal visible={detailsOpen} onClose={() => setDetailsOpen(false)} label="문서 도구"><View style={styles.detailHeading}><Text style={styles.detailTitle}>문서 도구</Text><CircleButton icon="x" label="문서 도구 닫기" onPress={() => setDetailsOpen(false)} /></View><ScrollView keyboardShouldPersistTaps="handled"><View style={styles.detailActions}>{!accessClosed && <PillButton kind="ghost" label="내보내기" onPress={() => { setDetailsOpen(false); setExportOpen(true); }} />}{!!persistedMemo && canEdit && <PillButton kind="ghost" label="휴지통으로 이동" onPress={() => { setDetailsOpen(false); setConfirmDelete(true); }} />}</View>
        {/* 프로젝트(폴더) 고르기 + 마지막 수정 시각 */}
        <View style={styles.metaRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`프로젝트 선택, 현재 ${projectName || '없음'}`}
            disabled={!canEdit}
            onPress={() => setPickingProject(true)}
            hitSlop={8}
            style={({ pressed }) => [styles.projPill, pressed && { opacity: 0.75 }]}
          >
            <Icon name="folder" size={14} color={colors.mintDark} strokeWidth={2} />
            <Text style={styles.projPillText} numberOfLines={1}>{projectName || '프로젝트 선택'}</Text>
            {canEdit && <Icon name="chevronDown" size={14} color={colors.mintDark} strokeWidth={2} />}
          </Pressable>
          {!canEdit && <Text accessibilityLiveRegion="polite" style={styles.edited}>{accessClosed ? '공유 공간 접근 종료' : '보기 전용'}</Text>}
          {!!saveStatus && <Text accessibilityLiveRegion="polite" style={styles.edited}>{saveStatus}</Text>}
          {original && <Text style={styles.edited} numberOfLines={1}>{dateLabel(original.updatedAt, new Date(), true)} 수정</Text>}
        </View>

        {original && !accessClosed && <MemoLinks memoId={original.id} navigation={navigation} />}
        {original && !accessClosed && <PhotoStrip memoId={original.id} canDetach={canEdit} />}
        {!accessClosed && <View style={styles.editorViewToggle}>
          <MemoReferences body={body} memos={memos} memoId={persistedMemo?.id} canEdit={canEdit} onChange={onChangeBody} onOpen={openReferencedPage} />
        </View>}
        {!!persistedMemo && !accessClosed && (
          <View style={styles.editorViewToggle}>
            <PillButton kind="ghost" label="편집 기록" onPress={() => setVersions(listMemoVersions(persistedMemo.id))} />
            {workspace.serverId && canEdit && <PillButton kind="ghost" label="동기화 문제" onPress={openSyncConflict} />}
          </View>
        )}
        {!accessClosed && !!(activeMemo || (supportsHierarchy && draftParentId)) && (
          <View style={styles.hierarchy}>
            <ScrollView horizontal keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hierarchyRow}>
              {!!parent && <PillButton kind="ghost" label={`상위: ${memoTitle(parent)}`} onPress={() => openRelatedPage(parent.id)} />}
              {!!parentId && !parent && <Text style={styles.edited}>상위 페이지를 열 수 없어요</Text>}
              {canEdit && <PillButton kind="ghost" label="페이지 이동" onPress={() => {
                setParentQuery('');
                setParentPickerOpen(true);
              }} />}
              {!!activeMemo && canEdit && <PillButton kind="ghost" label="하위 페이지 추가" onPress={createChildPage} />}
              {children.map((child) => <PillButton key={child.id} kind="ghost" label={`하위: ${memoTitle(child)}`} onPress={() => openRelatedPage(child.id)} />)}
            </ScrollView>
          </View>
        )}
        {mode === 'keyboard' && strokes.length === 0 && (
          <View style={styles.editorViewToggle}>
            <PillButton kind="ghost" label={showBlocks ? '텍스트 편집' : '블록 편집'} onPress={() => setShowBlocks(!showBlocks)} />
          </View>
        )}

        </ScrollView></SheetModal>
        {/* 메모 영역: 위아래로 스크롤되는 긴 페이지. 글자 입력창 위에 필기 캔버스를 겹쳐 둠.
            펜/지우개일 땐 한 손가락이 "그리기"라서 스크롤을 잠그고, ✋ 이동 모드에서 넘김 */}
        <ScrollView
          ref={scrollRef}
          style={[styles.scroll, styles.webScrollbar]}
          indicatorStyle="white"
          scrollEnabled={mode === 'keyboard' || mode === 'move'}
          keyboardShouldPersistTaps="handled"
          onLayout={(e) => setViewH(e.nativeEvent.layout.height)}
          onScroll={(e) => { scrollY.current = e.nativeEvent.contentOffset.y; }}
          scrollEventThrottle={16}
        >
          {!canEdit && strokes.length === 0 ? (
            <MemoBlockReader body={body} pages={memos} onOpenPage={accessClosed ? undefined : openReferencedPage} />
          ) : showBlocks && mode === 'keyboard' && strokes.length === 0 ? (
            <MemoBlockEditor body={body} onChange={onChangeBody} />
          ) : <View style={{ height: pageH }}>
            <TextInput
              ref={bodyRef}
              style={[styles.bodyInput, styles.webScrollbar]}
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
          </View>}
        </ScrollView>
      </View>

      <Modal transparent visible={exportOpen && !accessClosed} animationType="fade" onRequestClose={() => setExportOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>메모 내보내기</Text>
            <PillButton label="PDF, 텍스트와 손글씨" onPress={exportCurrentPdf} />
            {!!(title.trim() || body.trim()) && (
              <PillButton kind="ghost" label="Markdown, 텍스트" onPress={() => {
                setExportOpen(false);
                void exportMarkdown();
              }} />
            )}
            <PillButton kind="ghost" label="HTML, 웹 페이지" onPress={() => void exportAs('html')} />
            <PillButton kind="ghost" label="JSON, 원본 데이터" onPress={() => void exportAs('json')} />
            <PillButton kind="ghost" label="닫기" onPress={() => setExportOpen(false)} />
          </View>
        </View>
      </Modal>

      <Modal transparent visible={showSaveConflict} animationType="fade" onRequestClose={() => setShowSaveConflict(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>{accessClosed
              ? '공유 공간에 대한 접근이 종료됐어요'
              : canEdit ? '메모가 다른 곳에서 변경됐어요' : '편집 권한이 변경됐어요'}</Text>
            <Text style={styles.dialogSub}>{canEdit
              ? '입력한 제목, 본문, 손글씨를 같은 공간의 별도 메모로 저장할 수 있어요.'
              : '저장하지 않은 변경이 있어요. 화면에 머물면 초안을 확인할 수 있어요.'}</Text>
            {canEdit ? <PillButton label="별도 메모로 저장" onPress={saveConflictCopy} />
              : <PillButton label="저장하지 않고 닫기" onPress={() => { skipSave.current = true; navigation.goBack(); }} />}
            <PillButton kind="ghost" label={canEdit ? '편집 계속' : '초안 확인'} onPress={() => setShowSaveConflict(false)} />
          </View>
        </View>
      </Modal>

      <Modal transparent visible={syncConflict !== null && canEdit} animationType="fade" onRequestClose={closeSyncConflict}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>
              {syncConflict?.isRejectedMove ? '공유 페이지를 이동할 수 없어요' : '공유 문서 수정이 겹쳤어요'}
            </Text>
            <ScrollView style={styles.parentList}>
              <Text style={styles.projOptText}>내 변경</Text>
              {'title' in (syncConflict?.fields ?? {}) && <Text selectable>{syncConflict.fields.title || '제목 없음'}</Text>}
              {'body' in (syncConflict?.fields ?? {}) && <Text selectable>{syncConflict.fields.body || '본문 없음'}</Text>}
              {'strokes' in (syncConflict?.fields ?? {}) && <Text>손글씨 변경 포함</Text>}
              {'parent_note_id' in (syncConflict?.fields ?? {}) && <Text>상위 페이지, {conflictParentTitle(syncConflict.fields.parent_note_id)}</Text>}
              {syncConflict?.server && <>
                <Text style={styles.projOptText}>서버 문서</Text>
                <Text selectable>{syncConflict.server.title || '제목 없음'}</Text>
                <Text selectable>{syncConflict.server.body || '본문 없음'}</Text>
                {'parent_note_id' in syncConflict.fields && <Text>상위 페이지, {conflictParentTitle(syncConflict.server.parent_note_id)}</Text>}
              </>}
            </ScrollView>
            {isResolvingSyncConflict && <Text accessibilityLiveRegion="polite" style={styles.edited}>처리 중…</Text>}
            {!!syncConflictError && <Text accessibilityRole="alert" style={styles.edited}>{syncConflictError}</Text>}
            {syncConflict?.isRejectedMove ? (
              <PillButton label="이동 취소" disabled={isResolvingSyncConflict} onPress={() => resolveSyncConflict()} />
            ) : <>
              <PillButton label="내 변경 유지" disabled={isResolvingSyncConflict} onPress={() => resolveSyncConflict('keep_mine')} />
              {Object.keys(syncConflict?.fields ?? {}).length === 1 && typeof syncConflict.fields.body === 'string' &&
                typeof syncConflict.server.body === 'string' && syncConflict.fields.body !== syncConflict.server.body &&
                <PillButton kind="ghost" label="두 본문 합치기" disabled={isResolvingSyncConflict} onPress={() => resolveSyncConflict('keep_both')} />}
              <PillButton kind="ghost" label="서버 문서 사용" disabled={isResolvingSyncConflict} onPress={() => resolveSyncConflict('use_server')} />
            </>}
            <PillButton kind="ghost" label="나중에 해결" disabled={isResolvingSyncConflict} onPress={closeSyncConflict} />
          </View>
        </View>
      </Modal>

      <Modal transparent visible={versions !== null && !accessClosed} animationType="fade" onRequestClose={closeHistory}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>{previewVersion ? '이전 버전 미리보기' : '이 기기의 편집 기록'}</Text>
            {previewVersion ? (
              <>
                <ScrollView style={styles.parentList}>
                  <Text style={styles.projOptText} selectable>{memoTitle(previewVersion)}</Text>
                  {previewVersion.body ? <MemoBlockReader body={previewVersion.body} /> : <Text style={styles.edited}>본문 없음</Text>}
                  {previewVersion.strokes.length > 0 && <Text style={styles.edited}>손글씨 포함</Text>}
                </ScrollView>
                {canEdit && <PillButton label="편집기에 불러오기" onPress={loadVersionIntoEditor} />}
                <PillButton kind="ghost" label="기록 목록으로" onPress={() => setPreviewVersion(null)} />
              </>
            ) : (
              <ScrollView style={styles.parentList}>
                {versions?.length === 0 && <Text style={styles.edited}>아직 이전 버전이 없어요.</Text>}
                {versions?.map((version) => (
                  <Pressable key={version.revision} accessibilityRole="button" style={styles.projOpt} onPress={() => setPreviewVersion(version)}>
                    <Text style={styles.projOptText} numberOfLines={1}>{memoTitle(version)}</Text>
                    <Text style={styles.edited}>{dateLabel(version.updatedAt, new Date(), true)}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            <PillButton kind="ghost" label="닫기" onPress={closeHistory} />
          </View>
        </View>
      </Modal>

      <Modal transparent visible={canEdit && isParentPickerOpen} animationType="fade" onRequestClose={() => setParentPickerOpen(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.dialogTitle}>상위 페이지 선택</Text>
            <TextInput
              accessibilityLabel="상위 페이지 검색"
              placeholder="페이지 제목 검색"
              placeholderTextColor={colors.muted}
              value={parentQuery}
              onChangeText={setParentQuery}
              style={styles.parentSearch}
            />
            <ScrollView style={styles.parentList} keyboardShouldPersistTaps="handled">
              {[{ id: null, title: '최상위' }, ...matchingParents].map((candidate) => (
                <Pressable
                  key={candidate.id ?? 'root'}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: parentId === candidate.id }}
                  style={[styles.projOpt, parentId === candidate.id && styles.projOptOn]}
                  onPress={() => moveToParent(candidate.id)}
                >
                  <Text style={[styles.projOptText, parentId === candidate.id && { color: colors.onPrimary }]} numberOfLines={1}>{candidate.title}</Text>
                </Pressable>
              ))}
              {!!parentTerms.length && !matchingParents.length && <Text style={styles.edited}>일치하는 상위 페이지가 없어요.</Text>}
            </ScrollView>
            <PillButton kind="ghost" label="닫기" onPress={() => setParentPickerOpen(false)} />
          </View>
        </View>
      </Modal>

      {/* ---------- AI 요약 카드 (스토리보드 64장: 요약을 보여주고 확인 후 메모에 추가) ---------- */}
      {summary !== null && (
        <View style={styles.summaryCard} accessibilityLiveRegion="polite">
          <View style={styles.summaryHead}>
            <Icon name="sparkles" size={16} color={colors.mintDark} strokeWidth={2} />
            <Text style={styles.summaryTitle} accessibilityRole="header">AI 요약</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={summary.status === 'done' ? '요약 취소' : '요약 닫기'} onPress={closeSummary} hitSlop={10}>
              <Icon name="x" size={18} color={colors.muted} />
            </Pressable>
          </View>
          {summary.status === 'loading' && (
            <View style={styles.summaryLoading}>
              <ActivityIndicator size="small" color={colors.mintDark} />
              <Text style={styles.summarySub}>메모를 요약하는 중… 10~20초쯤 걸려요</Text>
            </View>
          )}
          {summary.status === 'error' && <Text style={styles.summarySub}>요약에 실패했어요. 잠시 뒤 다시 시도해 주세요.</Text>}
          {summary.status === 'done' && (
            <>
              <ScrollView style={styles.summaryScroll} nestedScrollEnabled>
                {summaryLines(summary.text).map((ln, i) => (
                  <Text key={i} style={styles.summaryText} selectable>{`· ${ln}`}</Text>
                ))}
              </ScrollView>
              {canEdit && <Pressable accessibilityRole="button" onPress={addSummary} style={({ pressed }) => [styles.summaryAdd, pressed && { opacity: 0.8 }]}>
                <Text style={styles.summaryAddText}>메모에 추가</Text>
              </Pressable>}
            </>
          )}
        </View>
      )}

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
                style={[styles.colorRing, penColor === c && { borderColor: c }]}
              >
                <View style={[styles.colorDot, { backgroundColor: c }]} />
              </Pressable>
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
                <View style={{ width: 22, height: w, borderRadius: w / 2, backgroundColor: penWidth === w ? colors.mintDark : colors.ink }} />
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
            <Icon name="x" size={18} color={colors.mintDark} />
          </Pressable>
        </View>
      )}

      {/* ---------- 도구 줄: 입력 방식 | 이전·다음 | 요약·변환 ---------- */}
      {canEdit ? <View style={[styles.tools, { paddingBottom: keyboardUp ? spacing.xs : insets.bottom + spacing.xs }]}>
        {!!notice && <Text style={styles.notice}>{notice}</Text>}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.toolRow}>
          <ToolBtn icon="keyboard" label="키보드" active={mode === 'keyboard'} onPress={() => chooseMode('keyboard')} />
          <ToolBtn icon="pencil" label="펜" active={mode === 'pen'} onPress={() => chooseMode('pen')} />
          <ToolBtn icon="eraser" label="지우개" active={mode === 'eraser'} onPress={() => chooseMode('eraser')} />
          <ToolBtn icon="hand" label="이동" active={mode === 'move'} onPress={() => chooseMode('move')} />
          <View style={styles.toolDivider} />
          <ToolBtn icon="undo" label="이전" disabled={!canUndo} onPress={undo} />
          <ToolBtn icon="redo" label="다음" disabled={!canRedo} onPress={redo} />
          <View style={styles.toolDivider} />
          <ToolBtn icon="sparkles" label="요약" active={summary !== null} onPress={requestSummary} />
          <ToolBtn icon="type" label="변환" active={mode === 'convert'} onPress={() => {
            if (mode === 'convert') chooseMode('keyboard');
            else if (strokes.length === 0) showNotice('변환할 손글씨가 없어요. 펜으로 먼저 써 보세요');
            else chooseMode('convert');
          }} />
        </ScrollView>
      </View> : <View style={{ height: insets.bottom }} />}

      {/* ---------- 프로젝트 고르기 창 ---------- */}
      <Modal transparent visible={canEdit && pickingProject} animationType="fade" onRequestClose={() => setPickingProject(false)}>
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
                    <Text style={[styles.projOptText, on && { color: colors.onPrimary, fontWeight: '600' }]} numberOfLines={1}>
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

      {/* ---------- 오류 안내 창 (네트워크/서버) ---------- */}
      <ErrorModal
        kind={errView ? errView.kind : 'network'}
        visible={errView !== null}
        onClose={() => setErrView(null)}
        onRetry={() => errView && errView.retry && errView.retry()}
        onHome={() => navigation.navigate(ROUTES.Home)}
      />

      {/* ---------- 삭제 확인 창 ---------- */}
      <Modal transparent visible={canEdit && confirmDelete} animationType="fade" onRequestClose={() => setConfirmDelete(false)}>
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
  detailHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  detailTitle: { color: colors.ink, fontSize: 16, fontWeight: "600" },
  detailActions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingVertical: 12 },
  root: { flex: 1, backgroundColor: colors.cream },

  editor: { flex: 1, width: '100%', maxWidth: 760, alignSelf: 'center', paddingHorizontal: spacing.lg },
  editorViewToggle: { alignItems: 'flex-start', paddingBottom: spacing.xs },
  hierarchy: { flexGrow: 0, marginBottom: spacing.xs },
  hierarchyRow: { gap: spacing.sm, padding: spacing.xs },
  parentList: { maxHeight: 280 },
  parentSearch: { minHeight: 44, paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.line, color: colors.ink },
  titleInput: {
    fontSize: 28,
    fontWeight: '600',
    color: colors.ink,
    paddingTop: 24,
    paddingBottom: spacing.sm,
  },
  // 제목 아래: 프로젝트 알약 + 수정 시각
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingBottom: spacing.sm },
  projPill: { flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 220, minHeight: 44, paddingHorizontal: 10, borderRadius: radius.pill, backgroundColor: colors.mintSoft },
  projPillText: { flexShrink: 1, fontSize: font.caption, fontWeight: '600', color: colors.mintDark },
  edited: { flexShrink: 1, fontSize: font.caption, color: colors.muted },
  // 글자 입력창 + 필기 캔버스가 겹치는 스크롤 영역
  scroll: { flex: 1 },
  webScrollbar: Platform.OS === 'web' ? { colorScheme: 'dark', scrollbarColor: '#777a7c transparent', scrollbarWidth: 'thin' } : {},
  toolDivider: { alignSelf: 'center', width: 1, height: 18, backgroundColor: colors.line },
  bodyInput: {
    flex: 1, // 페이지(부모 View) 전체를 차지
    fontSize: font.bodyLg,
    lineHeight: 26,
    color: colors.ink,
    paddingTop: spacing.sm,
  },

  // AI 요약 카드 (연한 민트 바탕)
  summaryCard: { marginHorizontal: spacing.lg, marginBottom: spacing.md, padding: spacing.lg, borderRadius: radius.card, backgroundColor: colors.mintSoft, gap: spacing.sm },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  summaryTitle: { flex: 1, fontSize: font.body + 1, fontWeight: '600', color: colors.mintDark },
  summaryScroll: { maxHeight: 160 },
  summaryText: { fontSize: font.body, color: colors.ink, lineHeight: 22 },
  summarySub: { fontSize: font.body, color: colors.muted },
  summaryLoading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  summaryAdd: { alignSelf: 'flex-start', minHeight: 44, paddingHorizontal: spacing.lg, borderRadius: radius.sm, backgroundColor: colors.action, justifyContent: 'center', marginTop: 2 },
  summaryAddText: { fontSize: font.caption + 1, fontWeight: '600', color: colors.onPrimary },

  // 펜 옵션 줄: 색 동그라미(선택된 색은 바깥 고리) + 굵기
  penOptions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.cream,
  },
  optGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  colorRing: { width: 36, height: 36, borderRadius: 18, borderWidth: 2, borderColor: 'transparent', alignItems: 'center', justifyContent: 'center' },
  colorDot: { width: 24, height: 24, borderRadius: 12 },
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
  convertHint: { flex: 1, fontSize: font.caption, color: colors.mintDark, fontWeight: '500' },
  convertAll: { paddingHorizontal: spacing.md, minHeight: 34, borderRadius: radius.sm, backgroundColor: colors.action, justifyContent: 'center' },
  convertAllText: { fontSize: font.body, fontWeight: '500', color: colors.onPrimary },

  // 도구 줄 (흰 바탕 + 위쪽 얇은 선)
  tools: { borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.card },
  notice: { textAlign: 'center', fontSize: font.caption, color: colors.mintDark, fontWeight: '500', paddingTop: spacing.sm },
  toolRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xs, paddingTop: spacing.sm, gap: 2 },
  tool: { width: 44, minHeight: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', gap: 3 },
  toolOn: { backgroundColor: colors.mintSoft },
  toolLabel: { fontSize: 11, color: colors.muted, fontWeight: '600' },
  toolLabelOn: { color: colors.mintDark, fontWeight: '600' },

  // 프로젝트 고르기 창
  projOpt: { minHeight: 44, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, paddingHorizontal: spacing.lg, justifyContent: 'center' },
  projOptOn: { backgroundColor: colors.action, borderColor: colors.actionBorder },
  projOptText: { fontSize: font.bodyLg, color: colors.ink },
  projClose: { minHeight: 44, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm },
  projCloseText: { fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
  toolSub: { fontSize: font.caption, color: colors.muted },

  // 삭제 확인 창
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 340, backgroundColor: colors.cream, borderRadius: radius.card, padding: spacing.xl, gap: spacing.sm },
  dialogTitle: { fontSize: font.title, fontWeight: '600', color: colors.ink },
  dialogSub: { fontSize: font.body, color: colors.muted },
  dialogButtons: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  dialogBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  cancelBtn: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  cancelText: { fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
  deleteBtn: { backgroundColor: colors.coralSoft },
  deleteText: { fontSize: font.bodyLg, fontWeight: '500', color: colors.onPrimary },
});
