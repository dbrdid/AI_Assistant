import React, { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { addMemo } from '../../data/memos/MemoStore';
import { runtime, maybeRuntime } from '../../integration/runtime';
import { LOCAL_PREVIEW } from '../../integration/mode';
import { ROUTES } from '../../navigation/routes';
import Icon from '../../shared/components/Icon';
import { palette as c, styles as s } from './theme';
import { WorkspaceHeader, PrimaryButton, IconButton } from './WorkspaceScreen';
export default function LocalModelScreen({
  navigation
}) {
  const [answerPrompt, setAnswerPrompt] = useState('');
  const [models, setModels] = useState([]),
    [selected, setSelected] = useState(''),
    [prompt, setPrompt] = useState(''),
    [answer, setAnswer] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [consent, setConsent] = useState(false),
    [picker, setPicker] = useState(false),
    [loading, setLoading] = useState(false);
  const controller = useRef(null),
    active = useRef(true),
    sequence = useRef(0);
  useEffect(() => () => {
    active.current = false;
    controller.current?.abort();
  }, []);
  const available = LOCAL_PREVIEW && Platform.OS === 'web';
  async function loadModels() {
    if (!available) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/__stella-model/models');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (!active.current) return;
      setModels(result.models);
      setSelected(current => result.models.includes(current) ? current : result.models.find(model => model === 'gemma4:e4b') ?? result.models[0] ?? '');
    } catch (e) {
      if (active.current) setError(e.message);
    } finally {
      if (active.current) setLoading(false);
    }
  }
  useEffect(() => {
    void loadModels();
  }, []);
  async function ask() {
    if (!consent || !selected || !prompt.trim() || busy) return;
    const own = runtime();
    const id = ++sequence.current;
    controller.current = new AbortController();
    setBusy(true);
    setError('');
    setAnswer('');
    setAnswerPrompt(prompt);
    try {
      const response = await fetch('/__stella-model/ask', {
        method: 'POST',
        signal: controller.current.signal,
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: selected,
          prompt,
          consent
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (active.current && id === sequence.current && maybeRuntime() === own) setAnswer(result.text);
    } catch (e) {
      if (active.current && id === sequence.current && e.name !== 'AbortError') setError(e.message);
    } finally {
      if (active.current && id === sequence.current) setBusy(false);
    }
  }
  function stop() {
    sequence.current++;
    controller.current?.abort();
    setBusy(false);
    setError('응답 표시를 중지했습니다. 이미 시작된 모델 처리는 즉시 종료되지 않을 수 있습니다.');
  }
  return <View style={s.root}><WorkspaceHeader title="로컬 AI" onBack={navigation.goBack} right={<IconButton name="refresh" label="모델 목록 새로고침" onPress={loadModels} disabled={loading || busy} />} /><ScrollView showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={s.page}><Text style={s.intro}>질문에 입력한 내용만 모델로 전송됩니다.</Text>{!available ? <><Text style={s.note}>데스크톱 로컬 미리보기에서 사용하는 기능입니다. 모바일 앱에서는 AI 설정에 연결한 서버를 사용하세요.</Text><PrimaryButton label="AI 채팅 열기" icon="message" onPress={() => navigation.navigate(ROUTES.Ai)} /></> : <><Pressable accessibilityRole="button" onPress={() => setPicker(true)} disabled={busy} style={[s.secondary, {
          marginTop: 22,
          flexDirection: 'row',
          gap: 10
        }]}><Text style={s.secondaryText}>{selected || (loading ? '모델 확인 중…' : '모델 선택')}</Text><Icon name="chevronDown" size={15} color={c.muted} /></Pressable>{!models.length && !loading && <Text style={s.note}>실행 중인 Ollama와 설치된 모델을 확인한 뒤 새로고침하세요. 새 모델을 자동으로 다운로드하지 않습니다.</Text>}<TextInput accessibilityLabel="로컬 모델에 질문" value={prompt} onChangeText={setPrompt} editable={!busy} placeholder="질문이나 정리할 내용을 입력하세요." placeholderTextColor={c.subtle} multiline maxLength={12000} style={[s.editorBody, {
          minHeight: 190,
          marginTop: 16
        }]} /><Pressable accessibilityRole="checkbox" accessibilityState={{
          checked: consent
        }} onPress={() => setConsent(!consent)} disabled={busy} style={[s.menuRow, {
          borderBottomWidth: 0
        }]}><Icon name={consent ? 'checkSquare' : 'square'} size={19} color={c.muted} /><Text style={[s.rowBody, {
            flex: 1
          }]}>입력한 내용을 이 PC의 Ollama에 전송합니다.</Text></Pressable><View style={[s.actions, {
          gap: 12,
          marginTop: 10
        }]}><PrimaryButton label={busy ? '응답 생성 중…' : '질문 보내기'} icon="arrowUp" onPress={ask} disabled={busy || !consent || !selected || !prompt.trim()} />{busy && <Pressable accessibilityRole="button" onPress={stop} style={s.secondary}><Text style={s.secondaryText}>중지</Text></Pressable>}</View></>}{error ? <Text accessibilityRole="alert" style={[s.error, {
        marginTop: 18
      }]}>{error}</Text> : null}{answer ? <View style={s.section}><Text style={s.sectionTitle}>모델 답변</Text><Text selectable style={s.proposalBody}>{answer}</Text><View style={{
          marginTop: 18
        }}><PrimaryButton label="확인한 답변을 새 문서로 저장" icon="file" onPress={() => {
            try {
              const memo = addMemo({
                title: answerPrompt.trim().slice(0, 70),
                body: answer
              });
              navigation.navigate(ROUTES.MemoEdit, {
                memoId: memo.id
              });
            } catch (e) {
              setError(e.message);
            }
          }} /></View></View> : null}</ScrollView><Modal visible={picker} transparent animationType="none" onRequestClose={() => setPicker(false)}><View style={s.modalShade}><View style={s.sheet}><View style={s.titleRow}><Text style={s.sectionTitle}>설치된 로컬 모델</Text><IconButton name="x" label="모델 선택 닫기" onPress={() => setPicker(false)} /></View>{models.map(model => <Pressable key={model} accessibilityRole="button" onPress={() => {
            setSelected(model);
            setPicker(false);
          }} style={s.menuRow}><Text style={s.menuLabel}>{model}</Text>{selected === model && <Icon name="check" size={18} color={c.text} />}</Pressable>)}</View></View></Modal></View>;
}
