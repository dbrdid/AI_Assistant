// ============================================================
// CameraScreen.js — 카메라
// ============================================================

import React, { useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { addMemo, attachPhoto } from '../../../data/memos/MemoStore';
import { addPhoto } from '../../../data/files/FileStore';
import { linkItems } from '../../../data/projects/ProjectStore';
import { recommendTargets } from '../../../services/ai/PhotoMatch';

export default function CameraScreen({ navigation }) {
  const [perm, requestPerm] = useCameraPermissions();
  const camRef = useRef(null);
  const [facing, setFacing] = useState('back');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shot, setShot] = useState(null); // { fileId, uri, recs }
  const [done, setDone] = useState(''); // 방금 한 일 안내 글자
  const [count, setCount] = useState(0); // 이번에 찍은 장 수

  const take = async () => {
    if (!camRef.current || busy || !ready) return;
    setBusy(true);
    setError('');
    try {
      const pic = await camRef.current.takePictureAsync({ quality: 0.7 });
      const fileId = addPhoto({ uri: pic.uri });
      setCount((n) => n + 1);
      setDone('');
      setShot({ fileId, uri: pic.uri, recs: recommendTargets(new Date()) });
    } catch (e) {
      setError('사진을 찍지 못했어요. 다시 시도해 주세요.');
    }
    setBusy(false);
  };

  const finish = (msg) => {
    setShot(null);
    setDone(msg);
  };
  const putInto = (rec) => {
    if (rec.type === 'memo') attachPhoto(rec.id, shot.fileId);
    else linkItems(rec.id, 'files', [shot.fileId]);
    finish(rec.type === 'memo' ? `'${rec.title}' 메모에 넣었어요` : `'${rec.title}' 프로젝트에 넣었어요`);
  };
  const putIntoNewMemo = () => {
    const m = addMemo({ title: '사진 메모', body: '' });
    attachPhoto(m.id, shot.fileId);
    setShot(null);
    navigation.navigate(ROUTES.MemoEdit, { memoId: m.id });
  };

  // ---- 권한 확인 중 / 안내 ----
  if (!perm) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="카메라" onBack={navigation.goBack} />
        <View style={styles.center}><ActivityIndicator color={colors.mintDark} /></View>
      </View>
    );
  }
  if (!perm.granted) {
    return (
      <View style={styles.root}>
        <ScreenHeader title="카메라" onBack={navigation.goBack} />
        <View style={styles.center}>
          <Text style={styles.big}>📷</Text>
          <Text style={styles.title}>카메라 권한이 필요해요</Text>
          <Text style={styles.sub}>사진을 찍어 메모나 프로젝트에 바로 넣을 수 있어요.</Text>
          {perm.canAskAgain ? (
            <Pressable accessibilityRole="button" onPress={requestPerm} style={styles.primary}>
              <Text style={styles.primaryText}>권한 허용하기</Text>
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => Linking.openSettings().catch(() => {})} style={styles.primary}>
              <Text style={styles.primaryText}>설정에서 허용하기</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ScreenHeader title="카메라" onBack={navigation.goBack} />
      <View style={styles.camWrap}>
        <CameraView ref={camRef} style={styles.cam} facing={facing} onCameraReady={() => setReady(true)} />
        {!!done && (
          <View pointerEvents="none" style={styles.toast}><Text style={styles.toastText}>{done}</Text></View>
        )}
        {!!error && (
          <View pointerEvents="none" style={[styles.toast, { backgroundColor: colors.coral }]}><Text style={styles.toastText}>{error}</Text></View>
        )}
      </View>
      <View style={styles.bar}>
        <View style={styles.side}>
          {count > 0 && <Text style={styles.count}>{count}장 저장</Text>}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="사진 찍기"
          accessibilityState={{ disabled: !ready || busy }}
          onPress={take}
          disabled={!ready || busy}
          style={[styles.shutter, (!ready || busy) && { opacity: 0.4 }]}
        >
          <View style={styles.shutterInner} />
        </Pressable>
        <View style={styles.side}>
          <Pressable accessibilityRole="button" accessibilityLabel="앞뒤 카메라 전환" onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))} style={styles.flip}>
            <Text style={styles.flipText}>🔄</Text>
          </Pressable>
        </View>
      </View>

      {/* 찍은 직후: 어울리는 곳 추천 */}
      <Modal transparent visible={!!shot} animationType="slide" onRequestClose={() => finish('보관함에 저장했어요')}>
        <View style={styles.backdrop}>
          <View style={styles.sheet} accessibilityViewIsModal>
            {shot && <Image source={{ uri: shot.uri }} style={styles.preview} resizeMode="cover" accessibilityLabel="방금 찍은 사진" />}
            <Text style={styles.sheetTitle}>사진을 저장했어요</Text>
            <Text style={styles.sheetSub}>{shot && shot.recs.length ? '이 사진이 어울릴 것 같은 곳이에요' : '어울리는 곳을 찾지 못했어요. 새 메모에 넣거나 보관함에 둘 수 있어요.'}</Text>
            {shot && shot.recs.map((r) => (
              <Pressable key={`${r.type}${r.id}`} accessibilityRole="button" accessibilityLabel={`${r.title}에 넣기. ${r.reason}`} onPress={() => putInto(r)} style={styles.rec}>
                <Text style={styles.recIcon}>{r.type === 'memo' ? '📝' : '📁'}</Text>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.recTitle} numberOfLines={1}>{r.title}</Text>
                  <Text style={styles.recReason}>{r.reason}</Text>
                </View>
                <Text style={styles.recGo}>넣기</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={putIntoNewMemo} style={styles.ghost}>
              <Text style={styles.ghostText}>새 메모에 넣기</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => finish('보관함에 저장했어요')} style={styles.ghost}>
              <Text style={styles.ghostText}>보관함에만 두고 계속 찍기</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  big: { fontSize: 56 },
  title: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  sub: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  primary: { minHeight: 52, paddingHorizontal: spacing.xl, borderRadius: radius.md, backgroundColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  primaryText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.white },
  camWrap: { flex: 1, marginHorizontal: spacing.lg, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.black },
  cam: { flex: 1 },
  toast: { position: 'absolute', left: spacing.lg, right: spacing.lg, bottom: spacing.lg, padding: spacing.md, borderRadius: radius.md, backgroundColor: 'rgba(38,57,53,0.92)', alignItems: 'center' },
  toastText: { color: colors.white, fontSize: font.body, fontWeight: '700' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg },
  side: { width: 84, alignItems: 'center' },
  count: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.white },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.mintDark },
  flip: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  flipText: { fontSize: 22 },
  backdrop: { flex: 1, backgroundColor: 'rgba(38,57,53,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.cream, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.xl, gap: spacing.md },
  preview: { width: '100%', height: 160, borderRadius: radius.md, backgroundColor: colors.line },
  sheetTitle: { fontSize: font.title, fontWeight: '800', color: colors.ink },
  sheetSub: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  rec: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 2, borderColor: colors.mint, minHeight: 64 },
  recIcon: { fontSize: 22 },
  recTitle: { fontSize: font.bodyLg, fontWeight: '800', color: colors.ink },
  recReason: { fontSize: font.caption, color: colors.muted },
  recGo: { fontSize: font.body, fontWeight: '800', color: colors.mintDark },
  ghost: { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
});
