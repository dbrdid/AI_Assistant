// ============================================================
// SecurityScreen.js — 보안 및 권한 설정
// ============================================================


import { useState } from 'react';
import { Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { Group, Row, SectionTitle, ToggleRow, useNotice } from '../../../shared/components/SettingsUi';
import { updateSettings, useSettings } from '../../../data/settings/SettingsStore';
import { authenticateFingerprint, supportsFingerprintOnly } from '../../../services/device/FingerprintAuth';

const PERMS = [
  { id: 'mic', icon: 'mic', label: '마이크 권한', why: '녹음에 사용' },
  { id: 'camera', icon: 'camera', label: '카메라 권한', why: '카메라로 일정 추출에 사용' },
  { id: 'media', icon: 'image', label: '사진과 동영상 권한', why: '기기 사진 보관함에서 불러오기에 사용' },
  { id: 'noti', icon: 'bell', label: '알림 권한', why: '일정과 브리핑 알림에 사용' },
  { id: 'files', icon: 'folder', label: '기기 접근 권한', why: '파일 선택에 사용' },
];

export default function SecurityScreen({ navigation }) {
  const [policy, setPolicy] = useState(false);
  const notice = useNotice();
  const [lockBusy, setLockBusy] = useState(false);
  const settings = useSettings();
  const lockEnabled = Platform.OS !== 'web' && Boolean(settings.security?.lock);

  const setAppLock = async enabled => {
    if (lockBusy) return;
    if (Platform.OS === 'web') {
      notice.show('앱 잠금은 Android와 iOS 앱에서 설정할 수 있어요');
      return;
    }
    setLockBusy(true);
    try {
      if (enabled) {
        const [supported, enrolled] = await Promise.all([
          supportsFingerprintOnly(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (!supported) {
          notice.show('지문 센서가 있는 기기에서 사용할 수 있어요. Face ID만 지원하는 기기에서는 사용할 수 없어요.');
          return;
        }
        if (!enrolled) {
          notice.show('기기 설정에서 지문을 먼저 등록해 주세요');
          return;
        }
      }

      const result = await authenticateFingerprint(enabled ? '지문으로 앱 잠금 설정' : '지문으로 앱 잠금 해제');
      if (!result.success) {
        if (result.error !== 'user_cancel' && result.error !== 'app_cancel') {
          notice.show(result.error === 'fingerprint_only_unavailable'
            ? '지문 인증만 지원하는 기기에서 사용할 수 있어요.'
            : '지문 인증에 실패했어요. 다시 시도해 주세요');
        }
        return;
      }

      updateSettings('security', { lock: enabled, biometric: enabled });
      notice.show(enabled ? '앱 잠금을 켰어요' : '앱 잠금을 껐어요');
    } catch (e) {
      notice.show(e?.message || '앱 잠금 설정을 변경하지 못했어요');
    } finally {
      setLockBusy(false);
    }
  };


  const openSystem = async () => {
    if (Platform.OS === 'web') return notice.show('웹에서는 브라우저 주소창 왼쪽의 사이트 설정에서 권한을 바꿀 수 있어요');
    try {
      await Linking.openSettings();
    } catch (e) {
      notice.show('기기 설정을 열지 못했어요');
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="보안 및 권한 설정" onBack={navigation.goBack} />
      <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.content}>
        <ToggleRow
          icon="lock"
          label="앱 화면 잠금"
          sub={Platform.OS === 'web' ? 'Android와 iOS 앱에서 설정할 수 있어요' : '지문 센서가 필요해요. Face ID 전용 기기는 지원하지 않아요.'}
          value={lockEnabled}
          disabled={lockBusy || Platform.OS === 'web'}
          onValueChange={setAppLock}
        />

        <SectionTitle>기기 권한</SectionTitle>
        <Group>
          {PERMS.map((p) => (
            <Row key={p.id} icon={p.icon} label={p.label} sub={p.why} value="기기 설정" onPress={openSystem} />
          ))}
        </Group>

        <SectionTitle>약관</SectionTitle>
        <Row icon="file" label="개인정보 처리방침" onPress={() => setPolicy(true)} />
      </ScrollView>
      {notice.view}

      <Modal transparent visible={policy} animationType="fade" onRequestClose={() => setPolicy(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>개인정보 처리방침</Text>
            <ScrollView showsVerticalScrollIndicator={false} showsHorizontalScrollIndicator={false} style={{ maxHeight: 280 }}>
              <Text style={styles.policy}>
                (임시 문구) 서비스 출시 전에 실제 개인정보 처리방침으로 교체해 주세요.{'\n\n'}
                • 수집 항목: 이름, 소속, 이메일, 사용자가 작성한 메모, 일정, 파일{'\n'}
                • 이용 목적: 서비스 제공, 기록 검색, AI 요약과 브리핑 기능 제공{'\n'}
                • 보관 기간: 회원 탈퇴 시 지체 없이 삭제{'\n'}
                • 문의: 앱 내 설정 {'>'} 문의
              </Text>
            </ScrollView>
            <Pressable accessibilityRole="button" onPress={() => setPolicy(false)} style={styles.closeBtn}>
              <Text style={styles.closeText}>닫기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.card, padding: spacing.xl, gap: spacing.md },
  dialogTitle: { fontSize: font.title, fontWeight: '600', color: colors.ink },
  policy: { fontSize: font.body, color: colors.ink, lineHeight: 22 },
  closeBtn: { minHeight: 46, borderRadius: radius.sm, borderWidth: 0, borderColor: colors.line, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
});
