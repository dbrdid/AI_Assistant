import React, {useEffect,useRef,useState} from 'react';
import {Animated,Easing,Modal,PanResponder,Platform,Pressable,StyleSheet,View} from 'react-native';
import {colors} from '../theme/theme';
import {useInsets} from '../hooks/useInsets';
import {useKeyboardHeight} from '../hooks/useKeyboardHeight';
export function ScreenMotion({children, style, transitionKey, slideFrom = 8}) {

  const progress = useRef(new Animated.Value(1)).current;
  const screen = useRef(null);
  const isTab = typeof slideFrom === 'string';

  const tabDuration = 260;

  React.useLayoutEffect(() => {
    if (!slideFrom) {
      progress.setValue(1);
      return;
    }
    if (isTab && Platform.OS === 'web' && screen.current?.animate) {
      const animation = screen.current.animate(
        [{ transform: `translateX(${slideFrom})` }, { transform: 'translateX(0%)' }],
        { duration: tabDuration, easing: 'ease-out' },
      );
      return () => animation.cancel();
    }
    progress.setValue(0);
    const motion = Animated.timing(progress, {
      toValue: 1,
      duration: isTab ? tabDuration : 160,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    motion.start();
    return () => motion.stop();
  }, [transitionKey, progress, slideFrom, isTab]);

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [slideFrom, isTab ? '0%' : 0] });
  return <Animated.View ref={screen} style={[style, {transform: [{translateX}]}]}>{children}</Animated.View>;
}
// 시트 위쪽 손잡이를 아래로 끌어 닫기: { drag(시트에 더할 이동값), strip(손잡이 자리의 투명 끌기 영역) }
const native=Platform.OS!=='web';
export function useDragClose(onClose){
  const drag=useRef(new Animated.Value(0)).current;
  const close=useRef(onClose); close.current=onClose;
  const pan=useRef(PanResponder.create({
    onStartShouldSetPanResponder:()=>true,
    onMoveShouldSetPanResponder:(_,g)=>Math.abs(g.dy)>2,
    onPanResponderMove:(_,g)=>drag.setValue(Math.max(0,g.dy)),
    onPanResponderRelease:(_,g)=>{
      if(g.dy>80||g.vy>0.8){close.current?.();setTimeout(()=>drag.setValue(0),300);}
      else Animated.spring(drag,{toValue:0,bounciness:0,useNativeDriver:native}).start();
    },
  })).current;
  const strip=<View {...pan.panHandlers} accessible={false} style={{position:'absolute',top:0,left:0,right:0,height:28,zIndex:5}}/>;
  return {drag,strip};
}
export function SheetModal({visible,onClose,onClosed,label,children,style}){
  const {drag,strip}=useDragClose(onClose);
  const progress=useRef(new Animated.Value(0)).current;
  const [mounted,setMounted]=useState(visible);
  const closedCallback=useRef(onClosed); closedCallback.current=onClosed;
  // 하단 시스템 탐색 막대에 마지막 항목이 가리지 않도록 그 높이만큼 아래 여백을 더한다.
  const insets=useInsets();
  const keyboard=useKeyboardHeight(); // 입력칸이 있는 시트는 키보드 위로
  useEffect(()=>{if(!mounted)closedCallback.current?.();},[mounted]);
  useEffect(()=>{if(visible)setMounted(true);const motion=Animated.timing(progress,{toValue:visible?1:0,duration:visible?220:160,easing:Easing.out(Easing.cubic),useNativeDriver:Platform.OS!=='web'});motion.start(({finished})=>{if(finished&&!visible)setMounted(false);});return()=>motion.stop();},[visible,progress]);
  return <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose}><View style={styles.overlay}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} 바깥 영역 닫기`} onPress={onClose} style={StyleSheet.absoluteFill}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:'#000',opacity:progress.interpolate({inputRange:[0,1],outputRange:[0,.48]})}]}/>
    </Pressable>
    <Animated.View accessibilityViewIsModal accessibilityLabel={label} style={[styles.sheet,{paddingBottom:28+insets.bottom+keyboard},style,{opacity:progress,transform:[{translateY:Animated.add(progress.interpolate({inputRange:[0,1],outputRange:[32,0]}),drag)}]}]}>{children}{strip}</Animated.View>
  </View></Modal>;
}
const styles=StyleSheet.create({overlay:{flex:1,justifyContent:'flex-end'},sheet:{width:'100%',maxWidth:412,alignSelf:'center',backgroundColor:colors.card,borderTopLeftRadius:14,borderTopRightRadius:14,borderTopWidth:1,borderColor:colors.line,maxHeight:'86%',padding:20,paddingBottom:28}});
