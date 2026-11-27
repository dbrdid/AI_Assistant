import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Icon from '../../../shared/components/Icon';
import { colors } from '../../../shared/theme/theme';

export default function ScheduleRow({ item, details, onPress, onLongPress, selected, overdue, style }) {
  const isEvent = item.kind === 'event';
  const time = item.start ? [item.start, item.end].filter(Boolean).join('–') : isEvent ? '종일' : null;
  const metadata = [time, ...details].filter(Boolean).join(', ');
  const done = item.status === '완료';
  const metadataColor = overdue ? colors.coral : colors.muted;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected === undefined ? undefined : { selected }}
      accessibilityLabel={[`${item.title} ${isEvent ? '일정' : '할 일'}`, metadata].filter(Boolean).join(', ')}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={[styles.row, style]}
    >
      <Text style={[styles.title, done && styles.done]} numberOfLines={1}>{item.title}</Text>
      {metadata ? (
        <View style={styles.metaRow}>
          <Icon name={isEvent ? (item.place ? 'pin' : 'calendar') : 'checkCircle'} size={14} color={metadataColor} />
          <Text style={[styles.meta, { color: metadataColor }]} numberOfLines={1}>{metadata}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { justifyContent: 'center', gap: 3, minHeight: 44, minWidth: 0 },
  title: { fontSize: 15, fontWeight: '500', color: colors.ink },
  done: { color: colors.muted, textDecorationLine: 'line-through' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  meta: { flex: 1, fontSize: 13 },
});
