// ============================================================
// ErrorViews.js — 오류 안내 화면/창 모음 (스토리보드 106 · 107 · 108 · 결제 실패 팝업)
// ============================================================
//  NetworkErrorView   : "네트워크 연결을 확인해주세요"  [다시 시도] [오프라인 모드로 이용]
//  ServerErrorView    : "서버 일시적 오류"             [메인 화면으로 이동]
//  AnalysisFailedView : "분석에 실패했습니다"          [다시 분석하기] [수동으로 등록]
//  ErrorModal         : 위 세 가지를 "지금 보던 화면 위에 창으로" 띄움 (작성 중이던 내용이 그대로 남아요)
//  PaymentFailedDialog: "결제 실패 / 결제수단을 다시 확인해 주세요" [확인]

import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { isOnline, setOfflineMode } from '../../../services/device/Network';

function Layout({ icon, title, message, primary, secondary, busy }) {
  return (
    <View style={styles.box}>
      <View style={styles.iconCircle}><Text style={styles.icon}>{icon}</Text></View>
      <Text style={styles.title} accessibilityRole="header">{title}</Text>
      {!!message && <Text style={styles.msg}>{message}</Text>}
      {primary && (
        <Pressable accessibilityRole="button" disabled={busy} onPress={primary.onPress} style={[styles.primary, busy && { opacity: 0.5 }]}>
          <Text style={styles.primaryText}>{busy ? '확인하는 중…' : primary.label}</Text>
        </Pressable>
      )}
      {secondary && (
        <Pressable accessibilityRole="button" onPress={secondary.onPress} style={styles.ghost}>
          <Text style={styles.ghostText}>{secondary.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

// 다시 시도: 인터넷이 되는지 먼저 확인해서, 되면 onRetry, 아직이면 안내
export function NetworkErrorView({ onRetry, onOffline }) {
  const [busy, setBusy] = useState(false);
  const [still, setStill] = useState(false);
  const retry = async () => {
    setBusy(true);
    setStill(false);
    const ok = await isOnline();
    setBusy(false);
    if (ok) {
      setOfflineMode(false);
      onRetry && onRetry();
    } else {
      setStill(true);
    }
  };
  return (
    <Layout
      icon="📡"
      title="네트워크 연결을 확인해주세요"
      message={still ? '아직 연결되지 않았어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.' : '인터넷 연결 후 다시 시도할 수 있습니다.'}
      primary={{ label: '다시 시도', onPress: retry }}
      secondary={{ label: '오프라인 모드로 이용', onPress: () => { setOfflineMode(true); onOffline && onOffline(); } }}
      busy={busy}
    />
  );
}

export function ServerErrorView({ onHome, title = '서버 일시적 오류', message = '서버에 문제가 발생했습니다.\n작성 중이던 데이터는 안전하게 임시 저장되었습니다.', homeLabel = '메인 화면으로 이동' }) {
  return <Layout icon="🛠️" title={title} message={message} primary={{ label: homeLabel, onPress: onHome }} />;
}

export function AnalysisFailedView({ onRetry, onManual, message = '일정이나 할 일을 찾지 못했어요.' }) {
  return (
    <Layout
      icon="🔍"
      title="분석에 실패했습니다"
      message={message}
      primary={{ label: '다시 분석하기', onPress: onRetry }}
      secondary={{ label: '수동으로 등록', onPress: onManual }}
    />
  );
}

// 화면 위에 창으로 띄우기. kind: 'network' | 'server' | 'analysis'
//   onClose : 창 닫기(바깥/뒤로가기)   onRetry : 다시 시도/다시 분석 성공 시   onHome : 메인 화면으로   onManual : 수동 등록
export function ErrorModal({ kind, visible, onClose, onRetry, onHome, onManual, message }) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          {kind === 'network' && <NetworkErrorView onRetry={() => { onClose && onClose(); onRetry && onRetry(); }} onOffline={onClose} />}
          {kind === 'server' && (
            <ServerErrorView
              title="서버 일시적 오류"
              message={message || '서버에 문제가 발생했어요. 잠시 뒤 다시 시도해 주세요.'}
              homeLabel="닫기"
              onHome={onClose}
            />
          )}
          {kind === 'analysis' && <AnalysisFailedView message={message} onRetry={() => { onClose && onClose(); onRetry && onRetry(); }} onManual={() => { onClose && onClose(); onManual && onManual(); }} />}
          {kind === 'server' && onHome && (
            <Pressable accessibilityRole="button" onPress={() => { onClose && onClose(); onHome(); }} style={[styles.ghost, { marginTop: spacing.sm }]}>
              <Text style={styles.ghostText}>메인 화면으로 이동</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

export function PaymentFailedDialog({ visible, onConfirm }) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onConfirm}>
      <View style={styles.backdrop}>
        <View style={[styles.card, { gap: spacing.md }]} accessibilityViewIsModal>
          <Text style={styles.title}>결제 실패</Text>
          <Text style={styles.msg}>결제수단을 다시 확인해 주세요</Text>
          <Pressable accessibilityRole="button" onPress={onConfirm} style={styles.primary}>
            <Text style={styles.primaryText}>확인</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  box: { alignItems: 'center', gap: spacing.md, width: '100%' },
  iconCircle: { width: 84, height: 84, borderRadius: 42, backgroundColor: colors.mintSoft, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.sm },
  icon: { fontSize: 38 },
  title: { fontSize: font.title, fontWeight: '800', color: colors.ink, textAlign: 'center' },
  msg: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 21 },
  primary: { width: '100%', minHeight: 52, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  ghost: { width: '100%', minHeight: 52, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  card: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, alignItems: 'center' },
});
