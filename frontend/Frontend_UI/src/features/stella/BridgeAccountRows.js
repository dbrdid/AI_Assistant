// 내 서버 → 같은 계정에 로그인된 PC 브리지 (atria-bridge login). 연결 문자열 없이 고르면 중계로 연결된다.
// PC에 뜬 코드를 여기서 승인하면 그 PC 브리지가 이 계정에 등록된다. 브리지가 하나뿐이면 자동으로 고른다.
import React, { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Icon from '../../shared/components/Icon';
import { accountBridgeId, accountBridgeUrl } from '../../integration/aiGateway.mjs';
import { approveBridgeLogin, myBridges, revokeBridge } from '../../integration/bridgeRelayApp';
import { palette as c, styles as s } from './theme';

const ago = iso => {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return !iso ? '아직 켜진 적 없음' : min < 6 ? '켜져 있음' : min < 60 ? `${min}분 전` : min < 1440 ? `${Math.round(min / 60)}시간 전` : `${Math.round(min / 1440)}일 전`;
};

export default function BridgeAccountRows({ serverUrl, onUse, onClear, disabled }) {
  const [bridges, setBridges] = useState(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = accountBridgeId(serverUrl);
  const load = async (auto = false) => {
    try {
      const list = await myBridges();
      setBridges(list);
      if (auto && !serverUrl && list.length === 1) onUse(list[0]);   // 같은 계정의 PC 브리지가 하나면 바로 연결
    } catch { setBridges('unavailable'); }   // 서버에 브리지 로그인이 아직 없으면 이 칸을 숨김
  };
  useEffect(() => { load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    setBusy(true); setMessage('');
    try { await approveBridgeLogin(code); setCode(''); setMessage('승인했어요. PC 화면에 로그인 완료가 뜨면 serve를 실행하세요.'); setTimeout(() => load(true), 2500); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };
  const logout = async b => {
    setBusy(true);
    try { await revokeBridge(b.id); if (chosen === b.id) onClear(); await load(); setMessage(`${b.name} 브리지를 로그아웃했어요.`); }
    catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  };

  if (bridges === 'unavailable') return null;
  return <View style={{ gap: 6 }}>
    <Text style={s.connNote}>내 PC 브리지 (같은 계정)</Text>
    {bridges?.length === 0 && <Text style={s.connNote}>아직 없어요. PC에서 atria-bridge login을 실행하고 아래에 코드를 넣어 주세요.</Text>}
    {(bridges ?? []).map(b => {
      const on = chosen === b.id;
      return <View key={b.id} style={s.connRow}>
        <Pressable accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={`${b.name}, ${ago(b.last_seen)}`} disabled={disabled || busy}
          onPress={() => onUse(b)} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
          <Icon name="link" size={16} color={c.muted} />
          <View style={{ flex: 1 }}><Text style={s.connRowValue} numberOfLines={1}>{b.name}</Text><Text style={s.connNote}>{ago(b.last_seen)}</Text></View>
          {on && <Icon name="check" size={16} color={c.text} />}
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`${b.name} 로그아웃`} disabled={busy} onPress={() => logout(b)} hitSlop={6}>
          <Text style={s.connNote}>로그아웃</Text>
        </Pressable>
      </View>;
    })}
    <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
      <TextInput accessibilityLabel="PC 브리지 승인 코드" value={code} onChangeText={setCode} autoCapitalize="characters" autoCorrect={false} maxLength={9}
        placeholder="PC 브리지 승인 코드 (예: AB12-CD34)" placeholderTextColor={c.subtle} style={[s.connInput, { flex: 1 }]} editable={!busy} />
      <Pressable accessibilityRole="button" disabled={busy || code.replace(/[^0-9A-Za-z]/g, '').length !== 8} onPress={approve}
        style={[s.aiGhost, (busy || code.replace(/[^0-9A-Za-z]/g, '').length !== 8) && { opacity: 0.4 }]}>
        <Text style={s.aiGhostText}>승인</Text>
      </Pressable>
    </View>
    {!!message && <Text style={s.connNote}>{message}</Text>}
  </View>;
}

export { accountBridgeUrl };
