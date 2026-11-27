import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { SheetModal } from '../../shared/components/Motion';
import Icon from '../../shared/components/Icon';
import { palette as c, styles as s } from './theme';
import { blockBreaks, insertBlock, moveBlock, splitBlock, tableRows, MAX_BLOCKS } from '../../../../../backend/local/src/document-blocks.mjs';

const TYPES = [['paragraph','텍스트','file'],['heading','제목','type'],['bullet','목록','list'],['task','체크리스트','checkSquare'],['table','표','grid']];
function InsertBoundary({label, open, drop}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={open}
    onHoverIn={() => setHover(true)} onHoverOut={() => setHover(false)}
    onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onPointerUp={drop}
    style={{height:16,justifyContent:'center',marginLeft:38}}>
    <View style={{height:2,backgroundColor:hover || focus ? c.accent : 'transparent'}}/>
  </Pressable>;
}
// Block bodies by type. To add a type, add it to TYPES and register a marker, text style or body here.
// Defined at module level so re-renders keep each TextInput mounted (and focused).
function TableBody({block,index,ctx}) {
  const {disabled,askAI,setActive,setTable}=ctx;
  return <ScrollView horizontal showsHorizontalScrollIndicator={false}><View>{block.rows.map((row,r)=><View key={r} style={{flexDirection:'row'}}>{row.map((cell,col)=><Pressable key={col} accessibilityRole="button" accessibilityLabel={`표 ${index+1}, ${r+1}행 ${col+1}열: ${cell||'빈 셀'}`} disabled={disabled} onLongPress={askAI&&(()=>askAI(index))} delayLongPress={450} onPress={()=>{setActive(block.id);setTable({block:{...block,rows:tableRows(block.rows)},new:false});}} style={{width:140,minHeight:44,borderWidth:1,borderColor:c.line,padding:10}}><Text style={{color:c.text,fontSize:14}}>{cell||' '}</Text></Pressable>)}</View>)}</View></ScrollView>;
}
const MARKERS = {
  task: ({block,index,ctx}) => <Pressable accessibilityRole="checkbox" accessibilityLabel={`블록 ${index+1} 할 일 완료`} accessibilityState={{checked:block.checked}} aria-checked={block.checked} disabled={ctx.disabled} onPress={()=>ctx.update(block.id,{checked:!block.checked})} style={{minWidth:28,minHeight:44,justifyContent:'center'}}><Icon name={block.checked?'checkSquare':'square'} size={19} color={c.muted}/></Pressable>,
  bullet: () => <Text style={{color:c.muted,lineHeight:30}}>•</Text>,
};
const TEXT_STYLES = { heading: {fontSize:24,fontWeight:'600',lineHeight:34,paddingVertical:5} };
const BODY_TEXT = {fontSize:16,fontWeight:'400',lineHeight:28,paddingVertical:8};
function TextBody({block,index,ctx}) {
  const {disabled,inputs,holdStart,holdEnd,setActive,changeText,skipSplit,closePicker}=ctx;
  const Marker=MARKERS[block.type];
  return <View style={{flexDirection:'row',gap:8,alignItems:'center'}}>
    {Marker?<Marker block={block} index={index} ctx={ctx}/>:null}
    <TextInput numberOfLines={1} rows={1} onContentSizeChange={event=>{const height=event.nativeEvent.contentSize?.height;if(height && Platform.OS!=='web')inputs.current.get(block.id)?.setNativeProps?.({style:{height:Math.max(44,height)}});}} ref={input=>{if(input)inputs.current.set(block.id,input);else inputs.current.delete(block.id);}} accessibilityLabel={`블록 ${index+1} 내용`} editable={!disabled} onPressIn={()=>holdStart(index)} onPressOut={holdEnd} onFocus={()=>setActive(block.id)} value={block.text} onChangeText={text=>changeText(block,text)} onKeyPress={event=>{if(event.nativeEvent.key==='Enter')skipSplit.current=!!(event.shiftKey||event.nativeEvent.shiftKey);if(event.nativeEvent.key==='Escape')closePicker();}} multiline scrollEnabled={false} placeholder={index===0?'내용을 입력하세요...':''} placeholderTextColor={c.subtle} style={{flex:1,padding:0,...(Platform.OS==='web'?{fieldSizing:'content'}:{}),minHeight:44,color:block.checked?c.muted:c.text,textDecorationLine:block.checked?'line-through':'none',...(TEXT_STYLES[block.type]??BODY_TEXT),textAlignVertical:'center'}}/>
  </View>;
}
const BODIES = { table: TableBody };
const NO_PENDING = new Set();
const BlockEditor = forwardRef(function BlockEditor({ blocks, onChange, disabled, onAskAI, pending = NO_PENDING, replacing = NO_PENDING, onDecide }, ref) {
  const [picker,setPicker] = useState(null), [active,setActive] = useState(null), [table,setTable] = useState(null), [error,setError] = useState(''), [drop,setDrop] = useState(null);
  const inputs=useRef(new Map()), dragging=useRef(null), skipSplit=useRef(false), dragMoved=useRef(false), holdTimer=useRef(null);
  const askAI=disabled||!onAskAI?undefined:index=>{clearTimeout(holdTimer.current);dragging.current=null;setDrop(null);onAskAI(blocks[index],index);};
  // A TextInput has no onLongPress: hold ~450 ms without typing or lifting the finger.
  function holdStart(index){if(!askAI)return;clearTimeout(holdTimer.current);holdTimer.current=setTimeout(()=>askAI(index),450);}
  function holdEnd(){clearTimeout(holdTimer.current);}
  useEffect(()=>holdEnd,[]);
  const pendingFocus=useRef(null);
  function focusPending(){const input=inputs.current.get(pendingFocus.current);if(input){input.focus();pendingFocus.current=null;}}
  useEffect(()=>{if(!picker&&!table)focusPending();},[blocks]);
  const selected=blocks.find(block=>block.id===active) ?? blocks[0];
  useImperativeHandle(ref,()=>({add:()=>{if(!disabled)setPicker({new:true,after:selected?.id});},format:()=>{if(!disabled&&selected)setPicker({id:selected.id});}}),[disabled,selected]);
  function commit(next){if(disabled||JSON.stringify(next)===JSON.stringify(blocks))return;try{onChange(next);setError('');}catch(e){setError(e.message);}}
  function update(id,patch){commit(blocks.map(block=>block.id===id?{...block,...patch}:block));}
  function closePicker(){setPicker(null);}
  function changeText(block,text){
    holdEnd();
    if(disabled)return;
    if(text==='/'){update(block.id,{text});setPicker({id:block.id});return;}
    const parts=skipSplit.current?null:blockBreaks(block.text,text);
    skipSplit.current=false;
    try{if(parts){const next=splitBlock(blocks,block.id,text,randomUUID,parts);pendingFocus.current=next[blocks.findIndex(item=>item.id===block.id)+1]?.id;commit(next);}else update(block.id,{text});}catch(e){setError(e.message);}
  }
  function choose(type){
    if(disabled||!picker)return;
    const existing=blocks.find(block=>block.id===picker.id);
    const block=existing?{...existing,type,text:existing.text==='/'?'':existing.text}:{id:randomUUID(),type,text:'',checked:false};
    if(type==='table'){
      const rows=existing?.type==='table'?existing.rows:[[block.text,''],['','']];
      setTable({block:{...block,text:'',checked:false,rows:tableRows(rows)},new:picker.new,after:picker.after,first:picker.first});closePicker();return;
    }
    if(existing?.type==='table')block.text=existing.rows.map(row=>row.join('\t')).join('\n');
    delete block.rows;
    try{commit(picker.new?insertBlock(blocks,picker.after,block,picker.first):blocks.map(item=>item.id===block.id?block:item));pendingFocus.current=block.id;setActive(block.id);closePicker();}catch(e){setError(e.message);}
  }
  function move(direction,id=picker?.id){
    const index=blocks.findIndex(block=>block.id===id), target=index+direction;
    if(disabled||index<0||target<0||target>=blocks.length)return;
    const before=direction<0?blocks[target].id:blocks[target+1]?.id??null;
    commit(moveBlock(blocks,blocks[index].id,before));closePicker();
  }
  function duplicate(){const block=blocks.find(item=>item.id===picker?.id);if(!block)return;try{commit(insertBlock(blocks,block.id,{...block,id:randomUUID(),...(block.rows?{rows:tableRows(block.rows)}:{})}));closePicker();}catch(e){setError(e.message);}}
  function deleteSelected(){if(disabled||blocks.length===1)return;commit(blocks.filter(block=>block.id!==picker.id));closePicker();}
  function dropBlock(before){if(disabled||!dragging.current)return;const id=dragging.current;dragging.current=null;setDrop(null);commit(moveBlock(blocks,id,before));}
  function resizeTable(rows){try{setTable({...table,block:{...table.block,rows:tableRows(rows)}});setError('');}catch(e){setError(e.message);}}
  function saveTable(){try{const block={...table.block,rows:tableRows(table.block.rows)};commit(table.new?insertBlock(blocks,table.after,block,table.first):blocks.map(item=>item.id===block.id?block:item));setActive(block.id);setTable(null);}catch(e){setError(e.message);}}
  const ctx={disabled,askAI,setActive,setTable,update,inputs,holdStart,holdEnd,changeText,skipSplit,closePicker};
  const action=(label,icon,onPress,inactive=false)=><Pressable key={label} accessibilityRole="button" accessibilityLabel={label} disabled={disabled||inactive} onPress={onPress} style={[s.menuRow,(disabled||inactive)&&{opacity:.35}]}><Icon name={icon} size={18} color={c.muted}/><Text style={s.menuLabel}>{label}</Text></Pressable>;
  return <View style={{paddingTop:4,minHeight:280}} onPointerCancel={()=>{dragging.current=null;setDrop(null);}}>
    {error?<Text accessibilityRole="alert" style={s.error}>{error}</Text>:null}
    {!disabled && blocks.length < MAX_BLOCKS && <InsertBoundary label="첫 블록 앞에 삽입" open={()=>setPicker({new:true,first:true})} drop={()=>dropBlock(blocks[0]?.id)}/>}
    {blocks.map((block,index)=><View key={block.id} onPointerEnter={()=>{if(dragging.current){dragMoved.current ||= dragging.current!==block.id;setDrop(block.id);}}} onPointerUp={()=>dropBlock(block.id)} style={[{borderTopWidth:drop===block.id?2:0,borderTopColor:c.accent,marginBottom:0},pending.has(block.id)&&{backgroundColor:c.raised,borderLeftWidth:2,borderLeftColor:c.accent,borderRadius:4}]}>
      <View style={{flexDirection:'row',gap:6,alignItems:'center'}}>
        {!disabled&&block.id!==active&&<View style={{width:32}} />}
        {!disabled&&block.id===active&&<Pressable accessibilityRole="button" accessibilityLabel={`블록 ${index+1} 메뉴와 끌어서 옮기기`} accessibilityHint={askAI?'길게 누르면 이 블록으로 AI에게 요청합니다':undefined} onLongPress={askAI&&(()=>askAI(index))} delayLongPress={450} onPress={()=>{if(dragMoved.current){dragMoved.current=false;return;}setActive(block.id);setPicker({id:block.id});}} onPointerDown={event=>{if(Platform.OS==='web'&&event.nativeEvent?.button!==2){dragMoved.current=false;dragging.current=block.id;setActive(block.id);}}} onKeyDown={event=>{if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();move(event.key==='ArrowUp'?-1:1,block.id);}}} style={{width:32,minHeight:44,alignItems:'center',justifyContent:'center'}}><Text style={{color:c.muted,fontSize:22}}>⠿</Text></Pressable>}
        <View style={{flex:1,minWidth:0}}>
          {React.createElement(BODIES[block.type]??TextBody,{block,index,ctx})}
        </View>
      </View>
      {pending.has(block.id)&&<View style={{flexDirection:'row',alignItems:'center',gap:4,marginLeft:38}}><Text style={[s.meta,{color:c.accent,flex:1}]}>{replacing?.has(block.id)?'AI 제안: 수용하면 원래 블록을 대체':'AI 제안'}</Text>{[['수용',true],['거절',false]].map(([label,accept])=><Pressable key={label} accessibilityRole="button" accessibilityLabel={`블록 ${index+1} AI 제안 ${label}`} disabled={disabled} onPress={()=>onDecide?.([block.id],accept)} style={{minHeight:44,minWidth:44,justifyContent:'center',paddingHorizontal:8,opacity:disabled?.4:1}}><Text style={s.linkText}>{label}</Text></Pressable>)}</View>}
      {!disabled && blocks.length < MAX_BLOCKS && <InsertBoundary label={`블록 ${index+1} 뒤에 삽입`} open={()=>setPicker({new:true,after:block.id})} drop={()=>dropBlock(blocks[index+1]?.id??null)}/>}
    </View>)}
    <SheetModal visible={!!picker} onClosed={focusPending} onClose={closePicker} label="블록 형식"><View style={s.handle}/><View style={s.titleRow}><Text style={s.sectionTitle}>{picker?.new?'블록 추가':'블록 설정'}</Text><Pressable accessibilityRole="button" accessibilityLabel="블록 형식 닫기" onPress={closePicker} style={s.iconButton}><Icon name="x" size={20} color={c.muted}/></Pressable></View><ScrollView keyboardShouldPersistTaps="handled"><View style={s.blockTypeGrid}>{TYPES.map(([type,label,icon])=><Pressable key={type} accessibilityRole="button" accessibilityLabel={`${label} 블록${picker?.new?' 추가':'으로 변경'}`} disabled={disabled} onPress={()=>choose(type)} style={s.blockTypeOption}><Icon name={icon} size={19} color={c.muted}/><Text style={s.rowTitle}>{label}</Text></Pressable>)}</View>{picker&&!picker.new&&<>{askAI&&action('AI에게 요청','sparkles',()=>{const index=blocks.findIndex(block=>block.id===picker.id);closePicker();if(index>=0)askAI(index);})}{action('블록 위로 이동','chevronUp',()=>move(-1),blocks[0]?.id===picker.id)}{action('블록 아래로 이동','chevronDown',()=>move(1),blocks.at(-1)?.id===picker.id)}{action('블록 복제','copy',duplicate,blocks.length>=MAX_BLOCKS)}{action('블록 삭제','trash',deleteSelected,blocks.length===1)}</>}</ScrollView></SheetModal>
    <SheetModal visible={!!table} onClose={()=>setTable(null)} label="표 변경 검토"><View style={s.titleRow}><Text style={s.sectionTitle}>표 편집</Text><Pressable accessibilityRole="button" accessibilityLabel="표 편집 취소" onPress={()=>setTable(null)} style={s.iconButton}><Icon name="x" size={20} color={c.muted}/></Pressable></View><Text style={s.note}>확인 후 적용하기 전에는 원문이 바뀌지 않습니다.</Text>{error?<Text accessibilityRole="alert" style={s.error}>{error}</Text>:null}{table&&<ScrollView keyboardShouldPersistTaps="handled"><ScrollView horizontal keyboardShouldPersistTaps="handled"><View>{table.block.rows.map((row,r)=><View key={r} style={{flexDirection:'row'}}>{row.map((cell,col)=><TextInput key={col} accessibilityLabel={`표 편집 ${r+1}행 ${col+1}열`} value={cell} multiline onChangeText={text=>resizeTable(table.block.rows.map((line,i)=>line.map((value,j)=>i===r&&j===col?text:value)))} style={{width:140,minHeight:44,borderWidth:1,borderColor:c.line,padding:10,color:c.text,fontSize:16}}/>)}</View>)}</View></ScrollView><View style={{flexDirection:'row',flexWrap:'wrap',gap:12}}>{action('행 추가','plus',()=>resizeTable([...table.block.rows,Array(table.block.rows[0].length).fill('')]),table.block.rows.length>=50)}{action('열 추가','plus',()=>resizeTable(table.block.rows.map(row=>[...row,''])),table.block.rows[0].length>=20)}{action('마지막 행 삭제','minus',()=>resizeTable(table.block.rows.slice(0,-1)),table.block.rows.length===1)}{action('마지막 열 삭제','minus',()=>resizeTable(table.block.rows.map(row=>row.slice(0,-1))),table.block.rows[0].length===1)}</View><Pressable accessibilityRole="button" onPress={saveTable} style={s.primary}><Text style={s.primaryText}>확인 후 적용</Text></Pressable></ScrollView>}</SheetModal>
  </View>;
});
export default BlockEditor;
