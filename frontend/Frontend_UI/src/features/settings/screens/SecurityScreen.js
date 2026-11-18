// ============================================================
// SecurityScreen.js — 보안 및 권한 설정
// ============================================================


import React, { useState } from 'react';
import { Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { Group, Row, SectionTitle, ToggleRow, useNotice } from '../../../shared/components/SettingsUi';

const PERMS = [
  { id: 'mic', icon: 'mic', label: '마이크 권한', why: '녹음에 사용' },
  { id: 'camera', icon: 'camera', label: '카메라 권한', why: '카메라로 일정 추출에 사용' },
  { id: 'noti', icon: 'bell', label: '알림 권한', why: '일정·브리핑 알림에 사용' },
  { id: 'files', icon: 'folder', label: '기기 접근 권한', why: '파일 선택에 사용' },
];

export default function SecurityScreen({ navigation }) {
  const [policy, setPolicy] = useState(false);
  const notice = useNotice();

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
      <ScrollView contentContainerStyle={styles.content}>
        {/* 기기 인증(생체·PIN) 모듈이 아직 없어서, 켜도 잠기지 않는 설정은 저장하지 않음 */}
        <ToggleRow icon="lock" label="앱 화면 잠금" sub="준비 중 · 기기 인증(지문·얼굴·PIN) 연결 후 켤 수 있어요" value={false} disabled />

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
  dialog: { width: '100%', maxWidth: 360, backgroundColor: colors.cream, borderRadius: radius.card, padding: spacing.xl, gap: spacing.md },
  dialogTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  policy: { fontSize: font.body, color: colors.ink, lineHeight: 22 },
  closeBtn: { minHeight: 46, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: 'center', justifyContent: 'center' },
  closeText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
