// 탭 화면 공통 하단 (Notion 모바일과 같은 배치): 왼쪽 검색, 가운데 AI에게 질문하기, 오른쪽 새로 만들기.
// 검색을 누르면 돋보기가 검색창으로 길게 늘어나며 검색 화면이 열린다: 맨 위 AI에게 묻기, 아래로 오늘, 어제, 이번 주,
// 이번 달, 이전 문서. 검색창 오른쪽 필터에서 정렬과 제목만 검색을 고른다. 새로 만들기는 AI 노트, 채팅, 페이지.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, BackHandler, Easing, Keyboard, Pressable, ScrollView, Switch, Text, TextInput, View, useWindowDimensions } from 'react-native';
import Icon from '../../shared/components/Icon';
import { SheetModal } from '../../shared/components/Motion';
import { palette as c, styles as s } from './theme';

const DAY = 86400000;
const SORTS = [['updated', '최근 수정순'], ['created', '최근 생성순'], ['title', '제목순']];
// 오늘, 어제, 이번 주(지난 7일), 이번 달(지난 30일), 이전
export function groupByAge(items, now = Date.now()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const label = t => t >= today ? '오늘' : t >= today - DAY ? '어제' : t >= today - 6 * DAY ? '이번 주' : t >= today - 29 * DAY ? '이번 달' : '이전';
  const groups = [];
  for (const item of items) {
    const name = label(item.time);
    const last = groups.at(-1);
    if (last?.name === name) last.items.push(item); else groups.push({ name, items: [item] });
  }
  return groups;
}

export default function SearchDock({ docs, bottomInset, onOpen, onAskAI, onNew }) {
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('updated');
  const [titleOnly, setTitleOnly] = useState(false);
  const [filters, setFilters] = useState(false);
  const filterAfterKeyboard = useRef(false);
  const [menu, setMenu] = useState(false);
  const [keyboard, setKeyboard] = useState(0); // 화면이 키보드만큼 줄지 않는 기기에서도 검색창을 키보드 위에 둔다
  useEffect(() => {
    const up = Keyboard.addListener('keyboardDidShow', e => setKeyboard(e.endCoordinates?.height ?? 0));
    // 키보드가 다 내려간 뒤에 필터 시트를 연다 (내려가는 중에 시트가 같이 올라오면 화면이 출렁임)
    const down = Keyboard.addListener('keyboardDidHide', () => { setKeyboard(0); if (filterAfterKeyboard.current) { filterAfterKeyboard.current = false; setFilters(true); } });
    return () => { up.remove(); down.remove(); };
  }, []);
  const grow = useRef(new Animated.Value(0)).current;
  const input = useRef(null);
  const animate = to => Animated.timing(grow, { toValue: to, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: false });
  const show = () => { setMenu(false); setOpen(true); animate(1).start(() => input.current?.focus()); };
  const hide = () => { Keyboard.dismiss(); animate(0).start(() => { setOpen(false); setQuery(''); }); };
  useEffect(() => {
    if (!open) return undefined;
    const back = BackHandler.addEventListener('hardwareBackPress', () => { hide(); return true; });
    return () => back.remove();
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = d => !q || d.title.toLowerCase().includes(q) || (!titleOnly && d.body.toLowerCase().includes(q));
    const list = docs.filter(hit).map(d => ({ ...d, time: sort === 'created' ? d.createdAt : d.updatedAt }));
    if (sort === 'title') return [{ name: '제목순', items: list.sort((a, b) => a.title.localeCompare(b.title, 'ko')) }];
    return groupByAge(list.sort((a, b) => b.time - a.time));
  }, [docs, query, sort, titleOnly]);

  // 검색창 너비: 돋보기 원(44)에서 닫기 버튼만 남기고 가로 전체로
  const fieldWidth = grow.interpolate({ inputRange: [0, 1], outputRange: [44, width - 32 - 44 - 8] });
  const fade = grow.interpolate({ inputRange: [0, 0.5], outputRange: [1, 0], extrapolate: 'clamp' });

  return <>
    {open && <Animated.View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, backgroundColor: c.background, opacity: grow }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 56, paddingBottom: 120 }}>
        <Text style={[s.pageTitle ?? {}, { color: c.text, fontSize: 26, fontWeight: '700', marginBottom: 12 }]} accessibilityRole="header">검색</Text>
        <Pressable accessibilityRole="button" onPress={() => { hide(); onAskAI(query.trim()); }} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 }, pressed && { opacity: .6 }]}>
          <Icon name="sparkles" size={20} color={c.muted} />
          <Text style={{ color: c.text, fontSize: 15, flex: 1 }} numberOfLines={1}>{query.trim() ? `AI에게 "${query.trim()}" 물어보기` : 'AI에게 무엇이든 물어보기'}</Text>
        </Pressable>
        {results.map(group => <View key={group.name}>
          <Text style={[s.homeSectionLabel, { marginTop: 14, marginBottom: 4 }]}>{group.name}</Text>
          {group.items.map(d => <Pressable key={d.id} accessibilityRole="button" onPress={() => { hide(); onOpen(d.id); }} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56 }, pressed && { opacity: .6 }]}>
            <Icon name="file" size={18} color={c.subtle} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.text, fontSize: 15 }} numberOfLines={1}>{d.title}</Text>
              {!!d.parent && <Text style={{ color: c.subtle, fontSize: 12, marginTop: 2 }} numberOfLines={1}>({d.parent})</Text>}
            </View>
          </Pressable>)}
        </View>)}
        {!results.length && <Text style={[s.emptyInline ?? {}, { color: c.subtle, marginTop: 16 }]}>{query.trim() ? '검색 결과가 없어요' : '아직 문서가 없어요'}</Text>}
      </ScrollView>
    </Animated.View>}

    {menu && <>
      <Pressable accessibilityLabel="새로 만들기 닫기" onPress={() => setMenu(false)} style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} />
      <View style={{ position: 'absolute', right: 16, bottom: Math.max(10, bottomInset) + 60, minWidth: 180, backgroundColor: c.surface, borderRadius: 10, paddingVertical: 4 }}>
        {[['mic', 'AI 노트', 'note'], ['message', '채팅', 'chat'], ['file', '페이지', 'page']].map(([icon, label, kind]) =>
          <Pressable key={kind} accessibilityRole="button" onPress={() => { setMenu(false); onNew(kind); }} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, paddingHorizontal: 16 }, pressed && { backgroundColor: c.raised }]}>
            <Icon name={icon} size={18} color={c.muted} /><Text style={{ color: c.text, fontSize: 15 }}>{label}</Text>
          </Pressable>)}
      </View>
    </>}

    <View style={[s.homeDock, { gap: 8, paddingBottom: open && keyboard ? keyboard + bottomInset + 8 : Math.max(10, bottomInset), backgroundColor: c.background }]}>
      <Animated.View style={{ width: fieldWidth, height: 44, borderRadius: 22, backgroundColor: c.surface, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' }}>
        <Pressable accessibilityRole="button" accessibilityLabel="검색" onPress={open ? () => input.current?.focus() : show} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="search" size={19} color={c.muted} />
        </Pressable>
        {open && <>
          <TextInput ref={input} accessibilityLabel="문서 검색" value={query} onChangeText={setQuery} placeholder="무엇이든 검색하기..." placeholderTextColor={c.subtle} returnKeyType="search"
            style={{ flex: 1, color: c.text, fontSize: 15, paddingVertical: 0 }} />
          <Pressable accessibilityRole="button" accessibilityLabel="검색 필터" onPress={() => { if (keyboard) { filterAfterKeyboard.current = true; Keyboard.dismiss(); } else setFilters(true); }} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="list" size={18} color={sort !== 'updated' || titleOnly ? c.text : c.muted} />
          </Pressable>
        </>}
      </Animated.View>
      {open ? <Pressable accessibilityRole="button" accessibilityLabel="검색 닫기" onPress={hide} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="x" size={18} color={c.muted} />
        </Pressable>
        : <Animated.View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, opacity: fade }}>
          <Pressable accessibilityRole="button" accessibilityLabel="AI에게 질문하기" onPress={() => onAskAI('')} style={({ pressed }) => [s.askPill, pressed && { opacity: .6 }]}>
            <Icon name="sparkles" size={17} color={c.muted} /><Text style={s.homeSearchText}>AI에게 질문하기</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="새로 만들기" accessibilityState={{ expanded: menu }} onPress={() => setMenu(!menu)} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="pencil" size={18} color={c.text} />
          </Pressable>
        </Animated.View>}
    </View>

    <SheetModal visible={filters} onClose={() => setFilters(false)} label="검색 필터">
      <View style={s.handle} />
      <Text style={[s.sectionTitle, { textAlign: 'center', marginBottom: 8 }]}>필터</Text>
      {SORTS.map(([key, label]) => <Pressable key={key} accessibilityRole="radio" accessibilityState={{ checked: sort === key }} onPress={() => setSort(key)} style={s.menuRow}>
        <Icon name="arrowUp" size={16} color={c.muted} /><Text style={[s.menuLabel, { flex: 1 }]}>{label}</Text>{sort === key && <Icon name="check" size={16} color={c.text} />}
      </Pressable>)}
      <View style={s.menuRow}>
        <Text style={{ color: c.muted, fontSize: 14, width: 24 }} numberOfLines={1}>Aa</Text><Text style={[s.menuLabel, { flex: 1 }]}>제목만</Text>
        <Switch accessibilityLabel="제목만 검색" value={titleOnly} onValueChange={setTitleOnly} trackColor={{ true: c.subtle, false: c.raised }} thumbColor={c.text} />
      </View>
    </SheetModal>
  </>;
}
