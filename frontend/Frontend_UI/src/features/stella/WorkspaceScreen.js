import { SheetModal } from "../../shared/components/Motion";
import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Animated, Easing, Platform, FlatList, Image, Linking, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useAppUpdate } from '../../services/update/AppUpdate';
import TabBar from '../../navigation/TabBar';
import { ScreenEntryProvider } from '../../navigation/ScreenEntry';
import { useFiles } from '../../data/files/FileStore';
import GraphCanvas from './GraphCanvas';
import SearchDock from './SearchDock';
import SwipeNav from './SwipeNav';
import { itemAccessOf } from '../../data/projects/ProjectStore';
import { useNoteRecorder } from '../record/components/useNoteRecorder';
import ProposalCard from '../proposal/components/ProposalCard';
import { runtime, useValue, readPreference, writePreference } from '../../data/hooks';
import { randomUUID } from 'expo-crypto';
import { isPlaced, placeProposal } from './aiPending.mjs';
import Icon from '../../shared/components/Icon';
import { useInsets } from '../../shared/hooks/useInsets';
import { useMemos, memoTitle, setFavorites } from '../../data/memos/MemoStore';
import { useProposals } from '../../data/proposals/ProposalStore';
import { useSpaceInfo, useWorkspaces, switchWorkspace } from '../../data/workspaces/WorkspaceStore';
import ConfirmDialog from '../../shared/components/ConfirmDialog';
import { useProposalActions } from '../proposal/useProposalActions';
import { ROUTES, TABS } from '../../navigation/routes';
import { filterDocuments } from './model.mjs';
import { readMemoBlocks } from '../memo/utils/memoBlocks.mjs';
import { readMemoReference } from '../memo/utils/memoReferences.mjs';
import { palette as c, styles as s } from './theme';
import { LOCAL_PREVIEW } from '../../integration/mode';
import { useSettings } from '../../data/settings/SettingsStore';

// 프로필 글자: 사용자의 성. 한글 이름은 첫 글자(유병욱 → 유), 영문 이름은 마지막 단어의 첫 글자(John Smith → S),
// 이름 대신 이메일만 있으면 그 첫 글자. 이름이 없으면 S
export function profileInitial(name) {
  const text = String(name ?? '').trim();
  if (!text) return 'S';
  if (/^[가-힣]/.test(text)) return text[0];
  const local = text.includes('@') ? text.split('@')[0] : text;
  const words = local.split(/\s+/).filter(Boolean);
  const pick = text.includes('@') ? words[0] : words[words.length - 1];
  return (Array.from(pick ?? 'S')[0] ?? 'S').toUpperCase();
}
export function IconButton({
  name,
  label,
  onPress,
  disabled = false
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{
    disabled
  }} disabled={disabled} onPress={onPress} style={({
    pressed
  }) => [s.iconButton, (pressed || disabled) && {
    opacity: .5
  }]}><Icon name={name} size={21} color={c.text} /></Pressable>;
}
export function PrimaryButton({
  label,
  onPress,
  icon = 'plus',
  disabled = false
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{
    disabled
  }} disabled={disabled} onPress={onPress} style={({
    pressed
  }) => [s.primary, (pressed || disabled) && {
    opacity: .5
  }]}><Icon name={icon} size={17} color={c.text} /><Text style={s.primaryText}>{label}</Text></Pressable>;
}
export function WorkspaceHeader({
  title,
  onBack,
  left,
  onMenu,
  onSearch,

  right,
  tabs,
  team = null // 팀 공간이면 { name, color }: 개인 공간과 한눈에 구분되게
}) {
  const insets = useInsets();
  const initial = profileInitial(useSettings().profile?.name);
  if (tabs) return <View style={[s.navigationHeader, { paddingTop: insets.top + 10 }, team && { borderBottomWidth: 2, borderBottomColor: team.color }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`작업 공간 메뉴 열기: ${title}${team ? ', 팀 공간' : ', 개인 공간'}`} hitSlop={{ left: 6, right: 6 }} onPress={onMenu} style={s.workspaceAvatar}>
      <Text style={[s.workspaceInitial, team && { borderWidth: 2, borderColor: team.color, lineHeight: 26 }]}>{initial}</Text>
      {team && <Text numberOfLines={1} style={{ position: 'absolute', bottom: -6, fontSize: 9, fontWeight: '700', color: c.background, backgroundColor: team.color, borderRadius: 6, paddingHorizontal: 4, overflow: 'hidden' }}>팀</Text>}
    </Pressable>
    {tabs}
  </View>;
  const headerStyle = [s.header, { paddingTop: insets.top + 8 }];
  if (onBack) return <View style={headerStyle}>
    <View style={[s.actions, { flex: 1 }]}>{left}<IconButton name="chevronLeft" label="뒤로 가기" onPress={onBack} /></View>
    <Text numberOfLines={1} style={[s.brandTitle, { flexShrink: 1, maxWidth: '32%', textAlign: 'center' }]}>{title}</Text>
    <View style={[s.actions, { flex: 1, justifyContent: 'flex-end' }]}>{right || (onSearch && <IconButton name="search" label="문서 검색" onPress={onSearch} />)}</View>
  </View>;
  return <View style={headerStyle}>{left}<Pressable accessibilityRole="button" accessibilityLabel="작업 공간 메뉴 열기" onPress={onMenu} style={s.brand}><Text style={s.brandMark}>{initial}</Text><View style={{
        flexShrink: 1
      }}><Text style={s.brandTitle} numberOfLines={1}>{title}</Text><Text style={s.brandSub}>Atria{LOCAL_PREVIEW ? ', 로컬 미리보기' : ''}</Text></View><Icon name="chevronDown" size={14} color={c.muted} /></Pressable><View style={s.actions}>{right || <>{onSearch && <IconButton name="search" label="문서 검색" onPress={onSearch} />}</>}</View></View>;
}
function documentIcon(memo) {
  // Recording memos keep the "녹음" prefix even after the title is generated.
  if (/^녹음(?:\s|$)/.test(memoTitle(memo))) return 'mic';
  return memo.photos?.length ? 'paperclip' : 'pencil';
}

function DocumentRow({ memo, onPress, hasChildren, collapsed, onToggle, onMore, compact = false }) {
  const title = memoTitle(memo);
  const [showEmpty, setShowEmpty] = useState(false);
  const expanded = hasChildren ? !collapsed : showEmpty;
  return <View style={{ paddingLeft: Math.min(memo.depth ?? 0, 5) * 12 }}>
    <View style={[s.row, { alignItems: 'center', paddingVertical: 0, gap: 6 }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress}
      style={({ pressed }) => [{ flex: 1, minHeight: 44, flexDirection: 'row',
        alignItems: 'center', gap: 8, paddingVertical: compact ? 0 : 6, opacity: pressed ? .6 : 1 }]}>
      <Icon name={documentIcon(memo)} size={18} color={c.muted} />
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
        {!compact && <><Text style={s.rowBody} numberOfLines={1}>{memo.body || '필기나 첨부가 있는 문서'}</Text>
          <Text style={s.meta}>{memo.favorite ? '즐겨찾기, ' : ''}{new Date(memo.updatedAt).toLocaleDateString('ko-KR')}, 기기 저장</Text></>}
      </View>
    </Pressable>
    {onMore && <Pressable accessibilityRole="button" accessibilityLabel={`${title} 더 보기`} onPress={() => onMore(memo)} style={s.iconButton}>
        <Icon name="moreHorizontal" size={18} color={c.muted} />
      </Pressable>}
    {onToggle &&
      <Pressable accessibilityRole="button" accessibilityLabel={`${expanded ? '접기' : '펼치기'}: ${title}`}
          accessibilityState={{ expanded }} onPress={hasChildren ? onToggle : () => setShowEmpty(open => !open)} style={s.iconButton}>
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={18} color={c.muted} />
        </Pressable>}
    </View>
    {onToggle && !hasChildren && expanded && <Text style={{ marginLeft: 38, marginBottom: 6, fontSize: 12, color: c.muted }}>하위 문서 없음</Text>}
  </View>;
}
function SectionHead({
  title,
  label,
  onPress
}) {
  return <View style={s.sectionHead}><Text accessibilityRole="header" style={s.sectionTitle}>{title}</Text>{onPress && <Pressable accessibilityRole="button" onPress={onPress} style={s.link}><Text style={s.linkText}>{label}</Text><Icon name="chevronRight" size={14} color={c.muted} /></Pressable>}</View>;
}
function HomeSection({ title, children, action }) {
  const [expanded, setExpanded] = useState(true);
  return <View style={s.homeSection}>
    <View style={s.homeSectionHeading}><Pressable accessibilityRole="button" accessibilityLabel={`${title} ${expanded ? '접기' : '펼치기'}`} accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(value => !value)} style={s.homeSectionToggle}>
      <Text style={s.homeSectionLabel}>{title}</Text><Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color={c.subtle} />
    </Pressable>{action}</View>
    {expanded && children}
  </View>;
}
function RecentDocument({ memo, photo, onPress }) {
  const [imageFailed, setImageFailed] = useState(false);
  const excerpt = readMemoBlocks(memo.body || '').map(({ text }) => readMemoReference(text)?.label ?? text.trim())
    .filter(Boolean).slice(0, 3).join(' / ');
  return <Pressable accessibilityRole="button" accessibilityLabel={memoTitle(memo)} onPress={onPress} style={({ pressed }) => [s.recentCard, pressed && { opacity: .65 }]}>
    {photo?.uri && !imageFailed && <View style={s.recentCover}><Image source={{ uri: photo.uri }} resizeMode="cover" style={s.recentImage} onError={() => setImageFailed(true)} /></View>}
    <View style={s.recentCardContent}>
      <View style={s.recentCardHeading}><Icon name={documentIcon(memo)} size={16} color={c.subtle} /><Text style={s.recentTitle} numberOfLines={2}>{memoTitle(memo)}</Text></View>
      {!!excerpt && <Text style={s.recentExcerpt} numberOfLines={3}>{excerpt}</Text>}
    </View>
  </Pressable>;
}
// Notion처럼 공간 단위 항목(검토·AI 연결·공유·휴지통·설정)은 좌상단 작업 공간 메뉴에 모은다.
const SPACE_TOOLS = [[ROUTES.Spaces, '공유 공간 관리', 'users', '공간'], [ROUTES.Proposals, '작업 검토', 'checkSquare', 'AI'], [ROUTES.LocalModel, 'AI 연결', 'sparkles', 'AI'],
  [ROUTES.Trash, '휴지통', 'trash', '관리'], [ROUTES.Backup, '백업 및 복원', 'cloud', '관리'], [ROUTES.Settings, '설정', 'settings', '관리'], [ROUTES.More, '모든 도구', 'grid', '관리']];
const EMBEDDED_ENTRY = { tabRoot: true, goBack: null, embedded: true };
const DOCUMENT_MODES = { [ROUTES.Memos]: 'documents', [ROUTES.Relations]: 'relations', [ROUTES.Proposals]: 'review' };

// Web overflow:hidden can scroll focused descendants in addition to the pager transform.
const pagerOverflow = Platform.OS === 'web' ? 'clip' : 'hidden';

// 자체 입력줄이 있는 쪽 (오늘: 메모, 첨부, 녹음 입력줄 / 빠른 입력: 저장 줄)은 공통 하단을 겹쳐 그리지 않는다
const OWN_BOTTOM_BAR = new Set();

function PageRail({ index, pages, header, renderPage, keepVisited = false }) {
  const position = useRef(new Animated.Value(index)).current;
  const lastPosition = useRef(index);
  const [highlight, setHighlight] = useState(index);
  const [width, setWidth] = useState(0);
  const [visited, setVisited] = useState(() => new Set([0, index]));
  useLayoutEffect(() => {
    const start = lastPosition.current;
    const distance = Math.abs(index - start);
    if (!distance) return;
    const low = Math.floor(Math.min(start, index));
    const high = Math.ceil(Math.max(start, index));
    setVisited(previous => new Set([...previous, ...pages.map((_, i) => i).filter(i => i >= low && i <= high)]));
    const listener = position.addListener(({ value }) => {
      lastPosition.current = value;
      setHighlight(Math.round(value));
    });
    const motion = Animated.timing(position, {
      toValue: index, duration: Math.min(430, 260 + 85 * Math.max(0, distance - 1)),
      easing: Easing.inOut(Easing.quad), useNativeDriver: false
    });
    motion.start(({ finished }) => { if (finished && !keepVisited) setVisited(new Set([index])); });
    return () => { motion.stop(); position.removeListener(listener); };
  }, [index, position, pages, keepVisited]);
  return <>
    {header(pages[highlight])}
    <View style={{ flex: 1, overflow: pagerOverflow }} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View style={{ flex: 1, flexDirection: 'row', width: width ? width * pages.length : '100%',
        transform: [{ translateX: Animated.multiply(position, -width) }] }}>
        {pages.map((page, i) => <View key={page.route} aria-hidden={i !== index} importantForAccessibility={i === index ? 'auto' : 'no-hide-descendants'}
          pointerEvents={i === index ? 'auto' : 'none'} style={{ width: width || '100%', overflow: pagerOverflow }}>
          {(i === 0 || visited.has(i) || i === index) && renderPage(page, i)}
        </View>)}
      </Animated.View>
    </View>
  </>;
}

export default function WorkspaceScreen({
  navigation,
  route,
  mode = 'home',
  pagerIndex,
  screens,
  calendar,
  bodyOnly = false,
  favoritesOnly = false
}) {
  const insets = useInsets();
  const note = useNoteRecorder((name, params) => go(name, params), insets.bottom);
  const memoRows = useMemos();
  const files = useFiles();
  const documents = useValue(() => runtime().documents.listDocuments());
  const proposals = useProposals();
  const spaces = useWorkspaces();
  const spaceInfo = useSpaceInfo();
  const [switchTo, setSwitchTo] = useState(null); // 바꿀 공간 (확인 대기)
  const memos = memoRows;
  const actions = useProposalActions(navigation);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selectedProposal, setSelectedProposal] = useState(null);
  const appUpdate = useAppUpdate();
  const [menu, setMenu] = useState(false);
  const [tabPreview, setTabPreview] = useState(null); // 길게 눌러 좌우로 고르는 중인 탭
  const [rowMenu, setRowMenu] = useState(null);       // 문서 줄의 … 메뉴를 연 문서
  const [rowDelete, setRowDelete] = useState(null);   // 휴지통으로 옮길지 묻는 문서
  const canEdit = spaces.current?.roleCode !== 'VIEWER';
  // 공개 그룹에서 보기 권한만 있는 문서는 메뉴에서 삭제·즐겨찾기를 뺀다 (서버가 거절하고 보내기 줄이 막힘)
  const onMore = canEdit ? memo => { itemAccessOf('memo', memo.id).then(access => setRowMenu({ ...memo, viewOnly: access === 'view' })).catch(() => setRowMenu({ ...memo, viewOnly: true })); } : undefined;
  // 문서 줄 삭제: 편집기의 하위 문서 삭제와 같은 휴지통 이동 (그 아래 문서는 한 단계 위로 올려 보존). 되돌리기로 복원
  function trashRow() {
    const memo = rowDelete;
    setRowDelete(null);
    if (!memo) return;
    try {
      runtime().documents.trash(memo.id);
      actions.snack.show(`“${memoTitle(memo)}”을 휴지통으로 옮겼어요`, { label: '되돌리기', onPress: () => { try { runtime().store.restoreMemos([memo.id]); } catch (e) { actions.snack.show(e.message); } } });
    } catch (e) { actions.snack.show(e.message); }
  }
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set());
  const [filter, setFilter] = useState(favoritesOnly ? 'favorites' : 'all');
  const [reviewTab, setReviewTab] = useState('pending');
  const [error, setError] = useState('');
  const current = spaces.current;
  useEffect(() => { setCollapsed(new Set()); setSelectedProposal(null); }, [current?.id]);
  const parentIds = new Set(documents.map(document => document.parentId).filter(Boolean));
  const shown = p => !actions.hidden.has(p.id) && !isPlaced(p, readPreference);
  const waiting = proposals.filter(p => p.status === 'pending' && shown(p));
  const go = (name, params) => {
    setMenu(false);
    navigation.navigate(name, params);
  };
  const tool = ([name, label, icon]) => ({ key: name, label, icon, chevron: true, count: name === ROUTES.Proposals ? waiting.length : 0, onPress: () => go(name) });
  function place(p) {
    try { go(ROUTES.MemoEdit, { memoId: placeProposal(runtime(), p, { read: readPreference, write: writePreference }, randomUUID) }); }
    catch (e) { actions.snack.show(e.code === 'source_changed' ? '원본 문서가 바뀌었습니다. 다시 분석해 주세요.' : e.message); }
  }
  function renderProposal(proposal, confirmFirst = false) {
    return <ProposalCard key={proposal.id} p={proposal} actions={actions}
      expanded={selectedProposal === proposal.id}
      onToggle={() => setSelectedProposal(id => id === proposal.id ? null : proposal.id)}
      onSource={() => go(ROUTES.MemoEdit, { memoId: proposal.sourceId })}
      onPlace={confirmFirst ? () => place(proposal) : undefined}
      confirmFirst={confirmFirst} readOnly={!canEdit} />;
  }
  const open = memo => go(ROUTES.MemoEdit, {
    memoId: memo.id
  });
  const list = filterDocuments(documents, {
    query,
    favoritesOnly: filter === 'favorites'
  }).filter(document => {
    if (query || filter === 'favorites') return true;
    const visited = new Set();
    let parent = document.parentId;
    while (parent && !visited.has(parent)) {
      if (collapsed.has(parent)) return false;
      visited.add(parent);
      parent = documents.find(item => item.id === parent)?.parentId;
    }
    return true;
  });
  const title = mode === 'documents' ? '문서' : mode === 'relations' ? '문서 관계' : mode === 'review' ? '작업 검토' : '작업 공간';
  const requestSearch = route?.params?.search === true;
  const selectedTab = { home: ROUTES.Home, documents: ROUTES.Memos, relations: ROUTES.Relations, review: ROUTES.Proposals }[mode];
  const standalone = pagerIndex === undefined && (mode === 'review' || mode === 'relations');
  const header = (highlight = selectedTab) => standalone ? <WorkspaceHeader title={title} onBack={() => navigation.goBack()} /> : <><WorkspaceHeader title={current?.name || '나의 작업 공간'} onMenu={() => setMenu(true)} team={!current || current.personal ? null : { name: current.name, color: spaceInfo[current.id]?.color ?? c.accent }} tabs={!favoritesOnly && <TabBar current={highlight} preview={tabPreview} onSelect={navigation.selectTab || navigation.navigate} />} onSearch={mode === "documents" ? undefined : () => go(ROUTES.Memos, {
      search: true
    })} />{error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}</>;
  // 탭 안에 들어간 쪽은 아래 공통 하단(검색, AI에게 질문하기, 새 문서)을 쓰고 자체 하단을 그리지 않는다
  const embedded = pagerIndex !== undefined || bodyOnly;
  const intro = standalone || embedded ? null : <><View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>{title}</Text></View></>;
  // Notion 모바일 하단과 같은 형식: 왼쪽 검색, 가운데 AI에게 질문하기, 오른쪽 새 문서
  // Notion 모바일과 같은 하단: 검색(펼쳐지는 검색창), AI에게 질문하기, 새로 만들기
  const titleOf = new Map(memos.map(memo => [memo.id, memoTitle(memo)]));
  const parentOf = new Map(documents.map(document => [document.id, document.parentId]));
  const searchDocs = memos.map(memo => ({ id: memo.id, title: memoTitle(memo), body: memo.body || '', updatedAt: memo.updatedAt, createdAt: memo.createdAt ?? memo.updatedAt, parent: titleOf.get(parentOf.get(memo.id)) || '' }));
  // 녹음 중에는 하단 메뉴 대신 녹음 막대를 표시한다.
  function handleDockAction(kind) {
    switch (kind) {
      case 'note': return note.start();
      case 'calendar':
        if (route?.name === ROUTES.Tasks) return navigation.setParams({ subpage: ROUTES.Calendar });
        return navigation.selectTab ? navigation.selectTab(ROUTES.Tasks) : go(ROUTES.Tasks, { subpage: ROUTES.Calendar });
      case 'document': return go(ROUTES.MemoEdit);
      case 'project': return go(ROUTES.ProjectEdit);
    }
  }
  const askDock = note.recording ? note.bar : <SearchDock docs={searchDocs} bottomInset={insets.bottom} onOpen={id => go(ROUTES.MemoEdit, { memoId: id })} onAskAI={prompt => go(ROUTES.AiChat, prompt ? { initialPrompt: prompt } : undefined)}
    onAction={handleDockAction} />;
  let content;
  if (mode === 'documents') {
    content = <FlatList showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} data={list} keyExtractor={memo => memo.id} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled" ListHeaderComponent={<>{intro}<View style={s.search}><Icon name="search" size={17} color={c.muted} /><TextInput autoFocus={requestSearch} accessibilityLabel="문서 검색" placeholder="제목이나 내용으로 검색" placeholderTextColor={c.subtle} value={query} onChangeText={setQuery} style={s.searchInput} />{query ? <IconButton name="x" label="검색어 지우기" onPress={() => setQuery('')} /> : null}</View><View style={s.filters}>{[['all', '모든 문서'], ['favorites', '즐겨찾기']].map(([key, label]) => <Pressable key={key} accessibilityRole="tab" accessibilityState={{
          selected: filter === key
        }} onPress={() => setFilter(key)} style={[s.filter, filter === key && s.filterOn]}><Text style={[s.filterText, filter === key && s.filterTextOn]}>{label}</Text></Pressable>)}</View></>} renderItem={({
      item
    }) => <DocumentRow memo={item} compact={!query} onMore={onMore} onPress={() => open(item)} hasChildren={parentIds.has(item.id)} collapsed={collapsed.has(item.id)} onToggle={() => setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(item.id)) next.delete(item.id);else next.add(item.id);
      return next;
    })} />} ListEmptyComponent={<Text style={s.empty}>{query ? '검색 결과가 없습니다.' : filter === 'favorites' ? '즐겨찾기한 문서가 없습니다.' : '아직 문서가 없습니다.\n새 문서에서 첫 생각을 기록하세요.'}</Text>} />;
    // 홈 하단 도크와 같은 자리(엄지가 닿는 오른쪽 아래)에 새 문서 버튼
    if (!embedded) content = <>{content}<View style={[s.homeDock, { justifyContent: 'flex-end', paddingBottom: Math.max(10, insets.bottom) }]}><IconButton name="pencil" label="새 문서 작성" onPress={() => go(ROUTES.MemoEdit)} /></View></>;
  } else if (mode === 'review') {
    const items = proposals.filter(p => p.status === reviewTab && shown(p));
    content = <FlatList showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} data={items} keyExtractor={p => p.id} contentContainerStyle={s.page} ListHeaderComponent={<>{intro}<View style={s.filters}>{[['pending', '확인 대기'], ['hold', '보류']].map(([key, label]) => <Pressable key={key} accessibilityRole="tab" accessibilityState={{
          selected: reviewTab === key
        }} onPress={() => { setReviewTab(key); setSelectedProposal(null); }} style={[s.filter, reviewTab === key && s.filterOn]}><Text style={[s.filterText, reviewTab === key && s.filterTextOn]}>{label}</Text></Pressable>)}</View></>} renderItem={({
      item: p
    }) => renderProposal(p, true)} ListEmptyComponent={<Text style={s.empty}>{reviewTab === 'hold' ? '보류한 작업이 없습니다.' : '검토할 제안이 없습니다.'}</Text>} />;
  } else if (mode === 'relations') {
    content = <GraphCanvas key={current?.id} navigation={navigation} />;
  } else {
    content = <>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.homePage}>
        {memos.length > 0 && <HomeSection title="최근 문서"><ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.recentRail} contentContainerStyle={s.recentRailContent}>
          {memos.slice(0, 6).map(memo => <RecentDocument key={memo.id} memo={memo} photo={files.find(file => file.id === memo.photos?.[0])} onPress={() => open(memo)} />)}
        </ScrollView></HomeSection>}
        {memos.some(memo => memo.favorite) && <HomeSection title="즐겨찾기">
          {memos.filter(memo => memo.favorite).slice(0, 5).map(memo => <DocumentRow key={memo.id} memo={memo} compact onMore={onMore} onPress={() => open(memo)} />)}
          {memos.filter(memo => memo.favorite).length > 5 && <Pressable accessibilityRole="button" style={s.link} onPress={() => go(ROUTES.Favorites)}><Text style={s.linkText}>모두 보기</Text></Pressable>}
        </HomeSection>}
        <HomeSection title={current?.personal ? '개인 문서' : '공간 문서'}>
          {list.slice(0, 20).map(memo => <DocumentRow key={memo.id} memo={memo} compact onMore={onMore} onPress={() => open(memo)} hasChildren={parentIds.has(memo.id)} collapsed={collapsed.has(memo.id)} onToggle={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(memo.id)) next.delete(memo.id); else next.add(memo.id); return next; })} />)}
          {list.length > 20 && <Pressable accessibilityRole="button" style={s.link} onPress={() => go(ROUTES.Memos)}><Text style={s.linkText}>모든 문서 보기</Text></Pressable>}
          {!documents.length && <Text style={s.emptyInline}>아직 작성한 문서가 없습니다.</Text>}
        </HomeSection>
        {waiting.length > 0 && <Pressable accessibilityRole="button" accessibilityState={{ expanded: reviewOpen }} onPress={() => { setReviewOpen(v => !v); setSelectedProposal(null); }} style={s.homeReview}><Icon name="checkSquare" size={18} color={c.muted} /><Text style={s.rowTitle}>검토할 작업</Text><Text style={s.linkText}>{waiting.length}</Text><Icon name={reviewOpen ? 'chevronUp' : 'chevronDown'} size={14} color={c.subtle} /></Pressable>}
        {/* 검토할 작업은 따로 페이지로 가지 않고 이 자리에서 펼쳐 저장, 보류, 무시 */}
        {reviewOpen && waiting.map(p => renderProposal(p))}
        {appUpdate && <Pressable accessibilityRole="button" accessibilityLabel={`새 버전 ${appUpdate.version} 받기`} onPress={() => Linking.openURL(appUpdate.url)} style={s.homeReview}><Icon name="arrowUp" size={18} color={c.muted} /><Text style={s.rowTitle}>새 버전 {appUpdate.version}</Text><Text style={s.linkText}>받기</Text></Pressable>}
      </ScrollView>
      {!embedded && askDock}
    </>;
  }
  // 탭 안에서 지금 보이는 쪽. 탭 버튼으로 들어오면 첫 쪽, 다른 화면에서 그 쪽의 경로로 바로 왔으면 그 쪽
  const subIndexOf = (tab, i) => {
    const pages = tab.pages;
    const requested = pages.findIndex(p => p.route === route?.params?.subpage);
    const direct = !route?.tab && tab.route !== ROUTES.Home ? pages.findIndex(p => p.route === route?.name) : -1;
    return i === pagerIndex ? Math.max(0, requested >= 0 ? requested : direct) : 0;
  };
  const renderTab = (tab, i) => {
    const pages = tab.pages;
    // 탭 버튼으로 들어오면 첫 쪽. 다른 화면에서 그 탭의 경로로 바로 이동했으면(예: '할 일' 명령) 그 경로의 쪽을 연다.
    // 홈은 앱을 처음 열 때도 같은 경로라 항상 첫 쪽(오늘)부터
    const subIndex = subIndexOf(tab, i);
    const select = name => navigation.setParams({ subpage: name });
    return <PageRail index={subIndex} pages={pages} header={active => pages.length < 2 ? null :
      <View><ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 16, gap: 16, alignItems: 'center' }}>
        {pages.map(page => {
          const selected = page.route === active.route;
          return <Pressable key={page.route} accessibilityRole="tab" accessibilityLabel={page.label}
            aria-selected={selected} accessibilityState={{ selected }} onPress={() => select(page.route)}
            style={{ minHeight: 44, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: selected ? c.text : 'transparent' }}>
            <Text style={{ color: selected ? c.text : c.muted, fontSize: 14 }}>{page.label}</Text>
          </Pressable>;
        })}
      </ScrollView></View>}
      renderPage={(page, j) => {
        if (page.route === ROUTES.Home) return content;
        const mode = DOCUMENT_MODES[page.route];
        if (mode) return <WorkspaceScreen bodyOnly mode={mode} navigation={navigation} route={i === pagerIndex ? route : undefined} />;
        const Tool = screens[page.route];
        return <ScreenEntryProvider value={EMBEDDED_ENTRY}><Tool bodyOnly calendar={calendar} navigation={j === 0 ? navigation : { ...navigation, goBack: () => select(pages[0].route) }}
          route={{ name: page.route, params: i === pagerIndex ? route?.params ?? {} : {} }} /></ScreenEntryProvider>;
      }} />;
  };  return <View style={s.root}>{pagerIndex !== undefined
    ? <><SwipeNav tabs={TABS} current={TABS[pagerIndex]?.route} onPreview={setTabPreview} onTab={route => (navigation.selectTab || navigation.navigate)(route)}
        onPage={step => {
          const pages = TABS[pagerIndex].pages, next = subIndexOf(TABS[pagerIndex], pagerIndex) + step;
          if (step && next >= 0 && next < pages.length) navigation.setParams({ subpage: pages[next].route });
        }}>
        <PageRail index={pagerIndex} pages={TABS} keepVisited header={tab => header(tab.route)} renderPage={renderTab} />
      </SwipeNav>
      {!OWN_BOTTOM_BAR.has(TABS[pagerIndex]?.pages[subIndexOf(TABS[pagerIndex], pagerIndex)]?.route) && askDock}</>
    : <>{!bodyOnly && header()}{content}</>}{actions.snack.view}{note.sheet}
      <SheetModal visible={!!rowMenu} onClose={() => setRowMenu(null)} label="문서 메뉴"><View style={s.handle} />
        <Text style={[s.sectionTitle, { textAlign: 'center', marginBottom: 8 }]} numberOfLines={1}>{rowMenu ? memoTitle(rowMenu) : ''}</Text>
        {rowMenu && [
          ...(rowMenu.viewOnly ? [] : [[rowMenu.favorite ? '즐겨찾기 해제' : '즐겨찾기에 추가', rowMenu.favorite ? 'starFilled' : 'star', () => setFavorites([rowMenu.id], !rowMenu.favorite)]]),
          ['하위 문서 추가', 'plus', () => go(ROUTES.MemoEdit, { parentId: rowMenu.id })],
          ...(rowMenu.viewOnly ? [] : [['휴지통으로 이동', 'trash', () => setRowDelete(rowMenu)]])].map(([label, icon, run]) =>
          <Pressable key={label} accessibilityRole="button" onPress={() => { setRowMenu(null); run(); }} style={s.menuRow}>
            <Icon name={icon} size={18} color={c.muted} /><Text style={s.menuLabel}>{label}</Text>
          </Pressable>)}
      </SheetModal>
      <ConfirmDialog visible={!!rowDelete} title="문서를 휴지통으로 옮길까요?" sub={`${rowDelete ? memoTitle(rowDelete) : ''}은 휴지통에서 복원할 수 있습니다. 그 아래의 문서는 한 단계 위로 옮겨 보존합니다.`}
        confirmText="휴지통으로 이동" danger onCancel={() => setRowDelete(null)} onConfirm={trashRow} /><SheetModal visible={menu} onClose={() => setMenu(false)} label="작업 공간 메뉴"><View style={s.handle} /><View style={s.titleRow}><Text style={s.sectionTitle}>나의 작업 공간</Text><IconButton name="x" label="메뉴 닫기" onPress={() => setMenu(false)} /></View><ScrollView style={{ flexShrink: 1 }} showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
      {/* 공간 / AI / 관리 세 묶음. 묶음마다 둥근 면 안에 같은 높이의 행, 아이콘 열과 글자 시작점을 맞춘다. */}
      {[['공간', [...spaces.list.map(space => ({ key: space.id, label: space.name, icon: space.personal ? 'home' : 'users', checked: space.id === current?.id, onPress: () => {
          if (space.id === current?.id) return setMenu(false);
          setMenu(false); setSwitchTo(space); // 바로 넘어가지 않고 한 번 묻는다
        } })), ...SPACE_TOOLS.filter(([, , , group]) => group === '공간').map(tool)]],
        ['AI', SPACE_TOOLS.filter(([, , , group]) => group === 'AI').map(tool)],
        ['관리', SPACE_TOOLS.filter(([, , , group]) => group === '관리').map(tool)]].map(([group, items]) => <View key={group}>
        <Text style={s.menuGroupLabel}>{group}</Text>
        <View style={s.menuGroup}>{items.map((item, i) => <View key={item.key}>{i > 0 && <View style={s.menuDivider} />}
          <Pressable accessibilityRole="button" accessibilityState={item.checked ? { selected: true } : undefined} onPress={item.onPress} style={({ pressed }) => [s.menuGroupRow, pressed && { opacity: .6 }]}>
            <View style={s.menuIcon}><Icon name={item.icon} size={18} color={c.muted} /></View>
            <Text style={s.menuLabel}>{item.label}</Text>
            {item.count > 0 && <Text style={s.linkText}>{item.count}</Text>}
            {item.checked ? <Icon name="check" size={17} color={c.accent} /> : item.chevron && <Icon name="chevronRight" size={14} color={c.subtle} />}
          </Pressable></View>)}</View>
      </View>)}</ScrollView></SheetModal>
    <ConfirmDialog visible={!!switchTo} title={`${switchTo?.personal ? '개인 공간' : `'${switchTo?.name}' 팀 공간`}으로 바꿀까요?`}
      sub={switchTo?.personal ? '내 문서와 일정만 보여요.' : '이 공간의 문서와 일정은 팀원과 함께 보고 편집해요.'} confirmText="바꾸기"
      onCancel={() => setSwitchTo(null)}
      onConfirm={() => { const target = switchTo; setSwitchTo(null); try { switchWorkspace(target.id); setError(''); } catch (e) { setError(e.message); } }} /></View>;
}
