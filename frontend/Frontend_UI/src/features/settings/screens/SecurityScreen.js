// ============================================================
// SecurityScreen.js — 보안 및 권한 설정 (스토리보드 87장)
// ============================================================
// 1) 앱 화면 잠금 토글 → [저장하기]   2) 마이크·카메라·알림·기기 접근 권한 영역   3) 개인정보 처리방침
// ※ 권한의 "허용/거부" 실제 상태는 해당 기능(녹음·카메라·알림)을 만들 때 연결합니다. 지금은 [기기 설정 열기] 로 확인하게 함.
// ※ 앱 화면 잠금은 선택만 저장해요. 실제 잠금(생체/PIN)은 기기 인증 연결 후 적용돼요.

import React, { useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { getSettings, updateSettings } from '../../../data/settings/SettingsStore';
import { Row, SaveButton, SectionTitle, ToggleRow, useNotice } from '../../../shared/components/SettingsUi';

const PERMS = [
  { id: 'mic', label: '마이크 권한', why: '녹음에 사용' },
  { id: 'camera', label: '카메라 권한', why: '카메라로 일정 추출에 사용' },
  { id: 'noti', label: '알림 권한', why: '일정·브리핑 알림에 사용' },
  { id: 'files', label: '기기 접근 권한', why: '파일 선택에 사용' },
];

export default function SecurityScreen({ navigation }) {
  const saved = getSettings();
  const [appLock, setAppLock] = useState(saved.security.appLock);
  const [policy, setPolicy] = useState(false);
  const notice = useNotice();

  const openSystem = async () => {
    try {
      await Linking.openSettings();
    } catch (e) {
      notice.show('기기 설정을 열지 못했어요');
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="보안 및 권한 설정" onBack={navigation.goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <ToggleRow label="앱 화면 잠금" sub="앱을 열 때 인증을 요구해요 (기기 인증 연결 후 적용)" value={appLock} onValueChange={setAppLock} />

        <SectionTitle>기기 권한</SectionTitle>
        {PERMS.map((p) => (
          <Row key={p.id} label={p.label} sub={p.why} value="기기 설정" onPress={openSystem} />
        ))}

        <SectionTitle>약관</SectionTitle>
        <Row label="개인정보 처리방침" onPress={() => setPolicy(true)} />

        <SaveButton
          disabled={appLock === saved.security.appLock}
          onPress={() => {
            updateSettings('security', { appLock });
            notice.show('저장했어요');
          }}
        />
      </ScrollView>
      {notice.view}

      <Modal transparent visible={policy} animationType="fade" onRequestClose={() => setPolicy(false)}>
        <View style={styles.backdrop}>
          <View style={styles.dialog} accessibilityViewIsModal>
            <Text style={styles.dialogTitle}>개인정보 처리방침</Text>
            <ScrollView style={{ maxHeight: 280 }}>
              <Text style={styles.policy}>
                (임시 문구) 서비스 출시 전에 실제 개인정보 처리방침으로 교체해 주세요.{'\n\n'}
                • 수집 항목: 이름, 소속, 이메일, 사용자가 작성한 메모·일정·파일{'\n'}
                • 이용 목적: 서비스 제공, 기록 검색, AI 요약·브리핑 기능 제공{'\n'}
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
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  dialogTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  policy: { fontSize: font.body, color: colors.ink, lineHeight: 22 },
  closeBtn: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
