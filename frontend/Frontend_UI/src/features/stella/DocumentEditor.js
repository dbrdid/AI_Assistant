import { SheetModal } from "../../shared/components/Motion";
import React, { useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, KeyboardAvoidingView, Modal, useWindowDimensions, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { addMemo, getMemo, updateMemo, setFavorites, useMemos } from '../../data/memos/MemoStore';
import { useTasks } from '../../data/tasks/TaskStore';
import { setItemProject } from '../../data/projects/ProjectStore';
import ConfirmDialog from '../../shared/components/ConfirmDialog';
import { readPreference } from '../../data/hooks';
import { runtime, maybeRuntime, registerSessionFlush } from '../../integration/runtime';
import { ROUTES } from '../../navigation/routes';
import { analyzeText } from '../../services/ai/AiAnalyze';
import Icon from '../../shared/components/Icon';
import { useInsets } from '../../shared/hooks/useInsets';
import { WorkspaceHeader, IconButton } from './WorkspaceScreen';
import { palette as c, styles as s } from './theme';
import BlockEditor from './BlockEditor';
import EditorTools from './EditorTools';
import { blocksText, normalizeBlocks } from '../../../../../backend/local/src/stella-documents.js';
import { LOCAL_PREVIEW } from '../../integration/mode';
export default function DocumentEditor({
  navigation,
  route
}) {
  const memoId = route.params?.memoId;
  const [original] = useState(() => memoId ? getMemo(memoId) : null);
  const [title, setTitle] = useState(original?.title ?? '');
  const [titleHeight, setTitleHeight] = useState(58);
  const [body, setBody] = useState(original?.body ?? '');
  const [blocks, setBlocks] = useState(() => original ? runtime().documents.blocksFor(original) : [{
    id: 'body',
    type: 'paragraph',
    text: '',
    checked: false
  }]);
  const [editorMode, setEditorMode] = useState('blocks');
  const blockEditorRef = useRef(null);
  const [tools, setTools] = useState(false);
  const [panel,setPanel] = useState(null);
  const actionsButton = useRef(null);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const viewport = useWindowDimensions();
  function openActions() {
    actionsButton.current?.measureInWindow((x, y, width, height) => {
      setMenuAnchor({right: x + width, bottom: y + height});
      setPanel('actions');
    });
  }
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    function keyboardMenu(event) {
      if (event.key === 'Escape' && panel) {
        event.preventDefault();
        setPanel(null);
      }
      if ((event.ctrlKey || event.metaKey) && event.code === 'Backslash' && !event.repeat) {
        event.preventDefault();
        setPanel(previous => previous === 'tree' ? null : 'tree');
      }
    }
    globalThis.addEventListener('keydown', keyboardMenu);
    return () => globalThis.removeEventListener('keydown', keyboardMenu);
  }, [panel]);

  const [localConfirm, setLocalConfirm] = useState(null);
  const [childToDelete, setChildToDelete] = useState(null);
  const [deletedChild, setDeletedChild] = useState(null);
  const localRequest = useRef(null);
  const history = useRef({
    undo: [],
    redo: []
  });
  const [favorite, setFavorite] = useState(original?.favorite ?? false);
  const [status, setStatus] = useState(original ? '기기에 저장됨' : '작성 후 자동 저장');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [linkPicker, setLinkPicker] = useState(false);
  const memos = useMemos();
  const tasks = useTasks();
  const insets = useInsets();
  const own = useRef(runtime()).current;
  const workspaceId = useRef(own.store.getCurrentWorkspace().id).current;
  const readOnly = own.store.getCurrentWorkspace().roleCode === 'VIEWER';
  const latest = useRef({
    title,
    body,
    blocks
  });
  latest.current = {
    title,
    body,
    blocks
  };
  const saved = useRef(original);
  const active = useRef(true);
  const lastAutoRevision = useRef(original?.revision ?? 0);
  const saveRef = useRef(null);
  const missing = Boolean(memoId && !original);
  function save() {
    if (missing || readOnly) return saved.current;
    if (maybeRuntime() !== own || own.store.getCurrentWorkspace().id !== workspaceId) throw new Error('계정 또는 공간이 바뀌었습니다. 원래 공간에서 다시 열어 주세요.');
    const fields = {
      title: latest.current.title,
      body: latest.current.body
    };
    if (!saved.current && !fields.title.trim() && !fields.body.trim()) return null;
    if (saved.current) {
      const current = getMemo(saved.current.id);
      if (!current || current.deletedAt !== null) throw new Error('문서가 삭제되었습니다. 입력 내용을 복사한 뒤 목록을 확인해 주세요.');
      const currentBlocks = own.documents.blocksFor(current);
      if (current.title === fields.title && current.body === fields.body && JSON.stringify(currentBlocks) === JSON.stringify(latest.current.blocks)) return current;
      saved.current = own.documents.saveContent(current.id, {
        ...fields,
        blocks: latest.current.blocks
      }, saved.current.revision);
    } else {
      saved.current = addMemo(fields);
      saved.current = own.documents.saveContent(saved.current.id, {
        ...fields,
        blocks: latest.current.blocks
      }, saved.current.revision);
      if (route.params?.parentId) { own.documents.moveDocument(saved.current.id, route.params.parentId); saved.current = getMemo(saved.current.id); }
      if (route.params?.projectId) setItemProject('memos', saved.current.id, route.params.projectId);
    }
    return saved.current;
  }
  saveRef.current = save;
  function attemptSave() {
    try {
      const memo = saveRef.current();
      if (active.current) {
        setStatus(memo ? '기기에 저장됨' : '작성 후 자동 저장');
        setError('');
      }
      return memo;
    } catch (e) {
      if (active.current) {
        setError(e.code === 'revision_conflict' ? '다른 곳에서 문서가 수정됐습니다. 입력을 복사한 뒤 다시 열어 주세요.' : e.message);
        setStatus('저장하지 못함');
      }
      return false;
    }
  }
  useEffect(() => {
    const unregister = registerSessionFlush(() => saveRef.current());
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (attemptSave() !== false) navigation.goBack();
      return true;
    });
    const background = AppState.addEventListener('change', state => {
      if (state !== 'active') attemptSave();
    });
    const saveVersionKey = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        try {
          const memo = saveRef.current();
          if (memo) {
            const number = own.documents.createVersion(memo.id, memo.revision);
            setStatus(`버전 ${number} 저장됨`);
          }
        } catch (e) {
          setError(e.message);
        }
      }
    };
    if (Platform.OS === 'web') globalThis.addEventListener?.('keydown', saveVersionKey);
    const beforeUnload = event => {
      try {
        saveRef.current();
      } catch {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    if (Platform.OS === 'web') globalThis.addEventListener?.('beforeunload', beforeUnload);
    return () => {
      if (maybeRuntime() === own && own.store.getCurrentWorkspace().id === workspaceId) {
        try {
          maybeAutoAnalyze(saveRef.current());
        } catch (e) {
          console.error('[stella-editor] 화면 종료 시 저장 실패', e.code ?? e.message);
        }
      }
      active.current = false;
      localRequest.current?.abort();
      unregister();
      background.remove();
      back.remove();
      if (Platform.OS === 'web') globalThis.removeEventListener?.('keydown', saveVersionKey);
      if (Platform.OS === 'web') globalThis.removeEventListener?.('beforeunload', beforeUnload);
    };
  }, []);
  useEffect(() => {
    if (missing || readOnly) return undefined;
    setStatus('저장 대기 중');
    const timer = setTimeout(attemptSave, 600);
    return () => clearTimeout(timer);
  }, [title, body, blocks]);
  function applyBlocks(next, record = true) {
    const normalized = normalizeBlocks(next);
    if (JSON.stringify(normalized) === JSON.stringify(latest.current.blocks)) return;
    if (record) {
      history.current.undo.push(latest.current.blocks);
      history.current.undo = history.current.undo.slice(-80);
      history.current.redo = [];
    }
    const text = blocksText(normalized);
    latest.current = {
      ...latest.current,
      body: text,
      blocks: normalized
    };
    setBlocks(normalized);
    setBody(text);
  }
  function replaceContent(memo, nextBlocks) {
    history.current = {
      undo: [],
      redo: []
    };
    saved.current = memo;
    latest.current = {
      title: memo.title,
      body: memo.body,
      blocks: nextBlocks
    };
    setTitle(memo.title);
    setBody(memo.body);
    setBlocks(nextBlocks);
    setError('');
    setStatus('기기에 저장됨');
  }
  function stepHistory(direction) {
    const stack = history.current[direction];
    if (!stack.length) return;
    const target = stack.pop();
    history.current[direction === 'undo' ? 'redo' : 'undo'].push(latest.current.blocks);
    applyBlocks(target, false);
  }
  function maybeAutoAnalyze(memo) {
    if (!LOCAL_PREVIEW && memo?.body.trim() && memo.revision !== lastAutoRevision.current) {
      lastAutoRevision.current = memo.revision;
      void analyzeText({
        sourceType: 'memo',
        sourceId: memo.id
      });
    }
  }
  function leave(target) {
    const memo = attemptSave();
    if (memo === false) return;
    maybeAutoAnalyze(memo);
    if (target === 'advanced') navigation.navigate(ROUTES.AdvancedMemoEdit, memo ? {
      memoId: memo.id
    } : {});else navigation.goBack();
  }
  async function analyze() {
    if (busy) return;
    if (LOCAL_PREVIEW) {
      if (Platform.OS !== 'web') {
        setError('PC의 웹 미리보기에서만 로컬 모델을 연결할 수 있습니다.');
        return;
      }
      const memo = attemptSave();
      if (!memo) return;
      if (readPreference(`ai-excluded:${memo.id}`, false)) {
        setError('AI 전송에서 제외한 문서입니다.');
        return;
      }
      setBusy(true);
      setError('');
      try {
        const response = await fetch('/__stella-model/models');
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        const model = result.models.find(name => name === 'gemma4:e4b') ?? result.models[0];
        if (!model) throw new Error('실행할 로컬 모델이 없습니다.');
        if (active.current) setLocalConfirm(model);
      } catch (e) {
        if (active.current) setError(e.message);
      } finally {
        if (active.current) setBusy(false);
      }
      return;
    }
    const memo = attemptSave();
    if (!memo) {
      if (memo !== false) setError('분석할 내용을 먼저 작성해 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await analyzeText({
        sourceType: 'memo',
        sourceId: memo.id,
        explicit: true
      });
      if (!active.current || maybeRuntime() !== own) return;
      if (result.error) setError(result.error);else {
        setStatus(`AI 제안 ${result.added ?? 0}건 생성됨  /  작업 검토에서 확인`);
      }
    } catch (e) {
      if (active.current) setError(e.message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function summarizeLocally() {
    const model = localConfirm;
    setLocalConfirm(null);
    const memo = attemptSave();
    if (!memo || !model) return;
    if (memo.body.length > 8000) {
      setError('현재 로컬 요약은 본문 8,000자까지 지원합니다. 문서를 나눠서 요청해 주세요.');
      return;
    }
    const snapshot = {
      ...memo,
      workspace: own.store.getCurrentWorkspace().id
    };
    if (readPreference(`ai-excluded:${memo.id}`, false)) {
      setError('AI 전송에서 제외한 문서입니다.');
      return;
    }
    localRequest.current = new AbortController();
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/__stella-model/ask', {
        method: 'POST',
        signal: localRequest.current.signal,
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          consent: true,
          prompt: `다음 문서의 사실만 사용해 핵심 내용을 한국어로 요약하세요. 문서에 없는 사실을 추가하지 마세요. 요약문만 출력하세요.\n\n${snapshot.body}`
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (!active.current || maybeRuntime() !== own) return;
      const current = getMemo(snapshot.id);
      if (own.store.getCurrentWorkspace().id !== snapshot.workspace || !current || current.deletedAt !== null || current.revision !== snapshot.revision || readPreference(`ai-excluded:${snapshot.id}`, false)) throw new Error('원본 또는 전송 설정이 바뀌어 결과를 반영하지 않았습니다.');
      own.store.addProposals([{
        kind: 'memo',
        title: `${snapshot.title || '문서'} 요약`.slice(0, 200),
        body: result.text,
        sourceType: 'memo',
        sourceId: snapshot.id,
        sourceTitle: snapshot.title,
        sourceRevision: snapshot.revision
      }]);
      navigation.navigate(ROUTES.Proposals);
    } catch (e) {
      if (active.current && e.name !== 'AbortError') setError(e.message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  function toggleFavorite() {
    const memo = attemptSave();
    if (!memo) return;
    try {
      setFavorites([memo.id], !favorite);
      setFavorite(!favorite);
    } catch (e) {
      setError(e.message);
    }
  }
  const currentMemo = memos.find(memo => memo.id === saved.current?.id) ?? saved.current;
  const documents = own.documents.listDocuments();
  const children = documents.filter(document => document.parentId === currentMemo?.id);
  const ancestors = [];
  const visitedParents = new Set(currentMemo ? [currentMemo.id] : []);
  let parentId = currentMemo?.parentMemoId ?? route.params?.parentId;
  while (parentId && !visitedParents.has(parentId)) {
    visitedParents.add(parentId);
    const parent = documents.find(document => document.id === parentId);
    if (!parent) break;
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }
  function openDocument(id) {
    if (attemptSave() !== false) navigation.navigate(ROUTES.MemoEdit, { memoId: id }, { push: true });
  }
  function createChild() {
    const memo = attemptSave();
    if (!memo) { if (memo !== false) setError('하위 문서를 만들기 전에 제목이나 내용을 입력해 주세요.'); return; }
    navigation.navigate(ROUTES.MemoEdit, { parentId: memo.id }, { push: true });
  }
  function deleteChild() {
    const child = childToDelete;
    setChildToDelete(null);
    if (readOnly || !child || attemptSave() === false) return;
    try {
      const current = own.documents.listDocuments().find(document => document.id === child.id);
      if (!current || current.parentId !== saved.current?.id) throw new Error('문서 위치가 바뀌었습니다. 목록을 다시 확인해 주세요.');
      own.documents.trash(child.id);
      setDeletedChild(child);setPanel("tree");
      setError('');
    } catch (e) { setError(e.message); }
  }
  function undoChildDelete() {
    if (readOnly || !deletedChild) return;
    try { own.store.restoreMemos([deletedChild.id]); setDeletedChild(null); setError(''); }
    catch (e) { setError(e.message); }
  }
  const documentLinks = currentMemo ? own.documents.links().filter(link => link.source === currentMemo.id || link.target === currentMemo.id) : [];
  const linked = tasks.filter(task => (currentMemo?.taskIds ?? []).includes(task.id));
  function toggleLink(taskId) {
    const memo = attemptSave();
    if (!memo) return;
    try {
      const ids = getMemo(memo.id).taskIds;
      updateMemo(memo.id, {
        taskIds: ids.includes(taskId) ? ids.filter(id => id !== taskId) : [...ids, taskId]
      });
      saved.current = getMemo(memo.id);
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }
  return <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><WorkspaceHeader title={own.store.getCurrentWorkspace().name} onBack={() => leave()} left={<IconButton name="menu" label="왼쪽 문서 탐색 열기" onPress={()=>setPanel("tree")}/>} right={<><IconButton name="link" label="할 일 / 일정 연결 관리" onPress={() => { if (attemptSave()) setLinkPicker(true); else setError("연결하기 전에 문서 내용을 작성해 주세요."); }} disabled={readOnly || missing} /><View ref={actionsButton} collapsable={false}><IconButton name="moreHorizontal" label="문서 작업 메뉴 열기" onPress={openActions} disabled={missing} /></View></>} />{error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}{missing ? <Text style={s.empty}>문서가 없거나 현재 공간에서 접근할 수 없습니다.</Text> : <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={s.page}>{ancestors.length > 0 && <View accessibilityLabel="상위 문서 경로" style={{flexDirection:'row',flexWrap:'wrap',alignItems:'center',marginBottom:12}}>{ancestors.map(parent => <Pressable key={parent.id} accessibilityRole="button" accessibilityLabel={`상위 문서 열기: ${parent.title || '제목 없는 문서'}`} onPress={() => openDocument(parent.id)} style={{flexDirection:'row',alignItems:'center',minHeight:44,maxWidth:'100%',gap:6,paddingRight:8}}><Text numberOfLines={1} style={[s.meta,{flexShrink:1}]}>{parent.title || '제목 없는 문서'}</Text><Icon name="chevronRight" size={14} color={c.subtle}/></Pressable>)}</View>}<TextInput accessibilityLabel="문서 제목" value={title} onChangeText={setTitle} onBlur={attemptSave} editable={!readOnly} placeholder="제목 없는 문서" placeholderTextColor={c.subtle} multiline scrollEnabled={false} onContentSizeChange={event => setTitleHeight(Math.max(58, event.nativeEvent.contentSize.height))} maxLength={200} style={[s.editorTitle, { height: titleHeight }]} /><Text accessibilityLiveRegion="polite" style={s.meta}>{readOnly ? '보기 전용 공간' : status}</Text>{editorMode === "blocks" ? <BlockEditor ref={blockEditorRef} blocks={blocks} onChange={applyBlocks} disabled={readOnly} /> : <TextInput accessibilityLabel="문서 본문" value={body} onChangeText={text => applyBlocks([{
        id: "body",
        type: "paragraph",
        text,
        checked: false
      }])} onBlur={attemptSave} editable={!readOnly} placeholder="생각을 자유롭게 적어 보세요." placeholderTextColor={c.subtle} multiline scrollEnabled={false} style={s.editorBody} />}{original?.strokes?.length || original?.photos?.length ? <Pressable accessibilityRole="button" onPress={() => leave('advanced')} style={s.secondary}><Text style={s.secondaryText}>원본 필기 / 첨부 보기  /  전체 편집</Text></Pressable> : null}</ScrollView>}<Modal visible={panel!==null} transparent animationType="fade" onRequestClose={()=>setPanel(null)}>
    <View style={{flex:1,flexDirection:'row',justifyContent:panel==='tree'?'flex-start':'flex-end'}}>
      <Pressable accessibilityRole="button" accessibilityLabel="메뉴 닫기" onPress={()=>setPanel(null)} style={{position:'absolute',inset:0,top:0,right:0,bottom:0,left:0,backgroundColor:'#0006'}}/>
      <View style={panel === 'actions' && menuAnchor ? {
        position:'absolute', top:Math.min(menuAnchor.bottom + 4, viewport.height / 2),
        right:Math.max(8, viewport.width - menuAnchor.right), width:Math.min(292, viewport.width - 24),
        maxHeight:Math.max(100,viewport.height - menuAnchor.bottom - 24), backgroundColor:c.background,
        padding:12,borderWidth:1,borderColor:c.line,borderRadius:8
      } : {width:'85%',maxWidth:340,backgroundColor:c.background,padding:16,paddingTop:Math.max(12,insets.top)}}>
        <View style={s.titleRow}><Text style={s.sectionTitle}>{panel==='tree'?'문서 탐색':'문서 작업'}</Text><IconButton name="x" label="닫기" onPress={()=>setPanel(null)}/></View>
        <ScrollView keyboardShouldPersistTaps="handled">{panel==='tree'?<><View style={s.section}><View style={s.titleRow}><Text style={s.sectionTitle}>하위 문서</Text><Pressable accessibilityRole="button" accessibilityLabel="하위 문서 만들기" disabled={readOnly} onPress={createChild} style={{flexDirection:'row',alignItems:'center',gap:6,minHeight:44,opacity:readOnly ? 0.4 : 1}}><Icon name="plus" size={17} color={c.muted}/><Text style={s.linkText}>새 문서</Text></Pressable></View>{children.map(child => <View key={child.id} style={s.row}><Pressable accessibilityRole="button" accessibilityLabel={`하위 문서 열기: ${child.title || '제목 없는 문서'}`} onPress={() => openDocument(child.id)} style={{flex:1,minWidth:0,minHeight:44,flexDirection:'row',alignItems:'center',gap:10}}><Icon name="file" size={18} color={c.muted}/><Text numberOfLines={1} style={[s.rowTitle,{flex:1}]}>{child.title || '제목 없는 문서'}</Text></Pressable><IconButton name="trash" label={`하위 문서 삭제: ${child.title || '제목 없는 문서'}`} disabled={readOnly} onPress={() => {setPanel(null);setChildToDelete(child);}}/></View>)}{deletedChild && <View style={s.row}><Text accessibilityLiveRegion="polite" style={[s.meta,{flex:1}]}>휴지통으로 이동했습니다.</Text><Pressable accessibilityRole="button" accessibilityLabel="하위 문서 삭제 취소" disabled={readOnly} onPress={undoChildDelete} style={{minHeight:44,justifyContent:'center'}}><Text style={s.linkText}>삭제 취소</Text></Pressable></View>}</View><Pressable style={s.menuRow} accessibilityRole="button" onPress={()=>{if(attemptSave()!==false)navigation.navigate(ROUTES.Memos);}}><Text style={s.menuLabel}>전체 문서 열기</Text></Pressable></>:<><View style={[s.editorTools, {
      paddingBottom: Math.max(8, insets.bottom)
    }]}><IconButton name="type" label="선택한 블록 형식" onPress={() => {setPanel(null);blockEditorRef.current?.format();}} disabled={missing || readOnly || editorMode !== "blocks"} /><IconButton name="undo" label="되돌리기" onPress={() => stepHistory("undo")} disabled={readOnly || !history.current.undo.length} /><IconButton name="redo" label="다시 실행" onPress={() => stepHistory("redo")} disabled={readOnly || !history.current.redo.length} /><IconButton name="pencil" label="필기 / 첨부 전체 편집" onPress={() => leave('advanced')} disabled={missing || readOnly} /><IconButton name="sparkles" label={busy ? "분석 중" : "문서 요약 제안"} onPress={() => {setPanel(null);analyze();}} disabled={busy || readOnly || missing} /></View>{(linked.length > 0 || documentLinks.length > 0) && <View style={s.section}><View style={s.titleRow}><Text style={s.sectionTitle}>연결된 기록</Text><IconButton name="link" label="할 일 / 일정 연결 관리" disabled={readOnly} onPress={() => { setPanel(null);
            if (attemptSave()) setLinkPicker(true);else setError("연결하기 전에 문서 내용을 작성해 주세요.");
          }} /></View>{linked.map(task => <Pressable key={task.id} accessibilityRole="button" style={s.row} onPress={() => {
          if (attemptSave() !== false) navigation.navigate(ROUTES.TaskEdit, {
            taskId: task.id
          });
        }}><Icon name="link" size={16} color={c.muted} /><Text style={[s.rowTitle, {
            flex: 1
          }]}>{task.title}</Text></Pressable>)}{documentLinks.map((link, index) => {
          const id = link.source === currentMemo.id ? link.target : link.source;
          const target = memos.find(item => item.id === id);
          return target ? <Pressable key={`${id}:${index}`} accessibilityRole="button" style={s.row} onPress={() => {
            if (attemptSave() !== false) navigation.navigate(ROUTES.MemoEdit, {
              memoId: id
            });
          }}><Icon name="file" size={16} color={c.muted} /><Text style={s.rowTitle}>{target.title || "제목 없는 문서"}</Text></Pressable> : null;
        })}</View>}<Pressable accessibilityRole="button" style={s.menuRow} onPress={()=>{setPanel(null);setTools(true);}}><Text style={s.menuLabel}>문서 도구</Text></Pressable></>}</ScrollView>
      </View>
    </View></Modal><ConfirmDialog visible={Boolean(childToDelete)} title="하위 문서를 휴지통으로 옮길까요?" sub={`${childToDelete?.title || '제목 없는 문서'}은 휴지통에서 복원할 수 있습니다. 그 아래의 문서는 현재 문서 아래로 옮겨 보존합니다.`} confirmText="휴지통으로 이동" danger onCancel={() => {setChildToDelete(null);setPanel("tree");}} onConfirm={deleteChild}/><ConfirmDialog visible={Boolean(localConfirm)} title="이 PC의 모델로 요약할까요?" sub={`${localConfirm || "로컬 모델"}에 현재 문서 본문을 전송합니다. 결과는 승인 대기 제안으로 저장하며 원문은 변경하지 않습니다.`} confirmText="요약 제안 만들기" onCancel={() => setLocalConfirm(null)} onConfirm={summarizeLocally} /><EditorTools favorite={favorite} onFavorite={toggleFavorite} editorMode={editorMode} onToggleEditor={() => { setEditorMode(value => value === "blocks" ? "text" : "blocks"); setTools(false); }} visible={tools} memoId={saved.current?.id} draft={latest.current} onClose={() => setTools(false)} flush={attemptSave} readOnly={readOnly} onReplace={replaceContent} navigation={navigation} onAdvanced={() => leave("advanced")} /><SheetModal visible={linkPicker} onClose={() => setLinkPicker(false)} label="할 일 / 일정 연결"><View style={s.titleRow}><Text style={s.sectionTitle}>할 일 / 일정 연결</Text><IconButton name="x" label="연결 관리 닫기" onPress={() => setLinkPicker(false)} /></View><ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false}>{tasks.map(task => <Pressable key={task.id} accessibilityRole="checkbox" accessibilityState={{
          checked: linked.some(item => item.id === task.id)
        }} onPress={() => toggleLink(task.id)} style={s.menuRow}><Icon name={linked.some(item => item.id === task.id) ? "checkSquare" : "square"} size={20} color={c.text} /><Text style={s.menuLabel}>{task.title}</Text></Pressable>)}{!tasks.length && <Text style={s.empty}>연결할 할 일 / 일정이 없습니다.\n작업 공간 메뉴에서 먼저 만들어 주세요.</Text>}</ScrollView></SheetModal></KeyboardAvoidingView>;
}
