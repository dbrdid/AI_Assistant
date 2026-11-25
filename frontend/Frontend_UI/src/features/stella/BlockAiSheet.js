// 문서 아래에서 반쯤 올라오는 블록 AI 시트. 문서는 위에 그대로 보이고, 답은 바로 문서에 AI 제안으로 들어가
// 사용자가 문서에서 보며 수용하거나 거절한다. 손잡이를 아래로 끌거나 뒤로 가기, X로 닫는다.
import React, { useEffect, useRef } from 'react';
import { Animated, BackHandler, PanResponder, Pressable, Text, View, useWindowDimensions } from 'react-native';
import Icon from '../../shared/components/Icon';
import LocalModelScreen from './LocalModelScreen';
import { palette as c, styles as s } from './theme';

export default function BlockAiSheet({ block, navigation, memoId, prepare, onPlaced, onClose }) {
  const { height } = useWindowDimensions();
  const sheetHeight = Math.round(height * 0.45);
  const y = useRef(new Animated.Value(sheetHeight)).current;
  const closing = useRef(false);
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    Animated.timing(y, { toValue: sheetHeight, duration: 180, useNativeDriver: true }).start(() => onClose());
  };
  useEffect(() => {
    Animated.timing(y, { toValue: 0, duration: 220, useNativeDriver: true }).start();
    const back = BackHandler.addEventListener('hardwareBackPress', () => { close(); return true; });
    return () => back.remove();
  }, []);
  const pan = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dy) > 4 && Math.abs(g.dy) > Math.abs(g.dx),
    onPanResponderMove: (_, g) => y.setValue(Math.max(0, g.dy)),
    onPanResponderRelease: (_, g) => (g.dy > 80 || g.vy > 0.8 ? close() : Animated.spring(y, { toValue: 0, bounciness: 0, useNativeDriver: true }).start()),
  })).current;

  return <Animated.View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: sheetHeight, backgroundColor: c.surface,
    borderTopLeftRadius: 12, borderTopRightRadius: 12, borderTopWidth: 1, borderColor: c.line, transform: [{ translateY: y }] }}>
    <View {...pan.panHandlers}>
      <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 2 }}><View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: c.subtle }} /></View>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 8, minHeight: 44 }}>
        <Icon name="sparkles" size={16} color={c.muted} />
        <Text numberOfLines={1} style={[s.meta, { flex: 1, marginLeft: 8 }]}>{block.index + 1}번 블록에 AI 요청. 답은 문서에 제안으로 들어가요</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="AI 요청 닫기" onPress={close} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="x" size={18} color={c.muted} />
        </Pressable>
      </View>
    </View>
    <LocalModelScreen navigation={navigation} route={{ params: { memoId, block } }} sheet={{ prepare, onPlaced, onClose: close }} />
  </Animated.View>;
}
