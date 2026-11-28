// ============================================================
// RecordSheet.js — 녹음이 끝난 뒤 홈에 뜨는 창
// ============================================================


import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import Svg, { Path, Rect } from 'react-native-svg';
import Icon from '../../../shared/components/Icon';
import { SheetModal } from '../../../shared/components/Motion';
import { palette, styles as sheetStyles } from '../../stella/theme';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { finishTranscription, newTranscribeJob, transcribeRecording } from '../../../services/ai/Transcribe';
import { analyzeText } from '../../../services/ai/AiAnalyze';
import { titleRecording } from '../../../services/ai/AiTitle';
import { addMemo } from '../../../data/memos/MemoStore';
import { setAiTransmission } from '../../../data/settings/SettingsStore';
import { maybeRuntime } from '../../../integration/runtime';

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
      style={styles.actionRow}
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
  const conversion = useRef(null);
  const [progress, setProgress] = useState('');   // 긴 녹음: 나누기, 구간 올리기, 서버 변환 진행 문구
  const lastSheet = useRef(null);
  if (sheet) lastSheet.current = sheet;
  useEffect(() => {
    if (!sheet) return;
    setPhase('idle'); setError(null); setResult(null); setProgress('');
    job.current = sheet?.uri ? newTranscribeJob(sheet.uri, sheet.seconds) : null;
    return () => {
      job.current = null;
      conversion.current = null;
    };
  }, [sheet]);
  const content = sheet ?? lastSheet.current;
  if (!content) return null;
  const busy = phase === 'upload' || phase === 'analyze';

  const convert = async () => {
    const activeJob = job.current;
    const owner = maybeRuntime();
    if (sheet.state !== 'saved' || conversion.current || !activeJob || !owner) return;
    const workspaceId = owner.store.getCurrentWorkspace().id;
    conversion.current = activeJob;
    const isCurrent = () => conversion.current === activeJob;
    const canSave = () => maybeRuntime() === owner && owner.store.getCurrentWorkspace().id === workspaceId;
    setError(null);
    setPhase('upload');
    try {
      const r = await transcribeRecording(activeJob, { onProgress: p => { if (isCurrent()) setProgress(p.text); } });
      if (!isCurrent()) return;
      job.current = r.job;
      if (!r.ok) { setError({ code: r.code, message: r.message }); setPhase('error'); return; }
      const text = r.text.trim();
      if (!text) { setError({ code: 'EMPTY', message: '녹음에서 알아들을 수 있는 말이 없었어요' }); setPhase('error'); return; }
      let memoId = null;
      const timeTitle = memoTitleFor();
      try {
        if (canSave()) memoId = addMemo({ title: timeTitle, body: text.slice(0, 100_000) })?.id ?? null;
      } catch { /* 저장 실패해도 글은 보여 줌 */ }
      // 빠진 구간이 있으면 서버의 임시 전사문을 남겨 다시 시도할 수 있게 한다.
      if (memoId && r.complete) void finishTranscription(r.job);
      const missing = r.missing ?? 0;
      setResult({ text, memoId, missing });
      if (!memoId) { setPhase('done'); return; }
      setPhase('analyze');
      // 제목이 바뀌어도 제안이 참조하는 원문 버전이 어긋나지 않도록 먼저 확정한다.
      await titleRecording(memoId, timeTitle);
      if (!isCurrent()) return;
      const analysis = canSave()
        ? await analyzeText({ sourceType: 'memo', sourceId: memoId, explicit: true, requireReview: true })
        : { error: '작업 공간이 바뀌어 분석하지 않았어요.' };
      if (!isCurrent()) return;
      setResult({ text, memoId, missing, pending: analysis.pending ?? analysis.added ?? 0, analyzeError: analysis.error });
      setPhase('done');
    } catch (error) {
      if (isCurrent()) {
        setError({ code: 'TRANSCRIPTION_FAILED', message: error.message || '녹음을 정리하지 못했어요.' });
        setPhase('error');
      }
    } finally {
      if (isCurrent()) {
        conversion.current = null;
        setProgress('');
      }
    }
  };
  // 외부 AI 보내기 동의 후 바로 다시 변환
  const allowAndConvert = async () => {
    const activeJob = job.current;
    try { await setAiTransmission('external', true); } catch (e) { setError({ code: 'CONSENT', message: e.message }); return; }
    if (activeJob && job.current === activeJob) void convert();
  };
  const consentNeeded = error && (error.code === 'CONSENT_REQUIRED' || error.code === 'TRANSMISSION_DENIED');
  const label = phase === 'upload' ? '녹음을 받아 적는 중…' : phase === 'analyze' ? '일정과 할 일 찾는 중…' : phase === 'error' ? '다시 시도' : '텍스트로 정리하기';

  const heading = {
    saved: '녹음을 저장했어요',
    save_error: '녹음 파일을 저장하지 못했어요',
    denied: '마이크 권한이 필요해요',
    error: '녹음하지 못했어요',
  }[content.state];

  return (
    <SheetModal visible={!!sheet} onClose={onClose} label="음성 메모">
      <View style={sheetStyles.handle} />
      <View style={sheetStyles.titleRow}>
        <Text accessibilityRole="header" style={[sheetStyles.sectionTitle, styles.title]}>{heading}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="음성 메모 닫기" onPress={onClose} style={sheetStyles.iconButton}>
          <Icon name="x" size={20} color={palette.muted} />
        </Pressable>
      </View>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
        {(content.state === 'saved' || content.state === 'save_error') && (
          <>
            <Text style={styles.sub}>{fmt(content.seconds || 0)}{content.folder ? `, ${content.folder}` : ''}</Text>
            {content.state === 'save_error' && (
              <>
                <Text accessibilityLiveRegion="polite" style={styles.error}>{content.saveError || '저장 위치의 권한을 확인해 주세요.'}</Text>
                <Pressable accessibilityRole="button" disabled={content.saving || busy} onPress={onRetrySave} style={[styles.primary, (content.saving || busy) && { opacity: 0.5 }]}>
                  {content.saving ? <ActivityIndicator color={colors.onPrimary} /> : null}
                  <Text style={styles.primaryText}>{content.saving ? '저장 중…' : '저장 다시 시도'}</Text>
                </Pressable>
              </>
            )}
            <Player uri={content.uri} />
            {phase === 'done' && result ? (
              <>
                <View style={styles.textBox}>
                  <Text style={styles.text} selectable>{result.text}</Text>
                </View>
                {result.missing > 0 && <Text style={styles.error}>{result.missing}개 구간은 변환하지 못했어요. 글 안에 표시된 자리를 확인해 주세요.</Text>}
                <Text style={styles.note}>
                  {result.memoId ? '메모로 저장했어요. ' : '메모로 저장하지 못했어요. 글을 길게 눌러 복사해 주세요. '}
                  {result.memoId && (result.analyzeError ? '일정과 할 일은 찾지 못했어요.' : result.pending > 0 ? `AI 제안 ${result.pending}건을 만들었어요.` : '찾은 일정이나 할 일은 없어요.')}
                </Text>
                {result.pending > 0 && onOpenProposals && (
                  <Pressable accessibilityRole="button" onPress={onOpenProposals} style={styles.primary}><Text style={styles.primaryText}>AI 제안 확인하기</Text></Pressable>
                )}
                {!!result.memoId && onOpenMemo && (
                  <Pressable accessibilityRole="button" onPress={() => onOpenMemo(result.memoId)} style={styles.ghost}><Text style={styles.ghostText}>메모 열기</Text></Pressable>
                )}
              </>
            ) : content.state === 'saved' ? (
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
            ) : null}
            {!!content.fileId && (
              <Pressable accessibilityRole="button" onPress={onOpenFiles} style={styles.actionRow}>
                <Icon name="folder" size={18} color={palette.muted} />
                <Text style={styles.ghostText}>파일 보관함 보기</Text>
              </Pressable>
            )}
          </>
        )}
        {content.state === 'denied' && (
          <>
            <Text style={styles.sub}>녹음을 하려면 마이크 권한을 허용해 주세요.</Text>
            <Pressable accessibilityRole="button" onPress={() => { onClose(); Linking.openSettings().catch(() => {}); }} style={styles.primary}>
              <Text style={styles.primaryText}>설정 열기</Text>
            </Pressable>
          </>
        )}
        {content.state === 'error' && <Text style={styles.sub}>다시 시도해 주세요. 계속되면 마이크가 다른 앱에서 쓰이고 있는지 확인해 주세요.</Text>}
      </ScrollView>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  title: { flexShrink: 1 },
  content: { paddingTop: 4, gap: spacing.sm },
  actionRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm },
  sub: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  note: { fontSize: font.body, color: colors.mintDark, lineHeight: 20, fontWeight: '600' },
  error: { fontSize: font.body, color: colors.coral, lineHeight: 20, fontWeight: '600' },

  textBox: { padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.card },
  text: { fontSize: font.body, color: colors.ink, lineHeight: 21 },
  primary: { minHeight: 52, borderRadius: radius.sm, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: spacing.sm },
  primaryText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  ghost: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
});
