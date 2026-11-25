import { SheetModal } from "../../shared/components/Motion";
import React, { useState, useEffect, useRef, useLayoutEffect } from 'react';
import { Animated, Easing, Platform, FlatList, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import TabBar from '../../navigation/TabBar';
import { ScreenEntryProvider } from '../../navigation/ScreenEntry';
import { useFiles } from '../../data/files/FileStore';
import GraphCanvas from './GraphCanvas';
import { runtime, useValue, readPreference, writePreference } from '../../data/hooks';
import { randomUUID } from 'expo-crypto';
import { isPlaced, placeProposal } from './aiPending.mjs';
import Icon from '../../shared/components/Icon';
import { useInsets } from '../../shared/hooks/useInsets';
import { useMemos, memoTitle } from '../../data/memos/MemoStore';
import { useProposals } from '../../data/proposals/ProposalStore';
import { useWorkspaces, switchWorkspace } from '../../data/workspaces/WorkspaceStore';
import { reviewReason, useProposalActions } from '../proposal/useProposalActions';
import { ROUTES, TABS } from '../../navigation/routes';
import { filterDocuments } from './model.mjs';
import { readMemoBlocks } from '../memo/utils/memoBlocks.mjs';
import { readMemoReference } from '../memo/utils/memoReferences.mjs';
import { palette as c, styles as s } from './theme';
import { LOCAL_PREVIEW } from '../../integration/mode';
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
  tabs
}) {
  const insets = useInsets();
  if (tabs) return <View style={[s.navigationHeader, { paddingTop: insets.top + 10 }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`작업 공간 메뉴 열기: ${title}`} hitSlop={{ left: 6, right: 6 }} onPress={onMenu} style={s.workspaceAvatar}><Text style={s.workspaceInitial}>S</Text></Pressable>
    {tabs}
  </View>;
  const headerStyle = [s.header, { paddingTop: insets.top + 8 }];
  if (onBack) return <View style={headerStyle}>
    <View style={[s.actions, { flex: 1 }]}>{left}<IconButton name="chevronLeft" label="뒤로 가기" onPress={onBack} /></View>
    <Text numberOfLines={1} style={[s.brandTitle, { flexShrink: 1, maxWidth: '32%', textAlign: 'center' }]}>{title}</Text>
    <View style={[s.actions, { flex: 1, justifyContent: 'flex-end' }]}>{right || (onSearch && <IconButton name="search" label="문서 검색" onPress={onSearch} />)}</View>
  </View>;
  return <View style={headerStyle}>{left}<Pressable accessibilityRole="button" accessibilityLabel="작업 공간 메뉴 열기" onPress={onMenu} style={s.brand}><Text style={s.brandMark}>S</Text><View style={{
        flexShrink: 1
      }}><Text style={s.brandTitle} numberOfLines={1}>{title}</Text><Text style={s.brandSub}>Atria{LOCAL_PREVIEW ? ', 로컬 미리보기' : ''}</Text></View><Icon name="chevronDown" size={14} color={c.muted} /></Pressable><View style={s.actions}>{right || <>{onSearch && <IconButton name="search" label="문서 검색" onPress={onSearch} />}</>}</View></View>;
}
function DocumentRow({ memo, onPress, hasChildren, collapsed, onToggle, compact = false }) {
  const title = memoTitle(memo);
  const [showEmpty, setShowEmpty] = useState(false);
  const expanded = hasChildren ? !collapsed : showEmpty;
  return <View style={{ paddingLeft: Math.min(memo.depth ?? 0, 5) * 12 }}>
    <View style={[s.row, { alignItems: 'center', paddingVertical: 0, gap: 6 }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress}
      style={({ pressed }) => [{ flex: 1, minHeight: 44, flexDirection: 'row',
        alignItems: 'center', gap: 8, paddingVertical: compact ? 0 : 6, opacity: pressed ? .6 : 1 }]}>
      <Icon name="file" size={18} color={c.muted} />
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{title}</Text>
        {!compact && <><Text style={s.rowBody} numberOfLines={1}>{memo.body || '필기나 첨부가 있는 문서'}</Text>
          <Text style={s.meta}>{memo.favorite ? '즐겨찾기, ' : ''}{new Date(memo.updatedAt).toLocaleDateString('ko-KR')}, 기기 저장</Text></>}
      </View>
    </Pressable>
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
      <View style={s.recentCardHeading}><Icon name="file" size={16} color={c.subtle} /><Text style={s.recentTitle} numberOfLines={2}>{memoTitle(memo)}</Text></View>
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
  const memoRows = useMemos();
  const files = useFiles();
  const documents = useValue(() => runtime().documents.listDocuments());
  const proposals = useProposals();
  const spaces = useWorkspaces();
  const memos = memoRows;
  const actions = useProposalActions(navigation);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set());
  const [filter, setFilter] = useState(favoritesOnly ? 'favorites' : 'all');
  const [reviewTab, setReviewTab] = useState('pending');
  const [error, setError] = useState('');
  const current = spaces.current;
  useEffect(() => setCollapsed(new Set()), [current?.id]);
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
  const header = (highlight = selectedTab) => standalone ? <WorkspaceHeader title={title} onBack={() => navigation.goBack()} /> : <><WorkspaceHeader title={current?.name || '나의 작업 공간'} onMenu={() => setMenu(true)} tabs={!favoritesOnly && <TabBar current={highlight} onSelect={navigation.selectTab || navigation.navigate} />} onSearch={mode === "documents" ? undefined : () => go(ROUTES.Memos, {
      search: true
    })} />{error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}</>;
  const intro = standalone ? null : <><View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>{title}</Text></View></>;
  let content;
  if (mode === 'documents') {
    content = <FlatList showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} data={list} keyExtractor={memo => memo.id} contentContainerStyle={s.page} keyboardShouldPersistTaps="handled" ListHeaderComponent={<>{intro}<View style={s.search}><Icon name="search" size={17} color={c.muted} /><TextInput autoFocus={requestSearch} accessibilityLabel="문서 검색" placeholder="제목이나 내용으로 검색" placeholderTextColor={c.subtle} value={query} onChangeText={setQuery} style={s.searchInput} />{query ? <IconButton name="x" label="검색어 지우기" onPress={() => setQuery('')} /> : null}</View><View style={s.filters}>{[['all', '모든 문서'], ['favorites', '즐겨찾기']].map(([key, label]) => <Pressable key={key} accessibilityRole="tab" accessibilityState={{
          selected: filter === key
        }} onPress={() => setFilter(key)} style={[s.filter, filter === key && s.filterOn]}><Text style={[s.filterText, filter === key && {
            color: c.text
          }]}>{label}</Text></Pressable>)}</View></>} renderItem={({
      item
    }) => <DocumentRow memo={item} compact={!query} onPress={() => open(item)} hasChildren={parentIds.has(item.id)} collapsed={collapsed.has(item.id)} onToggle={() => setCollapsed(previous => {
      const next = new Set(previous);
      if (next.has(item.id)) next.delete(item.id);else next.add(item.id);
      return next;
    })} />} ListEmptyComponent={<Text style={s.empty}>{query ? '검색 결과가 없습니다.' : filter === 'favorites' ? '즐겨찾기한 문서가 없습니다.' : '아직 문서가 없습니다.\n새 문서에서 첫 생각을 기록하세요.'}</Text>} />;
    // 홈 하단 도크와 같은 자리(엄지가 닿는 오른쪽 아래)에 새 문서 버튼
    content = <>{content}<View style={[s.homeDock, { justifyContent: 'flex-end', paddingBottom: Math.max(10, insets.bottom) }]}><IconButton name="pencil" label="새 문서 작성" onPress={() => go(ROUTES.MemoEdit)} /></View></>;
  } else if (mode === 'review') {
    const items = proposals.filter(p => p.status === reviewTab && shown(p));
    content = <FlatList showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} data={items} keyExtractor={p => p.id} contentContainerStyle={s.page} ListHeaderComponent={<>{intro}<View style={s.filters}>{[['pending', '확인 대기'], ['hold', '보류']].map(([key, label]) => <Pressable key={key} accessibilityRole="tab" accessibilityState={{
          selected: reviewTab === key
        }} onPress={() => setReviewTab(key)} style={[s.filter, reviewTab === key && s.filterOn]}><Text style={[s.filterText, reviewTab === key && {
            color: c.text
          }]}>{label}</Text></Pressable>)}</View></>} renderItem={({
      item: p
    }) => <View style={s.proposal}><Text style={[s.meta, {
        color: c.accent
      }]}>{p.kind === 'memo' ? '문서 요약' : p.kind === 'event' ? '일정' : '할 일'} 제안</Text><Text style={[s.sectionTitle, {
        marginTop: 9
      }]}>{p.title}</Text><Text selectable style={s.proposalBody}>{p.body || p.evidence || [p.date, p.start, p.place].filter(Boolean).join(', ')}</Text>{p.sourceType === 'memo' && p.sourceId ? <Pressable accessibilityRole="button" onPress={() => go(ROUTES.MemoEdit, {
        memoId: p.sourceId
      })} style={s.link}><Icon name="file" size={14} color={c.muted} /><Text style={s.linkText} numberOfLines={1}>출처: {p.sourceTitle || '원본 문서'}</Text></Pressable> : null}{reviewReason(p) ? <Text style={s.note} accessibilityRole="alert" accessibilityLabel={`경고: ${reviewReason(p)}`}>{reviewReason(p)}</Text> : null}<View style={[s.actions, {
        marginTop: 14,
        gap: 8
      }]}><Pressable accessibilityRole="button" onPress={() => actions.hold(p)} style={s.secondary}><Text style={s.secondaryText}>보류</Text></Pressable><Pressable accessibilityRole="button" onPress={() => actions.dismiss(p)} style={s.secondary}><Text style={s.secondaryText}>무시</Text></Pressable>{(p.kind === 'memo' || (p.sourceType === 'memo' && p.sourceId && !reviewReason(p))) && <Pressable accessibilityRole="button" onPress={() => place(p)} style={s.secondary}><Text style={s.secondaryText}>문서에 넣기</Text></Pressable>}<PrimaryButton label={reviewReason(p) ? '내용 확인' : '확인 후 저장'} icon="check" onPress={() => actions.edit(p)} /></View></View>} ListEmptyComponent={<Text style={s.empty}>{reviewTab === 'hold' ? '보류한 작업이 없습니다.' : '검토할 제안이 없습니다.'}</Text>} />;
  } else if (mode === 'relations') {
    content = <GraphCanvas key={current?.id} navigation={navigation} />;
  } else {
    content = <>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.homePage}>
        {memos.length > 0 && <HomeSection title="최근 문서"><ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.recentRail} contentContainerStyle={s.recentRailContent}>
          {memos.slice(0, 6).map(memo => <RecentDocument key={memo.id} memo={memo} photo={files.find(file => file.id === memo.photos?.[0])} onPress={() => open(memo)} />)}
        </ScrollView></HomeSection>}
        {memos.some(memo => memo.favorite) && <HomeSection title="즐겨찾기">
          {memos.filter(memo => memo.favorite).slice(0, 5).map(memo => <DocumentRow key={memo.id} memo={memo} compact onPress={() => open(memo)} />)}
          {memos.filter(memo => memo.favorite).length > 5 && <Pressable accessibilityRole="button" style={s.link} onPress={() => go(ROUTES.Favorites)}><Text style={s.linkText}>모두 보기</Text></Pressable>}
        </HomeSection>}
        <HomeSection title={current?.personal ? '개인 문서' : '공간 문서'}>
          {list.slice(0, 20).map(memo => <DocumentRow key={memo.id} memo={memo} compact onPress={() => open(memo)} hasChildren={parentIds.has(memo.id)} collapsed={collapsed.has(memo.id)} onToggle={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(memo.id)) next.delete(memo.id); else next.add(memo.id); return next; })} />)}
          {list.length > 20 && <Pressable accessibilityRole="button" style={s.link} onPress={() => go(ROUTES.Memos)}><Text style={s.linkText}>모든 문서 보기</Text></Pressable>}
          {!documents.length && <Text style={s.emptyInline}>아직 작성한 문서가 없습니다.</Text>}
        </HomeSection>
        {waiting.length > 0 && <Pressable accessibilityRole="button" onPress={() => go(ROUTES.Proposals)} style={s.homeReview}><Icon name="checkSquare" size={18} color={c.muted} /><Text style={s.rowTitle}>검토할 작업</Text><Text style={s.linkText}>{waiting.length}</Text></Pressable>}
      </ScrollView>
      <View style={[s.homeDock, { paddingBottom: Math.max(10, insets.bottom) }]}><Pressable accessibilityRole="button" onPress={() => go(ROUTES.Search)} style={s.homeSearch}><Icon name="search" size={19} color={c.muted} /><Text style={s.homeSearchText}>검색</Text></Pressable><IconButton name="pencil" label="새 문서 작성" onPress={() => go(ROUTES.MemoEdit)} /></View>
    </>;
  }
  const renderTab = (tab, i) => {
    const pages = tab.pages;
    const subIndex = i === pagerIndex ? Math.max(0, pages.findIndex(p => p.route === route?.params?.subpage)) : 0;
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
    ? <PageRail index={pagerIndex} pages={TABS} keepVisited header={tab => header(tab.route)} renderPage={renderTab} />
    : <>{!bodyOnly && header()}{content}</>}{actions.snack.view}<SheetModal visible={menu} onClose={() => setMenu(false)} label="작업 공간 메뉴"><View style={s.handle} /><View style={s.titleRow}><Text style={s.sectionTitle}>나의 작업 공간</Text><IconButton name="x" label="메뉴 닫기" onPress={() => setMenu(false)} /></View><ScrollView style={{ flexShrink: 1 }} showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 4 }}>
      {/* 공간 / AI / 관리 세 묶음. 묶음마다 둥근 면 안에 같은 높이의 행, 아이콘 열과 글자 시작점을 맞춘다. */}
      {[['공간', [...spaces.list.map(space => ({ key: space.id, label: space.name, icon: space.personal ? 'home' : 'users', checked: space.id === current?.id, onPress: () => {
          try { switchWorkspace(space.id); setMenu(false); setError(''); } catch (e) { setError(e.message); setMenu(false); }
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
      </View>)}</ScrollView></SheetModal></View>;
}
