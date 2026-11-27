// ============================================================
// RecordSheet.js — 녹음이 끝난 뒤 홈에 뜨는 창
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import Svg, { Path, Rect } from 'react-native-svg';
import Icon from '../../../shared/components/Icon';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { finishTranscription, newTranscribeJob, transcribeRecording } from '../../../services/ai/Transcribe';
import { analyzeText } from '../../../services/ai/AiAnalyze';
import { titleRecording } from '../../../services/ai/AiTitle';
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

export default function RecordSheet({ sheet, onClose, onOpenFiles, onOpenMemo, onOpenProposals, onRetrySave }) {
  // phase: idle(처음) · upload(올리고 받아 적는 중) · analyze(일정·할 일 찾는 중) · done · error
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null); // { code, message }
  const [result, setResult] = useState(null); // { text, memoId, added, analyzeError }
  const job = useRef(null); // 녹음 하나의 변환 작업 (다시 시도할 때 업로드를 다시 하지 않도록 이어서 씀)
  const [progress, setProgress] = useState('');   // 긴 녹음: 나누기, 구간 올리기, 서버 변환 진행 문구
  useEffect(() => {
    setPhase('idle'); setError(null); setResult(null); setProgress('');
    job.current = sheet?.uri ? newTranscribeJob(sheet.uri, sheet.seconds) : null;
  }, [sheet]);
  if (!sheet) return null;
  const busy = phase === 'upload' || phase === 'analyze';

  const convert = async () => {
    if (busy || !job.current) return;
    setError(null);
    setPhase('upload');
    const r = await transcribeRecording(job.current, { onProgress: (p) => setProgress(p.text) });
    setProgress('');
    job.current = r.job;
    if (!r.ok) { setError({ code: r.code, message: r.message }); setPhase('error'); return; }
    const text = r.text.trim();
    if (!text) { setError({ code: 'EMPTY', message: '녹음에서 알아들을 수 있는 말이 없었어요' }); setPhase('error'); return; }
    // 받아 적은 글은 메모로 남기고, 그 메모에서 일정·할 일을 찾아 AI 제안으로 만듦
    let memoId = null;
    const timeTitle = memoTitleFor();
    try { memoId = addMemo({ title: timeTitle, body: text.slice(0, 100_000) })?.id ?? null; } catch { /* 저장 실패해도 글은 보여 줌 */ }
    // 메모로 저장했으면 서버의 임시 전사문을 지움 (긴 녹음). 빠진 구간이 있으면 다시 시도할 수 있게 남겨 둠
    if (memoId && r.complete) void finishTranscription(r.job);
    const missing = r.missing ?? 0;
    setResult({ text, memoId, added: 0, missing, analyzeError: null });
    if (!memoId) { setPhase('done'); return; }
    setPhase('analyze');
    const a = await analyzeText({ sourceType: 'memo', sourceId: memoId, explicit: true });
    setResult({ text, memoId, missing, added: a.added ?? 0, saved: a.saved ?? 0, pending: a.pending ?? a.added ?? 0, analyzeError: a.error ?? null });
    setPhase('done');
    // 분석이 끝난 뒤 제목을 내용으로 바꿈 (분석 중에 제목이 바뀌면 분석이 원문 변경으로 멈추므로 순서를 지킴)
    titleRecording(memoId, timeTitle);
  };
  // 외부 AI 보내기 동의 후 바로 다시 변환
  const allowAndConvert = async () => {
    try { await setAiTransmission('external', true); } catch (e) { setError({ code: 'CONSENT', message: e.message }); return; }
    convert();
  };
  const consentNeeded = error && (error.code === 'CONSENT_REQUIRED' || error.code === 'TRANSMISSION_DENIED');
  const label = phase === 'upload' ? '녹음을 받아 적는 중…' : phase === 'analyze' ? '일정과 할 일 찾는 중…' : phase === 'error' ? '다시 시도' : '텍스트로 정리하기';

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          {(sheet.state === 'saved' || sheet.state === 'save_error') && (
            <>
              <View style={styles.titleRow}>
                <View style={styles.titleIcon}><Icon name="mic" size={20} color={colors.mintDark} /></View>
                <Text style={styles.title}>{sheet.state === 'saved' ? '녹음을 저장했어요' : '녹음 파일을 저장하지 못했어요'}</Text>
              </View>
              <Text style={styles.sub}>{fmt(sheet.seconds || 0)}{sheet.folder ? ` · ${sheet.folder}` : ''}</Text>
              {sheet.state === 'save_error' && (
                <>
                  <Text accessibilityLiveRegion="polite" style={styles.error}>{sheet.saveError || '저장 위치의 권한을 확인해 주세요.'}</Text>
                  <Pressable accessibilityRole="button" disabled={sheet.saving || busy} onPress={onRetrySave} style={[styles.primary, (sheet.saving || busy) && { opacity: 0.5 }]}>
                    {sheet.saving ? <ActivityIndicator color={colors.onPrimary} /> : null}
                    <Text style={styles.primaryText}>{sheet.saving ? '저장 중…' : '저장 다시 시도'}</Text>
                  </Pressable>
                </>
              )}
              <Player uri={sheet.uri} />
              {phase === 'done' && result ? (
                <>
                  {/* 받아 적은 글 (길면 안에서 스크롤) */}
                  <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} style={styles.textBox} contentContainerStyle={{ padding: spacing.md }}>
                    <Text style={styles.text} selectable>{result.text}</Text>
                  </ScrollView>
                  {result.missing > 0 && <Text style={styles.error}>{result.missing}개 구간은 변환하지 못했어요. 글 안에 표시된 자리를 확인해 주세요.</Text>}
                  <Text style={styles.note}>
                    {result.memoId ? '메모로 저장했어요. ' : '메모로 저장하지 못했어요. 글을 길게 눌러 복사해 주세요. '}
                    {result.memoId && (result.analyzeError ? '일정과 할 일은 찾지 못했어요.' : result.saved > 0 ? `${result.saved}건을 자동 저장했어요.${result.pending ? ` ${result.pending}건은 확인이 필요해요.` : ''}` : result.pending > 0 ? `AI 제안 ${result.pending}건을 만들었어요.` : '찾은 일정이나 할 일은 없어요.')}
                  </Text>
                  {result.pending > 0 && onOpenProposals && (
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
                      {busy ? <ActivityIndicator color={colors.onPrimary} /> : null}
                      <Text style={styles.primaryText}>{label}</Text>
                    </Pressable>
                  )}
                  {busy && !!progress && <Text accessibilityLiveRegion="polite" style={styles.sub}>{progress}</Text>}
                  {!!error && <Text style={styles.error}>{error.message}</Text>}
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
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: { width: '100%', maxWidth: 360, backgroundColor: colors.card, borderRadius: radius.card, borderWidth: 1, borderColor: colors.line, padding: spacing.xl, gap: spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleIcon: { width: 36, height: 36, borderRadius: 4, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center' },
  title: { flexShrink: 1, fontSize: font.title, fontWeight: '600', color: colors.ink },
  row: { flexDirection: 'row', gap: spacing.sm },
  sub: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  note: { fontSize: font.body, color: colors.mintDark, lineHeight: 20, fontWeight: '600' },
  error: { fontSize: font.body, color: colors.coral, lineHeight: 20, fontWeight: '600' },
  hint: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  textBox: { maxHeight: 200, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  text: { fontSize: font.body, color: colors.ink, lineHeight: 21 },
  primary: { minHeight: 52, borderRadius: radius.sm, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: spacing.sm },
  primaryText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  ghost: { minHeight: 48, borderRadius: radius.sm, backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
});
