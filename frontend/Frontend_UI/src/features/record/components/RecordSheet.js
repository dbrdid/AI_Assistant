// ============================================================
// RecordSheet.js — 녹음이 끝난 뒤 홈에 뜨는 창
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import Svg, { Path, Rect } from 'react-native-svg';
import Icon from '../../../shared/components/Icon';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { newTranscribeJob, transcribeRecording } from '../../../services/ai/Transcribe';
import { analyzeText } from '../../../services/ai/AiAnalyze';
import { addMemo } from '../../../data/memos/MemoStore';
import { setAiTransmission } from '../../../data/settings/SettingsStore';

// 재생/일시정지 아이콘 (Icon.js 에 없어 여기서 직접 그림)
function PlayIcon({ playing, size = 18, color = colors.ink }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      {playing ? (
        <>
          <Rect x="6" y="4" width="4" height="16" rx="1" />
          <Rect x="14" y="4" width="4" height="16" rx="1" />
        </>
      ) : (
        <Path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />
      )}
    </Svg>
  );
}

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

function Player({ uri }) {
  const player = useAudioPlayer(uri ? { uri } : null);
  const status = useAudioPlayerStatus(player);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={status.playing ? '일시정지' : '녹음 듣기'}
      onPress={() => {
        if (status.playing) player.pause();
        else {
          if (status.didJustFinish || (status.duration && status.currentTime >= status.duration - 0.1)) player.seekTo(0);
          player.play();
        }
      }}
      style={[styles.ghost, styles.row]}
    >
      <PlayIcon playing={status.playing} />
      <Text style={styles.ghostText}>{status.playing ? '일시정지' : '듣기'}</Text>
    </Pressable>
  );
}

// 받아 적은 글로 만든 메모 제목: "녹음 11/16 14:05"
const memoTitleFor = (d = new Date()) =>
  `녹음 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export default function RecordSheet({ sheet, onClose, onOpenFiles, onOpenMemo, onOpenProposals }) {
  // phase: idle(처음) · upload(올리고 받아 적는 중) · analyze(일정·할 일 찾는 중) · done · error
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null); // { code, message }
  const [result, setResult] = useState(null); // { text, memoId, added, analyzeError }
  const job = useRef(null); // 녹음 하나의 변환 작업 (다시 시도할 때 업로드를 다시 하지 않도록 이어서 씀)
  useEffect(() => {
    setPhase('idle'); setError(null); setResult(null);
    job.current = sheet?.uri ? newTranscribeJob(sheet.uri, sheet.seconds) : null;
  }, [sheet]);
  if (!sheet) return null;
  const busy = phase === 'upload' || phase === 'analyze';

  const convert = async () => {
    if (busy || !job.current) return;
    setError(null);
    setPhase('upload');
    const r = await transcribeRecording(job.current);
    job.current = r.job;
    if (!r.ok) { setError({ code: r.code, message: r.message }); setPhase('error'); return; }
    const text = r.text.trim();
    if (!text) { setError({ code: 'EMPTY', message: '녹음에서 알아들을 수 있는 말이 없었어요' }); setPhase('error'); return; }
    // 받아 적은 글은 메모로 남기고, 그 메모에서 일정·할 일을 찾아 AI 제안으로 만듦
    let memoId = null;
    try { memoId = addMemo({ title: memoTitleFor(), body: text.slice(0, 100_000) })?.id ?? null; } catch { /* 저장 실패해도 글은 보여 줌 */ }
    setResult({ text, memoId, added: 0, analyzeError: null });
    if (!memoId) { setPhase('done'); return; }
    setPhase('analyze');
    const a = await analyzeText({ sourceType: 'memo', sourceId: memoId, explicit: true });
    setResult({ text, memoId, added: a.added ?? 0, analyzeError: a.error ?? null });
    setPhase('done');
  };
  // 외부 AI 보내기 동의 후 바로 다시 변환
  const allowAndConvert = async () => {
    try { await setAiTransmission('external', true); } catch (e) { setError({ code: 'CONSENT', message: e.message }); return; }
    convert();
  };
  const consentNeeded = error && (error.code === 'CONSENT_REQUIRED' || error.code === 'TRANSMISSION_DENIED');
  const label = phase === 'upload' ? '녹음을 받아 적는 중…' : phase === 'analyze' ? '일정·할 일 찾는 중…' : phase === 'error' ? '다시 시도' : '텍스트로 정리하기';

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          {sheet.state === 'saved' && (
            <>
              <View style={styles.titleRow}>
                <View style={styles.titleIcon}><Icon name="mic" size={20} color={colors.mintDark} /></View>
                <Text style={styles.title}>녹음을 저장했어요</Text>
              </View>
              <Text style={styles.sub}>{fmt(sheet.seconds || 0)}{sheet.fileId ? ' · 파일 보관함에 보관돼요' : ''}</Text>
              <Player uri={sheet.uri} />
              {phase === 'done' && result ? (
                <>
                  {/* 받아 적은 글 (길면 안에서 스크롤) */}
                  <ScrollView style={styles.textBox} contentContainerStyle={{ padding: spacing.md }}>
                    <Text style={styles.text} selectable>{result.text}</Text>
                  </ScrollView>
                  <Text style={styles.note}>
                    {result.memoId ? '메모로 저장했어요. ' : '메모로 저장하지 못했어요. 글을 길게 눌러 복사해 주세요. '}
                    {result.memoId && (result.analyzeError ? '일정·할 일은 찾지 못했어요.' : result.added > 0 ? `AI 제안 ${result.added}건을 만들었어요.` : '찾은 일정이나 할 일은 없어요.')}
                  </Text>
                  {result.added > 0 && onOpenProposals && (
                    <Pressable accessibilityRole="button" onPress={onOpenProposals} style={styles.primary}><Text style={styles.primaryText}>AI 제안 확인하기</Text></Pressable>
                  )}
                  {!!result.memoId && onOpenMemo && (
                    <Pressable accessibilityRole="button" onPress={() => onOpenMemo(result.memoId)} style={styles.ghost}><Text style={styles.ghostText}>메모 열기</Text></Pressable>
                  )}
                </>
              ) : (
                <>
                  {consentNeeded ? (
                    <Pressable accessibilityRole="button" disabled={busy} onPress={allowAndConvert} style={styles.primary}>
                      <Text style={styles.primaryText}>허용하고 정리하기</Text>
                    </Pressable>
                  ) : (
                    <Pressable accessibilityRole="button" disabled={busy} onPress={convert} style={[styles.primary, busy && { opacity: 0.5 }]}>
                      {busy ? <ActivityIndicator color={colors.white} /> : null}
                      <Text style={styles.primaryText}>{label}</Text>
                    </Pressable>
                  )}
                  {!!error && <Text style={styles.error}>{error.message}</Text>}
                  {phase === 'idle' && <Text style={styles.hint}>녹음을 외부 AI로 보내 글자로 바꾸고 메모로 저장해요. 변환이 끝나면 서버의 녹음은 바로 지워져요.</Text>}
                </>
              )}
              {!!sheet.fileId && <Pressable accessibilityRole="button" onPress={onOpenFiles} style={styles.ghost}><Text style={styles.ghostText}>파일 보관함 보기</Text></Pressable>}
            </>
          )}
          {sheet.state === 'denied' && (
            <>
              <View style={styles.titleRow}>
                <View style={[styles.titleIcon, { backgroundColor: colors.coralSoft }]}><Icon name="alert" size={20} color={colors.coral} /></View>
                <Text style={styles.title}>마이크 권한이 필요해요</Text>
              </View>
              <Text style={styles.sub}>녹음을 하려면 마이크 권한을 허용해 주세요.</Text>
              <Pressable accessibilityRole="button" onPress={() => { onClose(); Linking.openSettings().catch(() => {}); }} style={styles.primary}>
                <Text style={styles.primaryText}>설정 열기</Text>
              </Pressable>
            </>
          )}
          {sheet.state === 'error' && (
            <>
              <View style={styles.titleRow}>
                <View style={[styles.titleIcon, { backgroundColor: colors.coralSoft }]}><Icon name="alert" size={20} color={colors.coral} /></View>
                <Text style={styles.title}>녹음하지 못했어요</Text>
              </View>
              <Text style={styles.sub}>다시 시도해 주세요. 계속되면 마이크가 다른 앱에서 쓰이고 있는지 확인해 주세요.</Text>
            </>
          )}
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.ghost}><Text style={styles.ghostText}>닫기</Text></Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: { width: '100%', maxWidth: 360, backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, padding: spacing.xl, gap: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center' },
  title: { flexShrink: 1, fontSize: font.title, fontWeight: '800', color: colors.ink },
  row: { flexDirection: 'row', gap: spacing.sm },
  sub: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  note: { fontSize: font.body, color: colors.mintDark, lineHeight: 20, fontWeight: '600' },
  error: { fontSize: font.body, color: colors.coral, lineHeight: 20, fontWeight: '600' },
  hint: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  textBox: { maxHeight: 200, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  text: { fontSize: font.body, color: colors.ink, lineHeight: 21 },
  primary: { minHeight: 52, borderRadius: radius.pill, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: spacing.sm },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  ghost: { minHeight: 48, borderRadius: radius.pill, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
