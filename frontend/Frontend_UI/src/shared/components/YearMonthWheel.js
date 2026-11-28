// ============================================================
// YearMonthWheel.js — 연도 · 월 2열 네이티브 드라이버 스크롤 휠 선택기
// ============================================================
//   왼쪽: 연도(1900~2100, 경계 있음)
//   오른쪽: 월(1~12월, 21사이클 무한 순환 루프)
//   Animated.event(useNativeDriver)로 스크롤 중 리렌더 없이 60/120fps 보간,
//   Android 자연 관성(OverScroller) 유지 + 정지 시 중앙 스냅 보정

import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme/theme';

const ITEM_H = 44;
const VISIBLE = 5;
const WHEEL_H = ITEM_H * VISIBLE;
const PAD_Y = ITEM_H * 2;
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const YEARS = Array.from({ length: MAX_YEAR - MIN_YEAR + 1 }, (_, i) => MIN_YEAR + i);
const MONTH_CYCLES = 21;
const MONTH_MID = Math.floor(MONTH_CYCLES / 2) * 12; // 120
const MONTH_LOOP = Array.from({ length: MONTH_CYCLES * 12 }, (_, i) => i % 12);
const USE_NATIVE_DRIVER = Platform.OS !== 'web';
const AnimatedFlatList = Animated.createAnimatedComponent(FlatList);

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

const WheelItem = memo(function WheelItem({ index, label, accessibilityLabel, isSelected, scrollY, onPress }) {
  const center = index * ITEM_H;
  const inputRange = [center - ITEM_H * 2, center - ITEM_H, center, center + ITEM_H, center + ITEM_H * 2];
  const opacity = scrollY.interpolate({
    inputRange,
    outputRange: [0.2, 0.48, 1, 0.48, 0.2],
    extrapolate: 'clamp',
  });
  const scale = scrollY.interpolate({
    inputRange,
    outputRange: [0.82, 0.91, 1, 0.91, 0.82],
    extrapolate: 'clamp',
  });

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ selected: isSelected }}
      onPress={() => onPress(index)}
      style={styles.item}
    >
      <Animated.Text style={[styles.itemText, { opacity, transform: [{ scale }] }]}>
        {label}
      </Animated.Text>
    </Pressable>
  );
});

function WheelColumn({
  data,
  initialRaw,
  value,
  jumpVersion = 0,
  toRaw,
  format,
  itemLabel,
  onChangeValue,
  loop = false,
  accessibilityLabel,
}) {
  const listRef = useRef(null);
  const scrollY = useRef(new Animated.Value(initialRaw * ITEM_H)).current;
  const isInteracting = useRef(false);
  const momentumStarted = useRef(false);
  const programmaticTarget = useRef(null);
  const snapTimer = useRef(null);
  const progTimer = useRef(null);
  const currentRaw = useRef(initialRaw);
  const lastEmitted = useRef(value);
  const lastJumpVersion = useRef(jumpVersion);
  const onChangeRef = useRef(onChangeValue);
  onChangeRef.current = onChangeValue;
  const [settledRaw, setSettledRaw] = useState(initialRaw);

  const clearTimers = useCallback(() => {
    if (snapTimer.current) {
      clearTimeout(snapTimer.current);
      snapTimer.current = null;
    }
    if (progTimer.current) {
      clearTimeout(progTimer.current);
      progTimer.current = null;
    }
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const scrollToOffset = useCallback((offset, animated) => {
    const node = listRef.current;
    if (!node) return;
    if (typeof node.scrollToOffset === 'function') {
      node.scrollToOffset({ offset, animated });
    } else if (typeof node.getNode === 'function') {
      node.getNode().scrollToOffset({ offset, animated });
    }
  }, []);

  const scrollToTarget = useCallback((target, animated = true) => {
    clearTimers();
    currentRaw.current = target;
    setSettledRaw(target);
    const offset = target * ITEM_H;
    if (!animated) {
      programmaticTarget.current = null;
      scrollToOffset(offset, false);
      scrollY.setValue(offset);
      return;
    }
    programmaticTarget.current = target;
    scrollToOffset(offset, true);
    progTimer.current = setTimeout(() => {
      progTimer.current = null;
      if (programmaticTarget.current === target) {
        programmaticTarget.current = null;
        scrollToOffset(offset, false);
        scrollY.setValue(offset);
      }
    }, 420);
  }, [clearTimers, scrollToOffset, scrollY]);

  useEffect(() => {
    const forcedJump = jumpVersion !== lastJumpVersion.current;
    lastJumpVersion.current = jumpVersion;
    if (forcedJump) {
      isInteracting.current = false;
      momentumStarted.current = false;
    }
    if (!forcedJump && (isInteracting.current || value === lastEmitted.current)) return;
    lastEmitted.current = value;
    const target = toRaw(value);
    if (target === currentRaw.current && !forcedJump) return;
    scrollToTarget(target, true);
  }, [value, jumpVersion, toRaw, scrollToTarget]);

  const settleAt = useCallback((offsetY) => {
    isInteracting.current = false;
    momentumStarted.current = false;
    if (programmaticTarget.current !== null) return;
    let next = clamp(Math.round(offsetY / ITEM_H), 0, data.length - 1);
    const val = data[next];
    if (val !== lastEmitted.current) {
      lastEmitted.current = val;
      onChangeRef.current(val);
    }
    if (loop && (next < 36 || next >= data.length - 36)) {
      next = MONTH_MID + val;
      scrollToTarget(next, false);
      return;
    }
    currentRaw.current = next;
    setSettledRaw(next);
    if (Math.abs(offsetY - next * ITEM_H) >= 1) {
      scrollToTarget(next, true);
    }
  }, [data, loop, scrollToTarget]);

  const handleScrollListener = useCallback((e) => {
    const offsetY = e.nativeEvent.contentOffset.y;
    if (programmaticTarget.current !== null) {
      if (Math.abs(offsetY - programmaticTarget.current * ITEM_H) < 1.5) {
        programmaticTarget.current = null;
        if (progTimer.current) {
          clearTimeout(progTimer.current);
          progTimer.current = null;
        }
      }
      return;
    }
    const next = clamp(Math.round(offsetY / ITEM_H), 0, data.length - 1);
    if (next !== currentRaw.current) {
      currentRaw.current = next;
      const val = data[next];
      if (val !== lastEmitted.current) {
        lastEmitted.current = val;
        onChangeRef.current(val);
      }
    }
    if (Platform.OS === 'web' && !isInteracting.current) {
      if (snapTimer.current) clearTimeout(snapTimer.current);
      snapTimer.current = setTimeout(() => {
        snapTimer.current = null;
        settleAt(offsetY);
      }, 120);
    }
  }, [data, settleAt]);

  const handleScrollRef = useRef(handleScrollListener);
  handleScrollRef.current = handleScrollListener;
  const onScroll = useRef(null);
  if (!onScroll.current) {
    onScroll.current = Animated.event(
      [{ nativeEvent: { contentOffset: { y: scrollY } } }],
      { useNativeDriver: USE_NATIVE_DRIVER, listener: (e) => handleScrollRef.current(e) },
    );
  }

  const handlePressItem = useCallback((index) => {
    isInteracting.current = false;
    momentumStarted.current = false;
    const item = data[index];
    if (item !== lastEmitted.current) {
      lastEmitted.current = item;
      onChangeRef.current(item);
    }
    scrollToTarget(index, true);
  }, [data, scrollToTarget]);

  const getItemLayout = useCallback((_, index) => ({ length: ITEM_H, offset: ITEM_H * index, index }), []);
  const keyExtractor = useCallback((_, index) => String(index), []);

  const renderItem = useCallback(({ item, index }) => (
    <WheelItem
      index={index}
      label={format(item)}
      accessibilityLabel={itemLabel(item)}
      isSelected={index === settledRaw}
      scrollY={scrollY}
      onPress={handlePressItem}
    />
  ), [format, itemLabel, settledRaw, scrollY, handlePressItem]);

  return (
    <AnimatedFlatList
      ref={listRef}
      data={data}
      extraData={settledRaw}
      keyExtractor={keyExtractor}
      accessibilityLabel={accessibilityLabel}
      style={styles.column}
      contentContainerStyle={styles.columnContent}
      showsVerticalScrollIndicator={false}
      bounces={false}
      overScrollMode="never"
      snapToInterval={Platform.OS === 'ios' ? ITEM_H : undefined}
      snapToAlignment={Platform.OS === 'ios' ? 'start' : undefined}
      decelerationRate={Platform.OS === 'ios' ? 'fast' : 'normal'}
      initialScrollIndex={initialRaw}
      getItemLayout={getItemLayout}
      removeClippedSubviews={false}
      windowSize={9}
      initialNumToRender={15}
      maxToRenderPerBatch={15}
      scrollEventThrottle={16}
      onScrollBeginDrag={() => {
        clearTimers();
        programmaticTarget.current = null;
        isInteracting.current = true;
        momentumStarted.current = false;
      }}
      onMomentumScrollBegin={() => {
        if (snapTimer.current) {
          clearTimeout(snapTimer.current);
          snapTimer.current = null;
        }
        isInteracting.current = true;
        momentumStarted.current = true;
      }}
      onScroll={onScroll.current}
      onScrollEndDrag={(e) => {
        const y = e.nativeEvent.contentOffset.y;
        const vy = Math.abs(e.nativeEvent.velocity?.y ?? 0);
        if (snapTimer.current) clearTimeout(snapTimer.current);
        snapTimer.current = setTimeout(() => {
          snapTimer.current = null;
          if (!momentumStarted.current) settleAt(y);
        }, vy > 0.15 ? 160 : 80);
      }}
      onMomentumScrollEnd={(e) => {
        if (snapTimer.current) {
          clearTimeout(snapTimer.current);
          snapTimer.current = null;
        }
        settleAt(e.nativeEvent.contentOffset.y);
      }}
      onScrollToIndexFailed={({ index }) => {
        setTimeout(() => {
          const offset = index * ITEM_H;
          scrollToOffset(offset, false);
          scrollY.setValue(offset);
        }, 20);
      }}
      renderItem={renderItem}
    />
  );
}

const yearToRaw = (y) => clamp(y - MIN_YEAR, 0, YEARS.length - 1);
const monthToRaw = (m) => MONTH_MID + clamp(m, 0, 11);
const formatYear = (y) => `${y}년`;
const formatMonth = (m) => `${m + 1}월`;

export default function YearMonthWheel({ year, month, jumpVersion = 0, onChangeYear, onChangeMonth }) {
  const initialYearRaw = useRef(yearToRaw(year)).current;
  const initialMonthRaw = useRef(monthToRaw(month)).current;

  return (
    <View style={styles.wrap}>
      <View style={styles.labels}>
        <Text style={styles.colLabel}>연도</Text>
        <Text style={styles.colLabel}>월</Text>
      </View>
      <View style={styles.wheelBox}>
        <View pointerEvents="none" style={styles.centerBand} />
        <WheelColumn
          data={YEARS}
          initialRaw={initialYearRaw}
          value={year}
          jumpVersion={jumpVersion}
          toRaw={yearToRaw}
          format={formatYear}
          itemLabel={formatYear}
          accessibilityLabel="연도 스크롤 선택"
          onChangeValue={onChangeYear}
        />
        <View style={styles.colGap} />
        <WheelColumn
          data={MONTH_LOOP}
          initialRaw={initialMonthRaw}
          value={month}
          jumpVersion={jumpVersion}
          toRaw={monthToRaw}
          loop
          format={formatMonth}
          itemLabel={formatMonth}
          accessibilityLabel="월 스크롤 선택"
          onChangeValue={onChangeMonth}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  labels: { flexDirection: 'row', paddingHorizontal: 4, paddingBottom: 4 },
  colLabel: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '500', letterSpacing: 0.4, color: colors.subtle },
  wheelBox: { position: 'relative', height: WHEEL_H, flexDirection: 'row', overflow: 'hidden' },
  centerBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: PAD_Y,
    height: ITEM_H,
    borderRadius: radius.md,
    backgroundColor: colors.raised,
  },
  column: { flex: 1, height: WHEEL_H },
  columnContent: { paddingTop: PAD_Y, paddingBottom: PAD_Y },
  colGap: { width: 12 },
  item: { height: ITEM_H, alignItems: 'center', justifyContent: 'center' },
  itemText: { fontSize: 17, fontWeight: '500', color: colors.ink, fontVariant: ['tabular-nums'] },
});
