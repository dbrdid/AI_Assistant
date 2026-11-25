// ============================================================
// CameraScreen.js — 카메라
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import { IconTile } from '../../../shared/components/Ui';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { ROUTES } from '../../../navigation/routes';
import { addMemo, getMemo, updateMemo } from '../../../data/memos/MemoStore';
import { addPhoto } from '../../../data/files/FileStore';
import { linkItems } from '../../../data/projects/ProjectStore';
import { recommendTargets } from '../../../services/ai/PhotoMatch';
import { describe, extract } from '../../../services/ai/ChatAttachments';
import { recommendMemoForPhoto, runtime } from '../../../integration/runtime';
import AccessibleFileImage from '../../memo/components/AccessibleFileImage';

function photoAnalysisError(error) {
  const messages = {
    CONSENT_REQUIRED: 'AI 설정에서 클라우드 AI 전송을 허용하면 사진을 분석할 수 있어요.',
    TRANSMISSION_DENIED: 'AI 설정에서 사진과 메모의 AI 분석을 허용해 주세요.',
    ROUTE_UNSUPPORTED: '사진 분석은 클라우드 AI에서 사용할 수 있어요.',
    INPUT_TOO_LONG: '메모와 사진 내용이 길어 한 번에 정리할 수 없어요.',
    SOURCE_CHANGED: '메모가 바뀌었어요. 사진을 다시 분석해 주세요.',
    NETWORK: '인터넷 연결을 확인한 뒤 다시 시도해 주세요.',
  };
  return messages[error?.code] || error?.message || '사진을 분석하지 못했어요.';
}

export default function CameraScreen({ navigation }) {
  const [perm, requestPerm] = useCameraPermissions();
  const camRef = useRef(null);
  const [facing, setFacing] = useState('back');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [shot, setShot] = useState(null);
  const [done, setDone] = useState(''); // 방금 한 일 안내 글자
  const [count, setCount] = useState(0); // 이번에 찍은 장 수
  const analysisAbort = useRef(null);

  useEffect(() => () => analysisAbort.current?.abort(), []);

  const updateShot = (fileId, patch) => setShot(current => current?.fileId === fileId ? { ...current, ...patch } : current);

  const analyzeShot = async (saved, controller) => {
    try {
      const item = describe({ uri: saved.uri, name: saved.name, mimeType: saved.mimeType });
      const extracted = await extract(item, controller.signal);
      if (controller.signal.aborted) return;
      if (extracted.status !== 'ready') throw new Error(extracted.error || '사진에서 글자를 읽지 못했어요');
      updateShot(saved.fileId, { status: 'matching', extractedText: extracted.text });

      const match = await recommendMemoForPhoto(extracted.text, controller.signal);
      if (controller.signal.aborted) return;
      if (!match) {
        updateShot(saved.fileId, { status: 'no_match' });
        return;
      }

      const draft = await runtime().ai.mergePhotoTextIntoMemo(match.memoId, extracted.text, {
        sourceRevision: match.revision,
        sessionId: match.sessionId,
        sessionGeneration: match.sessionGeneration,
        workspaceId: match.workspaceId,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      updateShot(saved.fileId, {
        status: 'ready',
        match,
        mergedBody: draft.body,
        sourceRevision: draft.sourceRevision,
      });
    } catch (e) {
      if (!controller.signal.aborted) {
        updateShot(saved.fileId, { status: 'error', analysisError: photoAnalysisError(e) });
      }
    }
  };

  const take = async () => {
    if (!camRef.current || busy || !ready) return;
    setBusy(true);
    setError('');
    try {
      const pic = await camRef.current.takePictureAsync({ quality: 0.7 });
      const saved = await addPhoto({ uri: pic.uri, name: '사진.jpg', mimeType: 'image/jpeg' });
      setCount((n) => n + 1);
      setDone('');
      const controller = new AbortController();
      analysisAbort.current = controller;
      setShot({
        fileId: saved.id,
        uri: saved.uri,
        name: saved.name,
        mimeType: saved.mimeType,
        saveDirectoryReference: saved.saveDirectoryReference,
        status: 'reading',
        extractedText: '',
        projectRecs: recommendTargets(new Date()).filter(rec => rec.type === 'project'),
      });
      void analyzeShot(saved, controller);
    } catch (e) {
      setError(e?.message || '사진 파일을 저장하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const finish = (msg) => {
    analysisAbort.current?.abort();
    analysisAbort.current = null;
    setShot(null);
    setDone(msg);
  };
  const putIntoProject = (rec) => {
    linkItems(rec.id, 'files', [shot.fileId]);
    finish(`'${rec.title}' 프로젝트에 넣었어요`);
  };
  const putIntoNewMemo = () => {
    const body = shot.extractedText ? `사진에서 읽은 내용\n\n${shot.extractedText}` : '';
    const m = addMemo({ title: '사진 메모', body, photos: [shot.fileId] });
    analysisAbort.current?.abort();
    analysisAbort.current = null;
    setShot(null);
    navigation.navigate(ROUTES.MemoEdit, { memoId: m.id });
  };
  const applyMemoDraft = () => {
    if (!shot || shot.status !== 'ready' || saving) return;
    const active = runtime();
    if (active.session.id !== shot.match.sessionId
      || active.session.generation !== shot.match.sessionGeneration
      || active.store.getCurrentWorkspace().id !== shot.match.workspaceId) {
      updateShot(shot.fileId, { status: 'error', analysisError: '계정이나 워크스페이스가 바뀌었어요. 사진은 기기에 저장되어 있어요.' });
      return;
    }
    const memo = getMemo(shot.match.memoId);
    if (!memo || memo.deletedAt || memo.revision !== shot.sourceRevision) {
      updateShot(shot.fileId, { status: 'error', analysisError: '메모가 바뀌었어요. 사진을 다시 분석해 주세요.' });
      return;
    }
    setSaving(true);
    try {
      updateMemo(memo.id, {
        body: shot.mergedBody,
        photos: memo.photos.includes(shot.fileId) ? memo.photos : [...memo.photos, shot.fileId],
      }, { expectedRevision: shot.sourceRevision });
      finish(`'${shot.match.title}' 메모를 업데이트했어요`);
    } catch (e) {
      updateShot(shot.fileId, { status: 'error', analysisError: e?.message || '메모에 반영하지 못했어요' });
    } finally {
      setSaving(false);
    }
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
          <IconTile icon="camera" size={72} iconSize={34} />
          <Text style={styles.title}>카메라 권한이 필요해요</Text>
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

      {/* 사진은 먼저 기기에 저장하고, AI 결과는 승인 전까지 초안으로만 둡니다. */}
      <Modal transparent visible={!!shot} animationType="slide" onRequestClose={() => finish('사진을 기기에 저장했어요')}>
        <View style={styles.backdrop}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
              {shot && <AccessibleFileImage file={shot} style={styles.preview} resizeMode="cover" accessibilityLabel="방금 찍은 사진" />}
              <Text style={styles.sheetTitle}>사진을 기기에 저장했어요</Text>
              {shot?.status === 'reading' && <View style={styles.progress}><ActivityIndicator color={colors.mintDark} /><Text style={styles.sheetSub}>AI가 사진 내용을 읽고 있어요…</Text></View>}
              {shot?.status === 'matching' && <View style={styles.progress}><ActivityIndicator color={colors.mintDark} /><Text style={styles.sheetSub}>관련 메모를 찾고 내용을 배치하고 있어요…</Text></View>}
              {shot?.status === 'ready' && (
                <>
                  <Text style={styles.sectionTitle}>관련 메모 추천</Text>
                  <View style={styles.rec}>
                    <Text style={styles.recIcon}>📝</Text>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.recTitle} numberOfLines={1}>{shot.match.title}</Text>
                      {!!shot.match.reason && <Text style={styles.recReason}>{shot.match.reason}</Text>}
                    </View>
                  </View>
                  <Text style={styles.sheetSub}>AI가 기존 내용과 사진 내용을 합친 초안이에요. 확인하고 수정한 뒤 반영하세요.</Text>
                  <TextInput
                    accessibilityLabel="메모 반영 미리보기"
                    multiline
                    value={shot.mergedBody}
                    onChangeText={value => updateShot(shot.fileId, { mergedBody: value })}
                    style={styles.draftInput}
                    textAlignVertical="top"
                  />
                  <Pressable accessibilityRole="button" disabled={saving} onPress={applyMemoDraft} style={[styles.applyButton, saving && { opacity: 0.5 }]}>
                    <Text style={styles.applyButtonText}>{saving ? '반영 중…' : '확인하고 메모에 반영'}</Text>
                  </Pressable>
                </>
              )}
              {shot?.status === 'no_match' && (
                <Text style={styles.sheetSub}>관련 메모를 찾지 못했어요. 사진은 기기에 저장되어 있으니 나중에 연결할 수 있어요.</Text>
              )}
              {shot?.status === 'error' && (
                <Text style={[styles.sheetSub, { color: colors.coral }]}>
                  {shot.analysisError || 'AI 분석을 완료하지 못했어요. 사진은 기기에 저장되어 있어요.'}
                </Text>
              )}
              {!!shot?.projectRecs?.length && (
                <>
                  <Text style={styles.sectionTitle}>프로젝트에 사진 첨부</Text>
                  {shot.projectRecs.map((r) => (
                    <Pressable key={r.id} accessibilityRole="button" accessibilityLabel={`${r.title} 프로젝트에 사진 첨부`} onPress={() => putIntoProject(r)} style={styles.rec}>
                      <Text style={styles.recIcon}>📁</Text>
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text style={styles.recTitle} numberOfLines={1}>{r.title}</Text>
                        <Text style={styles.recReason}>{r.reason}</Text>
                      </View>
                      <Text style={styles.recGo}>첨부</Text>
                    </Pressable>
                  ))}
                </>
              )}
              <Pressable accessibilityRole="button" onPress={putIntoNewMemo} style={styles.ghost}>
                <Text style={styles.ghostText}>{shot?.extractedText ? '추출한 내용으로 새 메모 만들기' : '새 메모에 사진 넣기'}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={() => finish('사진을 기기에 저장했어요')} style={styles.ghost}>
                <Text style={styles.ghostText}>보관함에만 두고 계속 찍기</Text>
              </Pressable>
            </ScrollView>
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
  title: { fontSize: font.title, fontWeight: '600', color: colors.ink },
  sub: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  primary: { minHeight: 52, paddingHorizontal: spacing.xl, borderRadius: radius.md, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  primaryText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  camWrap: { flex: 1, marginHorizontal: spacing.lg, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.black },
  cam: { flex: 1 },
  toast: { position: 'absolute', left: spacing.lg, right: spacing.lg, bottom: spacing.lg, padding: spacing.md, borderRadius: radius.md, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center' },
  toastText: { color: colors.white, fontSize: font.body, fontWeight: '500' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.xl, paddingVertical: spacing.lg },
  side: { width: 84, alignItems: 'center' },
  count: { fontSize: font.body, fontWeight: '500', color: colors.mintDark },
  shutter: { width: 76, height: 76, borderRadius: 4, borderWidth: 4, borderColor: colors.mintDark, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card },
  shutterInner: { width: 56, height: 56, borderRadius: 4, backgroundColor: colors.action },
  flip: { width: 52, height: 52, borderRadius: 4, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  flipText: { fontSize: 22 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '90%', backgroundColor: colors.cream, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: spacing.xl },
  sheetBody: { gap: spacing.md, paddingBottom: spacing.md },
  progress: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  sectionTitle: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink, marginTop: spacing.sm },
  draftInput: { minHeight: 180, maxHeight: 320, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, padding: spacing.md, fontSize: font.body, color: colors.ink, lineHeight: 20 },
  applyButton: { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.action, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.md },
  applyButtonText: { fontSize: font.bodyLg, fontWeight: '600', color: colors.onPrimary },
  preview: { width: '100%', height: 160, borderRadius: radius.md, backgroundColor: colors.line },
  sheetTitle: { fontSize: font.title, fontWeight: '600', color: colors.ink },
  sheetSub: { fontSize: font.body, color: colors.muted, lineHeight: 20 },
  rec: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 2, borderColor: colors.mint, minHeight: 64 },
  recIcon: { fontSize: 22 },
  recTitle: { fontSize: font.bodyLg, fontWeight: '600', color: colors.ink },
  recReason: { fontSize: font.caption, color: colors.muted },
  recGo: { fontSize: font.body, fontWeight: '600', color: colors.mintDark },
  ghost: { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  ghostText: { fontSize: font.bodyLg, fontWeight: '500', color: colors.ink },
});
