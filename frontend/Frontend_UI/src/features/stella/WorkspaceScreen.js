import { SheetModal } from "../../shared/components/Motion";
import React, { useState, useEffect } from 'react';
import { FlatList, Image, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import TabBar from '../../navigation/TabBar';
import { useFiles } from '../../data/files/FileStore';
import GraphCanvas from './GraphCanvas';
import { runtime, useValue } from '../../data/hooks';
import Icon from '../../shared/components/Icon';
import { useInsets } from '../../shared/hooks/useInsets';
import { useMemos, memoTitle } from '../../data/memos/MemoStore';
import { useProposals } from '../../data/proposals/ProposalStore';
import { useWorkspaces, switchWorkspace } from '../../data/workspaces/WorkspaceStore';
import { reviewReason, useProposalActions } from '../proposal/useProposalActions';
import { ROUTES } from '../../navigation/routes';
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
  }]}><Icon name={icon} size={17} color={c.background} /><Text style={s.primaryText}>{label}</Text></Pressable>;
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
  return <View style={[s.header, {
    paddingTop: insets.top + 8
  }]}>{left}{onBack ? <><IconButton name="chevronLeft" label="뒤로 가기" onPress={onBack} /><Text style={s.brandTitle}>{title}</Text></> : <Pressable accessibilityRole="button" accessibilityLabel="작업 공간 메뉴 열기" onPress={onMenu} style={s.brand}><Text style={s.brandMark}>S</Text><View style={{
        flexShrink: 1
      }}><Text style={s.brandTitle} numberOfLines={1}>{title}</Text><Text style={s.brandSub}>Stella{LOCAL_PREVIEW ? '  /  로컬 미리보기' : ''}</Text></View><Icon name="chevronDown" size={14} color={c.muted} /></Pressable>}<View style={s.actions}>{right || <>{onSearch && <IconButton name="search" label="문서 검색" onPress={onSearch} />}</>}</View></View>;
}
function DocumentRow({
  memo,
  onPress,
  hasChildren = false,
  collapsed = false,
  onToggle,
  compact = false,
  showArrow = true
}) {
  return <View style={[s.row, {
    paddingLeft: Math.min(memo.depth ?? 0, 5) * 16
  }]}>
    <View style={{
      width: 24
    }}>{hasChildren ? <Pressable accessibilityRole="button" accessibilityLabel={`${collapsed ? '펼치기' : '접기'}: ${memoTitle(memo)}`} onPress={onToggle} hitSlop={8} style={{
        minWidth: 24,
        minHeight: 36
      }}><Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={18} color={c.muted} /></Pressable> : <Icon name="file" size={20} color={c.muted} />}</View>
    <Pressable accessibilityRole="button" accessibilityLabel={memoTitle(memo)} onPress={onPress} style={({
      pressed
    }) => [{
      flex: 1,
      flexDirection: 'row',
      gap: 10,
      alignItems: 'flex-start'
    }, pressed && {
      opacity: .6
    }]}>
      <View style={{
        flex: 1
      }}><Text style={s.rowTitle} numberOfLines={1}>{memoTitle(memo)}</Text>{!compact && <><Text style={s.rowBody} numberOfLines={1}>{memo.body || '필기 / 첨부가 있는 문서'}</Text><Text style={s.meta}>{memo.favorite ? '즐겨찾기  /  ' : ''}{new Date(memo.updatedAt).toLocaleDateString('ko-KR')}  /  기기 저장</Text></>}</View>
      {showArrow && <Icon name="chevronRight" size={15} color={c.subtle} />}
    </Pressable>
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
const TOOLS = [[ROUTES.Backup, '백업 및 복원', 'file'], [ROUTES.LocalModel, '로컬 AI', 'sparkles'], [ROUTES.AdvancedMemos, '가져오기 / 내보내기', 'file'], [ROUTES.Today, '오늘 / 빠른 기록', 'home'], [ROUTES.Calendar, '캘린더', 'calendar'], [ROUTES.Tasks, '할 일 / 일정', 'checkSquare'], [ROUTES.Ai, 'AI 채팅', 'message'], [ROUTES.Files, '파일 보관함', 'paperclip'], [ROUTES.Spaces, '공유 공간', 'users'], [ROUTES.Projects, '프로젝트', 'grid'], [ROUTES.Favorites, '즐겨찾기', 'star'], [ROUTES.QuickInput, '사진 / 문서 가져오기', 'arrowUp'], [ROUTES.More, '모든 도구', 'grid'], [ROUTES.Trash, '휴지통', 'trash'], [ROUTES.Settings, '설정', 'settings']];
export default function WorkspaceScreen({
  navigation,
  route,
  mode = 'home',
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
  const [expandedTools, setExpandedTools] = useState(false);
  const primaryTools = [ROUTES.LocalModel, ROUTES.Backup, ROUTES.Trash, ROUTES.Settings];
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(new Set());
  const [filter, setFilter] = useState(favoritesOnly ? 'favorites' : 'all');
  const [reviewTab, setReviewTab] = useState('pending');
  const [error, setError] = useState('');
  const current = spaces.current;
  useEffect(() => setCollapsed(new Set()), [current?.id]);
  const parentIds = new Set(documents.map(document => document.parentId).filter(Boolean));
  const waiting = proposals.filter(p => p.status === 'pending' && !actions.hidden.has(p.id));
  const go = (name, params) => {
    setMenu(false);
    navigation.navigate(name, params);
  };
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
  const header = <><WorkspaceHeader title={current?.name || '나의 작업 공간'} onMenu={() => setMenu(true)} tabs={!favoritesOnly && <TabBar current={selectedTab} onSelect={navigation.selectTab || navigation.navigate} />} onSearch={mode === "documents" ? undefined : () => go(ROUTES.Memos, {
      search: true
    })} />{error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}</>;
  const intro = <><View style={s.titleRow}><Text accessibilityRole="header" style={s.title}>{title}</Text>{mode === 'documents' ? <IconButton name="plus" label="새 문서 작성" onPress={() => go(ROUTES.MemoEdit)} /> : mode === 'review' ? <Text style={s.meta}>대기 {waiting.length}건</Text> : null}</View></>;
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
  } else if (mode === 'review') {
    const items = proposals.filter(p => p.status === reviewTab && !actions.hidden.has(p.id));
    content = <FlatList showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} data={items} keyExtractor={p => p.id} contentContainerStyle={s.page} ListHeaderComponent={<>{intro}<Text style={s.intro}>제안 내용을 확인한 뒤 반영하세요.{'\n'}승인하기 전에는 원문이 바뀌지 않습니다.</Text><View style={s.filters}>{[['pending', '확인 대기'], ['hold', '보류']].map(([key, label]) => <Pressable key={key} accessibilityRole="tab" accessibilityState={{
          selected: reviewTab === key
        }} onPress={() => setReviewTab(key)} style={[s.filter, reviewTab === key && s.filterOn]}><Text style={[s.filterText, reviewTab === key && {
            color: c.text
          }]}>{label}</Text></Pressable>)}</View></>} renderItem={({
      item: p
    }) => <View style={s.proposal}><Text style={[s.meta, {
        color: c.accent
      }]}>{p.kind === 'memo' ? '문서 요약' : p.kind === 'event' ? '일정' : '할 일'} 제안</Text><Text style={[s.sectionTitle, {
        marginTop: 9
      }]}>{p.title}</Text><Text selectable style={s.proposalBody}>{p.body || p.evidence || [p.date, p.start, p.place].filter(Boolean).join('  /  ')}</Text>{p.sourceType === 'memo' && p.sourceId ? <Pressable accessibilityRole="button" onPress={() => go(ROUTES.MemoEdit, {
        memoId: p.sourceId
      })} style={s.link}><Icon name="file" size={14} color={c.muted} /><Text style={s.linkText} numberOfLines={1}>출처: {p.sourceTitle || '원본 문서'}</Text></Pressable> : null}{reviewReason(p) ? <Text style={s.note}>{reviewReason(p)}</Text> : null}<View style={[s.actions, {
        marginTop: 14,
        gap: 8
      }]}><Pressable accessibilityRole="button" onPress={() => actions.hold(p)} style={s.secondary}><Text style={s.secondaryText}>보류</Text></Pressable><Pressable accessibilityRole="button" onPress={() => actions.dismiss(p)} style={s.secondary}><Text style={s.secondaryText}>무시</Text></Pressable><PrimaryButton label={reviewReason(p) ? '내용 확인' : '확인 후 저장'} icon="check" onPress={() => actions.edit(p)} /></View></View>} ListEmptyComponent={<Text style={s.empty}>{reviewTab === 'hold' ? '보류한 작업이 없습니다.' : '승인을 기다리는 작업이 없습니다.\n문서의 AI 분석에서 생성한 제안이 여기에 표시됩니다.'}</Text>} />;
  } else if (mode === 'relations') {
    content = <GraphCanvas key={current?.id} navigation={navigation} />;
  } else {
    content = <>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.homePage}>
        {memos.length > 0 && <HomeSection title="최근 문서"><ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.recentRail} contentContainerStyle={s.recentRailContent}>
          {memos.slice(0, 6).map(memo => <RecentDocument key={memo.id} memo={memo} photo={files.find(file => file.id === memo.photos?.[0])} onPress={() => open(memo)} />)}
        </ScrollView></HomeSection>}
        {memos.some(memo => memo.favorite) && <HomeSection title="즐겨찾기">
          {memos.filter(memo => memo.favorite).slice(0, 5).map(memo => <DocumentRow key={memo.id} memo={memo} compact showArrow={false} onPress={() => open(memo)} />)}
          {memos.filter(memo => memo.favorite).length > 5 && <Pressable accessibilityRole="button" style={s.link} onPress={() => go(ROUTES.Favorites)}><Text style={s.linkText}>모두 보기</Text></Pressable>}
        </HomeSection>}
        <HomeSection title={current?.personal ? '개인 문서' : '공간 문서'}>
          {list.slice(0, 20).map(memo => <DocumentRow key={memo.id} memo={memo} compact showArrow={false} onPress={() => open(memo)} hasChildren={parentIds.has(memo.id)} collapsed={collapsed.has(memo.id)} onToggle={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(memo.id)) next.delete(memo.id); else next.add(memo.id); return next; })} />)}
          {list.length > 20 && <Pressable accessibilityRole="button" style={s.link} onPress={() => go(ROUTES.Memos)}><Text style={s.linkText}>모든 문서 보기</Text></Pressable>}
          {!documents.length && <Text style={s.emptyInline}>아직 작성한 문서가 없습니다.</Text>}
        </HomeSection>
        {waiting.length > 0 && <Pressable accessibilityRole="button" onPress={() => go(ROUTES.Proposals)} style={s.homeReview}><Icon name="checkSquare" size={18} color={c.muted} /><Text style={s.rowTitle}>검토할 작업</Text><Text style={s.linkText}>{waiting.length}</Text></Pressable>}
      </ScrollView>
      <View style={[s.homeDock, { paddingBottom: Math.max(10, insets.bottom) }]}><Pressable accessibilityRole="button" onPress={() => go(ROUTES.Memos, { search: true })} style={s.homeSearch}><Icon name="search" size={19} color={c.muted} /><Text style={s.homeSearchText}>검색</Text></Pressable><IconButton name="pencil" label="새 문서 작성" onPress={() => go(ROUTES.MemoEdit)} /></View>
    </>;
  }
  return <View style={s.root}>{header}{content}{actions.snack.view}<SheetModal visible={menu} onClose={() => setMenu(false)} label="작업 공간 메뉴"><View style={s.handle} /><View style={s.titleRow}><Text style={s.sectionTitle}>나의 작업 공간</Text><IconButton name="x" label="메뉴 닫기" onPress={() => setMenu(false)} /></View><ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false}>{spaces.list.map(space => <Pressable accessibilityRole="button" key={space.id} onPress={() => {
          try {
            switchWorkspace(space.id);
            setMenu(false);
            setError('');
          } catch (e) {
            setError(e.message);
            setMenu(false);
          }
        }} style={s.menuRow}><Icon name={space.personal ? 'home' : 'users'} size={18} color={c.muted} /><Text style={s.menuLabel}>{space.name}</Text>{space.id === current?.id && <Icon name="check" size={17} color={c.accent} />}</Pressable>)}<Text style={[s.meta, {
          marginTop: 20
        }]}>도구와 설정</Text>{TOOLS.filter(([name]) => expandedTools || primaryTools.includes(name)).map(([name, label, icon]) => <Pressable accessibilityRole="button" key={name} onPress={() => go(name)} style={s.menuRow}><Icon name={icon} size={18} color={c.muted} /><Text style={s.menuLabel}>{label}</Text><Icon name="chevronRight" size={14} color={c.subtle} /></Pressable>)}<Pressable accessibilityRole="button" accessibilityState={{expanded:expandedTools}} style={s.menuRow} onPress={()=>setExpandedTools(value=>!value)}><Text style={s.menuLabel}>{expandedTools ? "도구 접기" : "다른 도구 보기"}</Text><Icon name={expandedTools ? "chevronUp" : "chevronDown"} size={16} color={c.muted}/></Pressable></ScrollView></SheetModal></View>;
}
