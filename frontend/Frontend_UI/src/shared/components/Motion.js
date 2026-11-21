import React, {useEffect,useRef,useState} from 'react';
import {AccessibilityInfo,Animated,Easing,Modal,Platform,Pressable,StyleSheet,View} from 'react-native';
import {colors} from '../theme/theme';

export function useReducedMotion(){
  const [reduced,setReduced]=useState(()=>Platform.OS==='web'&&Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches));
  useEffect(()=>{let active=true;AccessibilityInfo.isReduceMotionEnabled().then(value=>{if(active)setReduced(value);},()=>{if(active)setReduced(true);});const subscription=AccessibilityInfo.addEventListener('reduceMotionChanged',setReduced);return()=>{active=false;subscription.remove();};},[]);
  return reduced;
}
export function ScreenMotion({children,style,active=true,transitionKey,direction='forward'}){
  const reduced=useReducedMotion(),progress=useRef(new Animated.Value(1)).current;
  useEffect(()=>{if(!active)return;progress.stopAnimation();if(reduced){progress.setValue(1);return;}progress.setValue(0);const motion=Animated.timing(progress,{toValue:1,duration:direction==='tab'?160:220,easing:Easing.out(Easing.cubic),useNativeDriver:Platform.OS!=='web'});motion.start();return()=>motion.stop();},[active,transitionKey,direction,reduced,progress]);
  return <Animated.View style={[style,{opacity:progress.interpolate({inputRange:[0,1],outputRange:[.6,1]}),transform:[{translateX:progress.interpolate({inputRange:[0,1],outputRange:[direction==='back'?-14:direction==='tab'?6:18,0]})}]}]}>{children}</Animated.View>;
}
export function SheetModal({visible,onClose,onClosed,label,children,style}){
  const reduced=useReducedMotion(),progress=useRef(new Animated.Value(0)).current;
  const [mounted,setMounted]=useState(visible);
  const closedCallback=useRef(onClosed); closedCallback.current=onClosed;
  useEffect(()=>{if(!mounted)closedCallback.current?.();},[mounted]);
  useEffect(()=>{if(visible)setMounted(true);const motion=Animated.timing(progress,{toValue:visible?1:0,duration:reduced?0:visible?220:160,easing:Easing.out(Easing.cubic),useNativeDriver:Platform.OS!=='web'});motion.start(({finished})=>{if(finished&&!visible)setMounted(false);});return()=>motion.stop();},[visible,reduced,progress]);
  return <Modal visible={mounted} transparent animationType="none" onRequestClose={onClose}><View style={styles.overlay}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${label} 바깥 영역 닫기`} onPress={onClose} style={StyleSheet.absoluteFill}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:'#000',opacity:progress.interpolate({inputRange:[0,1],outputRange:[0,.48]})}]}/>
    </Pressable>
    <Animated.View accessibilityViewIsModal accessibilityLabel={label} style={[styles.sheet,style,{opacity:progress,transform:[{translateY:progress.interpolate({inputRange:[0,1],outputRange:[32,0]})}]}]}>{children}</Animated.View>
  </View></Modal>;
}
const styles=StyleSheet.create({overlay:{flex:1,justifyContent:'flex-end'},sheet:{width:'100%',maxWidth:412,alignSelf:'center',backgroundColor:colors.card,borderTopLeftRadius:14,borderTopRightRadius:14,borderTopWidth:1,borderColor:colors.line,maxHeight:'86%',padding:20,paddingBottom:28}});
