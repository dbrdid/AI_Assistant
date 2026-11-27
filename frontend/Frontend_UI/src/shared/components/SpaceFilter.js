// 공간 거르기: '모두'는 따로 켜고 끄고, 개인·팀 중 하나는 목록에서 고른다.
// value: 'all' 또는 공간 id. spaces: [{ id, name }]
import React, { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Icon from './Icon';
import { SheetModal } from './Motion';
import { palette as c, styles as s } from '../../features/stella/theme';

export default function SpaceFilter({ value, onChange, spaces, style }) {
  const [open, setOpen] = useState(false);
  const last = useRef(spaces[0]?.id);   // '모두'를 끄면 돌아갈 공간 (마지막에 고른 것)
  if (value !== 'all') last.current = value;
  const one = spaces.find(w => w.id === last.current) ?? spaces[0];
  const all = value === 'all';
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 4 }, style]}>
    <Pressable accessibilityRole="switch" accessibilityLabel="모든 공간 보기" accessibilityState={{ checked: all }} onPress={() => onChange(all ? one?.id ?? 'all' : 'all')}
      style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 16, backgroundColor: all ? c.raised : 'transparent' }}>
      <Text style={{ fontSize: 14, color: all ? c.text : c.muted, fontWeight: all ? '600' : '400' }}>모두</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`공간 ${one?.name ?? ''}, 눌러서 고르기`} onPress={() => setOpen(true)}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, borderRadius: 16, maxWidth: 180, backgroundColor: all ? 'transparent' : c.raised }}>
      <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 14, color: all ? c.muted : c.text, fontWeight: all ? '400' : '600' }}>{one?.name ?? ''}</Text>
      <Icon name="chevronDown" size={12} color={c.muted} />
    </Pressable>
    <SheetModal visible={open} onClose={() => setOpen(false)} label="공간 고르기"><View style={s.handle} />
      <Text style={[s.sectionTitle, { textAlign: 'center', marginBottom: 8 }]}>공간</Text>
      {spaces.map(w => { const on = !all && w.id === value;
        return <Pressable key={w.id} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => { setOpen(false); onChange(w.id); }} style={s.menuRow}>
          <Text style={[s.menuLabel, { flex: 1 }]} numberOfLines={1}>{w.name}</Text>{on && <Icon name="check" size={16} color={c.text} />}
        </Pressable>; })}
    </SheetModal>
  </View>;
}
