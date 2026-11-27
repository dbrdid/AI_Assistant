// 공간 고르기: 모든 공간 · 개인 · 팀을 한 목록에서 고른다. value: 'all' 또는 공간 id. spaces: [{ id, name }]
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Icon from './Icon';
import { SheetModal } from './Motion';
import { palette as c, styles as s } from '../../features/stella/theme';

export default function SpaceFilter({ value, onChange, spaces, style }) {
  const [open, setOpen] = useState(false);
  const options = [{ id: 'all', name: '모든 공간' }, ...spaces];
  const current = options.find(o => o.id === value) ?? options[0];
  return <View style={[{ flexDirection: 'row', alignItems: 'center' }, style]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`공간 ${current.name}, 눌러서 고르기`} onPress={() => setOpen(true)}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 200 }}>
      <Text numberOfLines={1} style={[s.filterText, s.filterTextOn, { flexShrink: 1 }]}>{current.name}</Text>
      <Icon name="chevronDown" size={12} color={c.muted} />
    </Pressable>
    <SheetModal visible={open} onClose={() => setOpen(false)} label="공간 고르기"><View style={s.handle} />
      <Text style={[s.sectionTitle, { textAlign: 'center', marginBottom: 8 }]}>공간</Text>
      {options.map(o => { const on = o.id === current.id;
        return <Pressable key={o.id} accessibilityRole="radio" accessibilityState={{ checked: on }} onPress={() => { setOpen(false); onChange(o.id); }} style={s.menuRow}>
          <Text style={[s.menuLabel, { flex: 1 }, on && { fontWeight: '700' }]} numberOfLines={1}>{o.name}</Text>
        </Pressable>; })}
    </SheetModal>
  </View>;
}
