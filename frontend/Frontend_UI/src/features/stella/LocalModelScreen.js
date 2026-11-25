import React, { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { runtime, maybeRuntime, gateway, readPreference, writePreference, aiPolicy } from '../../integration/runtime';
import { askMobileModel, cancelMobileModelDownload, installMobileModel, listMobileModels, pendingMobileModelDownload } from '../../integration/mobileModel';
import { DEFAULT_DEVICE_MODEL, deviceModels } from '../../integration/mobileModelPolicy.mjs';
import { DEFAULT_CONNECTION, PROVIDERS, gatewayMessages, hasSessionKey, listServerModels, parseBridgeLink, readReply, sendToProvider, setSessionKey } from '../../integration/aiGateway.mjs';
import { ROUTES } from '../../navigation/routes';
import { palette as c, styles as s } from './theme';
import { WorkspaceHeader, PrimaryButton, IconButton } from './WorkspaceScreen';
import Icon from '../../shared/components/Icon';
import { SheetModal } from '../../shared/components/Motion';
import { commandGrammar, routeCommand } from './appCommands.mjs';
import { routeProjectCommand } from './projectCommands.mjs';
import { blockRequest, canAsk, placeAnswer, targetLine } from './aiPending.mjs';

const native = Platform.OS === 'android' || Platform.OS === 'ios';
const CONSENT = {
  device: '이 기기의 모델로 처리',
  server: '입력한 내용을 내가 지정한 서버로 전송',
  cloud: '입력한 내용을 Stella 클라우드 AI로 전송',
  openai: '입력한 내용을 내 OpenAI 계정으로 전송',
  anthropic: '입력한 내용을 내 Anthropic 계정으로 전송',
};
const field = [s.editorBody, { minHeight: 44 }];
const CARD_INFO = {
  device: { name: '이 기기', icon: 'lock', desc: 'Gemma 4 E2B를 휴대폰에서 실행합니다. 입력한 내용이 기기 밖으로 나가지 않습니다.' },
  server: { name: '내 서버', icon: 'link', desc: 'Ollama, LM Studio, llama.cpp, Stella 브리지처럼 /v1/chat/completions를 제공하는 서버에 연결합니다. 같은 네트워크 밖에서는 https 주소를 권장합니다.' },
  cloud: { name: 'Stella 클라우드', icon: 'cloud', desc: '로그인한 계정의 Stella AI 이용량에서 차감됩니다.' },
  openai: { name: 'OpenAI', icon: 'globe', desc: '본인 계정에서 발급한 API 키로 연결합니다. ChatGPT 구독 로그인은 다른 앱에서 쓸 수 없습니다.' },
  anthropic: { name: 'Anthropic', icon: 'globe', desc: '본인 계정에서 발급한 API 키로 연결합니다. Claude 구독 로그인은 다른 앱에서 쓸 수 없습니다.' },
};

export default function LocalModelScreen({ navigation, route }) {
  const commandMode = typeof route?.params?.commandRequest === 'string';
  const asking = canAsk(route?.params); // opened from the AI tab: connection settings only
  const target = route?.params?.block; // long-pressed block: { id, index, type, text }
  const [connection, setConnection] = useState(() => ({ ...DEFAULT_CONNECTION, ...readPreference('aiConnection', {}) }));
  const [deviceList, setDeviceList] = useState([]);
  const [serverList, setServerList] = useState([]);
  const [deviceModel, setDeviceModel] = useState(DEFAULT_DEVICE_MODEL);
  const [keyDraft, setKeyDraft] = useState('');
  const [prompt, setPrompt] = useState(route?.params?.commandRequest ?? '');
  const [reply, setReply] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [waitingNetwork, setWaitingNetwork] = useState(false);
  const [consent, setConsent] = useState(false);
  // 공급자별 전송 동의는 한 번 받으면 기억한다(설정에서 공급자를 바꾸면 그 공급자에 대해 다시 묻는다).
  const [consented, setConsented] = useState(() => readPreference('aiConsent', {}) || {});
  const [showSettings, setShowSettings] = useState(false);
  const [picker, setPicker] = useState(null);
  const active = useRef(false);
  const controller = useRef(null);
  const owner = useRef(runtime()).current;
  const scope = useRef(owner.store.getCurrentWorkspace().id).current;
  const inScope = () => maybeRuntime() === owner && owner.store.getCurrentWorkspace().id === scope && !owner.closedSpaces.has(scope);
  const provider = connection.provider === 'device' && !native ? 'server' : connection.provider;
  const aiRequest = target ? targetLine(target) + '\n' + prompt : prompt; // what the AI sees
  const reviewRequest = target ? blockRequest(target, prompt) : prompt; // the review screen verifies against this form
  const keyProvider =['openai', 'anthropic', 'server'].includes(provider) ? provider : null;

  function update(patch) {
    const next = { ...connection, ...patch };
    setConnection(next); setReply(null); setError(''); setConsent(false);
    try { writePreference('aiConnection', next); } catch { /* the choice still applies to this screen */ }
  }
  async function loadDevice(preferred) {
    if (!native) return;
    try {
      const list = await listMobileModels();
      if (!active.current) return;
      setDeviceList(list);
      setDeviceModel(previous => [preferred, previous, DEFAULT_DEVICE_MODEL].find(id => list.includes(id)) || list[0] || DEFAULT_DEVICE_MODEL);
    } catch (e) { if (active.current) setError(e.message); }
  }
  async function loadServer() {
    setError('');
    try {
      const list = await listServerModels(connection);
      if (!active.current) return;
      setServerList(list);
      if (!list.includes(connection.serverModel) && list[0]) update({ serverModel: list[0] });
      if (!list.length) setError('서버에 사용할 수 있는 모델이 없습니다.');
    } catch (e) { if (active.current) setError(e.message); }
  }
  useEffect(() => {
    active.current = true;
    void loadDevice();
    // 화면을 나간 사이에도 받고 있던(또는 끝난) 다운로드가 있으면 진행률을 이어서 보여 주고 설치를 마무리한다.
    if (pendingMobileModelDownload() === DEFAULT_DEVICE_MODEL) void install();
    return () => { active.current = false; controller.current?.abort(); };
  }, []);

  async function install() {
    const request = new AbortController();
    controller.current = request;
    setBusy('install'); setProgress(0); setError('');
    try {
      await installMobileModel(DEFAULT_DEVICE_MODEL, { signal: request.signal, onProgress: (value, paused) => { if (active.current && !request.signal.aborted) { setProgress(value); setWaitingNetwork(!!paused); } } });
      if (!request.signal.aborted) await loadDevice(DEFAULT_DEVICE_MODEL);
    } catch (e) { if (active.current && !request.signal.aborted) setError(e.message); }
    finally { controller.current = null; if (active.current) setBusy(''); }
  }

  function cancelInstall() {
    cancelMobileModelDownload();
    controller.current?.abort();
  }

  async function ask() {
    if (controller.current || !(consent || consented[provider]) || !prompt.trim()) return;
    if (!consented[provider]) {
      const next = { ...consented, [provider]: true };
      setConsented(next);
      try { writePreference('aiConsent', next); } catch { /* consent still applies to this request */ }
    }
    if (!inScope()) { setError('계정 또는 공간이 바뀌었습니다. 다시 열어 주세요.'); return; }
    setError(''); setReply(null);
    // Clear requests skip the model. Chat mode ignores routing clarifications so ordinary questions still reach the AI.
    let routed = routeProjectCommand(prompt).command ? routeProjectCommand(prompt) : routeCommand(prompt);
    if (!routed.command && target) {
      const onBlock = routeCommand(reviewRequest);
      if (onBlock.command) routed = onBlock;
    }
    if (routed.command) { setReply({ command: routed.command, model: '규칙 해석 (AI 미사용)' }); return; }
    if (commandMode && routed.clarify) { setError(routed.clarify); return; }
    if (!ready) { setError(provider === 'device' ? '먼저 기기 모델을 내려받아 주세요.' : provider === 'server' ? '서버 주소와 모델을 먼저 설정해 주세요.' : 'API 키를 먼저 입력해 주세요.'); return; }
    const mode = commandMode ? 'command' : 'chat';
    const request = new AbortController();
    controller.current = request;
    setBusy('ask');
    try {
      const messages = gatewayMessages(aiRequest, mode);
      if (provider === 'cloud' && aiPolicy().excluded) throw new Error('AI 설정에서 외부 전송이 꺼져 있습니다.');
      const result = await sendToProvider({ ...connection, provider }, { ...messages, mode }, {
        signal: request.signal, newId: randomUUID,
        cloud: (path, body, options) => gateway(path, body, { route: aiPolicy().route, ...options }),
        device: ({ system, user, signal }) => askMobileModel({ model: deviceModel, signal,
          prompt: mode === 'command' ? user : system + '\n\n' + user,
          commandRequest: mode === 'command' ? prompt : undefined, grammar: mode === 'command' ? commandGrammar : undefined }),
      });
      if (!active.current || request.signal.aborted || !inScope()) return;
      const parsed = readReply(result.text, mode);
      if (parsed.clarify) setError(parsed.clarify);
      else setReply({ ...parsed, model: result.model });
    } catch (e) {
      if (active.current && !request.signal.aborted) setError(e.message);
    } finally {
      controller.current = null;
      if (active.current) setBusy('');
    }
  }
  function useReply(replace = false) {
    try {
      if (!inScope()) throw new Error('계정 또는 공간이 바뀌었습니다. 다시 열어 주세요.');
      if (reply.command) navigation.navigate(ROUTES.AppCommand, { command: reply.command, originalRequest: reviewRequest, memoId: route?.params?.memoId });
      else {
        placeAnswer(owner, { memoId: route.params.memoId, revision: route.params.revision, blockId: target.id, text: reply.text, replace }, { read: readPreference, write: writePreference }, randomUUID);
        navigation.goBack();
      }
    } catch (e) { setError(e.message); }
  }
  const row = (label, onPress, selected) => <Pressable accessibilityRole="button" accessibilityState={{ selected: !!selected }} onPress={onPress} disabled={!!busy} style={s.menuRow}>
    <Text style={s.menuLabel}>{label}{selected ? ' ✓' : ''}</Text></Pressable>;
  const ready = provider === 'device' ? deviceList.includes(deviceModel)
    : provider === 'server' ? !!connection.serverUrl.trim() && !!connection.serverModel
    : provider === 'cloud' || hasSessionKey(provider);

  const modelLabel = provider === 'device' ? ''
    : provider === 'server' ? connection.serverModel : provider === 'cloud' ? '' : connection[provider + 'Model'];
  const errorView = !!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>;
  // 공급자별 상태: Orca 에이전트 연결 화면처럼 카드마다 이름, 설명, 상태 배지, 동작을 둔다.
  const statusOf = id => id === 'device' ? (busy === 'install' ? '받는 중 ' + Math.round(100 * progress) + '%' : deviceList.length ? '준비됨' : '모델 필요')
    : id === 'server' ? (connection.serverUrl.trim() && connection.serverModel ? '준비됨' : '설정 필요')
    : id === 'cloud' ? '준비됨' : hasSessionKey(id) ? '키 입력됨' : '키 필요';
  const ghost = (label, icon, onPress, disabled) => <Pressable key={label} accessibilityRole="button" disabled={disabled || !!busy && busy !== 'install'} onPress={onPress} style={[s.aiGhost, disabled && { opacity: .4 }]}>
    <Icon name={icon} size={15} color={c.text} /><Text style={s.aiGhostText}>{label}</Text></Pressable>;
  const detailRow = (label, value, onPress) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label + ' ' + value} disabled={!onPress || !!busy} onPress={onPress} style={s.connRow}>
    <Text style={s.connRowLabel}>{label}</Text><Text numberOfLines={1} style={s.connRowValue}>{value}</Text>{onPress && <Icon name="chevronRight" size={14} color={c.subtle} />}</Pressable>;
  const details = id => <View style={s.connDetails}>
    {id === 'device' && <>
      {deviceList.length > 0 && detailRow('모델', deviceModels[deviceModel]?.label || deviceModel, deviceList.length > 1 ? () => setPicker('device') : null)}
      {!deviceList.includes(DEFAULT_DEVICE_MODEL) && <View style={s.aiActions}>
        {busy === 'install' ? ghost('다운로드 취소', 'x', cancelInstall) : ghost('Gemma 4 E2B 내려받기 (2.84 GB)', 'arrowUp', install)}</View>}
      {busy === 'install' && <Text style={s.connNote}>{waitingNetwork ? '네트워크를 기다리는 중입니다. ' : ''}화면을 나가거나 앱을 닫아도 백그라운드에서 계속 받고, 알림에서 진행률을 볼 수 있습니다.</Text>}
    </>}
    {id === 'server' && <>
      <TextInput accessibilityLabel="서버 주소" value={connection.serverUrl} onChangeText={serverUrl => {
        // A pasted bridge link fills the address; its key stays in memory for this run only, like a typed server key.
        const bridge = parseBridgeLink(serverUrl);
        if (bridge) setSessionKey('server', bridge.key);
        update({ serverUrl: bridge ? bridge.url : serverUrl });
      }} editable={!busy} autoCapitalize="none" autoCorrect={false} placeholder="서버 주소 또는 Stella 브리지 연결 문자열" placeholderTextColor={c.subtle} style={s.connInput} />
      {detailRow('모델', connection.serverModel || '서버에서 불러오기', () => (serverList.length ? setPicker('server') : loadServer()))}
      {!!connection.serverUrl && serverList.length > 0 && <View style={s.aiActions}>{ghost('모델 목록 새로고침', 'refresh', loadServer)}</View>}
    </>}
    {(id === 'openai' || id === 'anthropic') && <TextInput accessibilityLabel="모델 이름" value={connection[id + 'Model']} onChangeText={value => update({ [id + 'Model']: value })}
      editable={!busy} autoCapitalize="none" autoCorrect={false} placeholder={DEFAULT_CONNECTION[id + 'Model']} placeholderTextColor={c.subtle} style={s.connInput} />}
    {['server', 'openai', 'anthropic'].includes(id) && <>
      {/* 입력하는 즉시 이번 실행에 적용한다. 기기에는 저장하지 않는다. */}
      <TextInput accessibilityLabel="API 키" value={keyDraft} onChangeText={value => { setKeyDraft(value); if (value) { setSessionKey(id, value); setError(''); } }} secureTextEntry editable={!busy}
        autoCapitalize="none" autoCorrect={false} placeholder={hasSessionKey(id) ? '키 입력됨. 바꾸려면 다시 입력' : id === 'server' ? '서버 키 (필요할 때만)' : 'API 키'}
        placeholderTextColor={c.subtle} style={s.connInput} />
      <Text style={s.connNote}>키는 기기에 저장하지 않으며 앱을 다시 열면 다시 입력해야 합니다.</Text>
    </>}
  </View>;
  const cards = <>
    {Object.keys(PROVIDERS).filter(id => native || id !== 'device').map(id => {
      const on = id === provider, info = CARD_INFO[id], status = statusOf(id);
      return <View key={id} style={[s.connCard, on && s.connCardOn]}>
        <View style={s.connHead}>
          <Icon name={info.icon} size={18} color={on ? c.text : c.muted} />
          <Text style={s.connName}>{info.name}</Text>
          {on && <Text style={[s.connBadge, s.connBadgeOn]}>사용 중</Text>}
          <Text style={[s.connBadge, (status === '준비됨' || status === '키 입력됨') && s.connBadgeReady]}>{status}</Text>
        </View>
        <Text style={s.connDesc}>{info.desc}</Text>
        {on ? details(id) : <View style={s.aiActions}>{ghost('이 AI 사용', 'check', () => { setKeyDraft(''); update({ provider: id }); })}</View>}
      </View>;
    })}
  </>;

  return <View style={s.root}><WorkspaceHeader title={asking ? 'AI에게 요청' : 'AI 연결'} onBack={navigation.goBack} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={s.page}>
      {commandMode && <Text accessibilityRole="header" style={s.title}>앱 작업 해석</Text>}
      {!!target && <Text selectable style={s.aiTarget}>{targetLine(target)}</Text>}
      {!asking && <Text style={s.intro}>문서 블록을 길게 누르면 여기서 사용 중으로 고른 AI에게 요청합니다. 어떤 AI든 앱 변경은 검토와 승인 뒤에만 실행합니다.</Text>}
      {!asking && <View style={{ gap: 12, marginTop: 16 }}>{cards}</View>}
      {!asking && errorView}
      {asking && <>
        <TextInput accessibilityLabel="AI에게 요청" value={prompt} onChangeText={value => { setPrompt(value); setReply(null); }} autoFocus
          editable={!busy} placeholder={target ? '이 블록에 무엇을 할까요? 예: 더 간결하게 고쳐줘' : '질문이나 앱 작업을 입력하세요. 예: 회의록 문서 만들어줘'} placeholderTextColor={c.subtle} multiline maxLength={commandMode ? 2000 : 12000} style={s.promptBox} />
        {!consented[provider] && <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: consent }} disabled={!!busy} onPress={() => setConsent(!consent)} style={s.aiConsent}>
          <Icon name={consent ? 'checkSquare' : 'square'} size={19} color={consent ? c.text : c.muted} /><Text style={[s.menuLabel, { color: c.muted }]}>{CONSENT[provider]} (처음 한 번)</Text></Pressable>}
        <View style={s.aiActions}>
          {(() => { const off = !!busy || !ready || !(consent || consented[provider]) || !prompt.trim();
            return <Pressable accessibilityRole="button" accessibilityState={{ disabled: off }} disabled={off} onPress={ask} style={[s.aiSend, off && { opacity: .4 }]}>
              <Icon name="arrowUp" size={16} color={c.text} /><Text style={s.aiSendText}>{busy === 'ask' ? '응답 생성 중' : '보내기'}</Text></Pressable>; })()}
          {busy === 'ask' && <Pressable accessibilityRole="button" onPress={() => controller.current?.abort()} style={s.aiGhost}><Icon name="x" size={15} color={c.text} /><Text style={s.aiGhostText}>중지</Text></Pressable>}
        </View>
        {!ready && <Text style={s.connNote}>{PROVIDERS[provider].label} 연결을 마치면 보낼 수 있습니다. 아래 AI 연결에서 설정해 주세요.</Text>}
        {errorView}
        {!!reply && <View style={s.aiReply}><Text style={s.aiReplyLabel}>{reply.command ? '제안한 앱 작업' : 'AI 답변'} ({reply.model})</Text>
          <Text selectable style={s.proposalBody}>{reply.command || reply.text}</Text>
          <View style={s.aiActions}>
            {reply.command ? <Pressable accessibilityRole="button" onPress={() => useReply()} style={s.aiSend}><Icon name="file" size={15} color={c.text} /><Text style={s.aiSendText}>앱 작업 검토</Text></Pressable> : <>
              {!!target && <Pressable accessibilityRole="button" accessibilityHint="수용하기 전까지 원래 블록은 그대로 남습니다" onPress={() => useReply(true)} style={s.aiSend}><Icon name="edit" size={15} color={c.text} /><Text style={s.aiSendText}>이 블록 바꾸기</Text></Pressable>}
              <Pressable accessibilityRole="button" onPress={() => useReply()} style={target ? s.aiGhost : s.aiSend}><Icon name="plus" size={15} color={c.text} /><Text style={target ? s.aiGhostText : s.aiSendText}>{target ? '아래에 넣기' : '블록으로 넣기'}</Text></Pressable>
            </>}
            <Pressable accessibilityRole="button" disabled={!!busy} onPress={ask} style={s.aiGhost}><Icon name="refresh" size={15} color={c.text} /><Text style={s.aiGhostText}>다시 시도</Text></Pressable>
          </View>
          {!!target && !reply.command && <Text style={s.note}>바꾸기와 넣기는 모두 문서에서 수용하기 전까지 제안으로만 표시됩니다.</Text>}
        </View>}
        {/* 연결 설정은 요청 화면에서 빼고, 한 줄 요약과 별도 시트로 연다(입력한 요청은 그대로 유지). */}
        <Pressable accessibilityRole="button" onPress={() => setShowSettings(true)} style={s.aiConnection}>
          <Icon name={CARD_INFO[provider].icon} size={15} color={c.subtle} /><Text numberOfLines={1} style={s.aiConnectionText}>{CARD_INFO[provider].name}{modelLabel ? ', ' + modelLabel : ''}  /  {statusOf(provider)}</Text>
          <Text style={s.linkText}>AI 연결</Text></Pressable>
      </>}
    </ScrollView>
    <SheetModal visible={asking && showSettings} onClose={() => setShowSettings(false)} label="AI 연결">
      <View style={s.titleRow}><Text style={s.sectionTitle}>AI 연결</Text><IconButton name="x" label="AI 연결 닫기" onPress={() => setShowSettings(false)} /></View>
      <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12, paddingTop: 8 }}>{cards}{errorView}</ScrollView>
    </SheetModal>
    <Modal visible={!!picker} transparent onRequestClose={() => setPicker(null)}><View style={s.modalShade}><View style={s.sheet}>
      <View style={s.titleRow}><Text style={s.sectionTitle}>{picker === 'provider' ? 'AI 연결' : '모델 선택'}</Text><IconButton name="x" label="닫기" onPress={() => setPicker(null)} /></View>
      {picker === 'provider' && Object.entries(PROVIDERS).filter(([id]) => native || id !== 'device').map(([id, item]) => <View key={id}>
        {row(item.label, () => { setPicker(null); update({ provider: id }); }, id === provider)}</View>)}
      {picker === 'device' && deviceList.map(id => <View key={id}>{row(deviceModels[id]?.label || id, () => { setDeviceModel(id); setPicker(null); }, id === deviceModel)}</View>)}
      {picker === 'server' && serverList.map(id => <View key={id}>{row(id, () => { update({ serverModel: id }); setPicker(null); }, id === connection.serverModel)}</View>)}
    </View></View></Modal>
  </View>;
}
