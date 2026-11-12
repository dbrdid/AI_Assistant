// ============================================================
// RecordSheet.js — 녹음이 끝난 뒤(또는 실패했을 때) 홈에 뜨는 창
// ============================================================
// state:
//   'saved'  : "녹음을 저장했어요" + 길이 + [듣기] + [텍스트로 정리하기] + [보관함 보기]
//   'denied' : "마이크 권한이 필요해요" + [설정 열기]
//   'error'  : "녹음하지 못했어요"
// props: sheet({ state, uri, seconds }) | null, onClose(), onOpenFiles()

import React, { useEffect, useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { transcribeRecording } from '../../../services/ai/Transcribe';
import { analyzeText } from '../../../services/ai/AiAnalyze';

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
      style={styles.ghost}
    >
      <Text style={styles.ghostText}>{status.playing ? '⏸  일시정지' : '▶  듣기'}</Text>
    </Pressable>
  );
}

export default function RecordSheet({ sheet, onClose, onOpenFiles, onOpenProposals }) {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setMsg(''), [sheet]);
  if (!sheet) return null;

  const convert = async () => {
    setBusy(true);
    const r = await transcribeRecording(sheet.uri);
    if (!r.ok) {
      setBusy(false);
      setMsg('음성을 글자로 바꾸는 기능은 서버가 연결되면 사용할 수 있어요.\n녹음은 파일 보관함에 저장돼 있어요.');
      return;
    }
    const a = await analyzeText({ sourceType: 'record', sourceId: sheet.fileId || '', sourceTitle: '녹음', text: r.text });
    setBusy(false);
    setMsg(a.added > 0 ? `AI 제안 ${a.added}건을 만들었어요.` : '찾은 일정이나 할 일이 없어요.');
  };

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          {sheet.state === 'saved' && (
            <>
              <Text style={styles.title}>🎙  녹음을 저장했어요</Text>
              <Text style={styles.sub}>{fmt(sheet.seconds || 0)} · 파일 보관함에 보관돼요</Text>
              <Player uri={sheet.uri} />
              <Pressable accessibilityRole="button" disabled={busy} onPress={convert} style={[styles.primary, busy && { opacity: 0.5 }]}>
                <Text style={styles.primaryText}>{busy ? '정리하는 중…' : '텍스트로 정리하기'}</Text>
              </Pressable>
              {!!msg && <Text style={styles.note}>{msg}</Text>}
              <Pressable accessibilityRole="button" onPress={onOpenFiles} style={styles.ghost}><Text style={styles.ghostText}>파일 보관함 보기</Text></Pressable>
            </>
          )}
          {sheet.state === 'denied' && (
            <>
              <Text style={styles.title}>⚠  마이크 권한이 필요해요</Text>
              <Text style={styles.sub}>녹음을 하려면 마이크 권한을 허용해 주세요.</Text>
              <Pressable accessibilityRole="button" onPress={() => { onClose(); Linking.openSettings().catch(() => {}); }} style={styles.primary}>
                <Text style={styles.primaryText}>설정 열기</Text>
              </Pressable>
            </>
          )}
          {sheet.state === 'error' && (
            <>
              <Text style={styles.title}>⚠  녹음하지 못했어요</Text>
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
  card: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  title: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  sub: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  note: { fontSize: font.body, color: colors.mintDark, lineHeight: 20, fontWeight: '600' },
  primary: { minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  ghost: { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
