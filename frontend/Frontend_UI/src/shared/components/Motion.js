import React, {useEffect,useRef,useState} from 'react';
import {Animated,Easing,Modal,Platform,Pressable,StyleSheet,View} from 'react-native';
import {colors} from '../theme/theme';
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
export function SheetModal({visible,onClose,onClosed,label,children,style}){
  const progress=useRef(new Animated.Value(0)).current;
  const [mounted,setMounted]=useState(visible);
  const closedCallback=useRef(onClosed); closedCallback.current=onClosed;
  useEffect(()=>{if(!mounted)closedCallback.current?.();},[mounted]);
  useEffect(()=>{if(visible)setMounted(true);const motion=Animated.timing(progress,{toValue:visible?1:0,duration:visible?220:160,easing:Easing.out(Easing.cubic),useNativeDriver:Platform.OS!=='web'});motion.start(({finished})=>{if(finished&&!visible)setMounted(false);});return()=>motion.stop();},[visible,progress]);
  return <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose}><View style={styles.overlay}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} 바깥 영역 닫기`} onPress={onClose} style={StyleSheet.absoluteFill}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:'#000',opacity:progress.interpolate({inputRange:[0,1],outputRange:[0,.48]})}]}/>
    </Pressable>
    <Animated.View accessibilityViewIsModal accessibilityLabel={label} style={[styles.sheet,style,{opacity:progress,transform:[{translateY:progress.interpolate({inputRange:[0,1],outputRange:[32,0]})}]}]}>{children}</Animated.View>
  </View></Modal>;
}
const styles=StyleSheet.create({overlay:{flex:1,justifyContent:'flex-end'},sheet:{width:'100%',maxWidth:412,alignSelf:'center',backgroundColor:colors.card,borderTopLeftRadius:14,borderTopRightRadius:14,borderTopWidth:1,borderColor:colors.line,maxHeight:'86%',padding:20,paddingBottom:28}});
