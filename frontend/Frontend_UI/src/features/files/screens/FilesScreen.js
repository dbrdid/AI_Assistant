// ============================================================
// FilesScreen.js — 파일 보관함 화면
// ============================================================

import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import ScreenHeader from '../../../shared/components/ScreenHeader';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { STORAGE_INFO } from '../../../data/memos/MemoStore';
import {
  canRecognize, cloudAvailable, deleteCloudFile, deleteFile, getFiles, openCloudFile, pickAndAddFiles, pickAndUploadCloudFiles,
  recognizeFile, useCloudFiles, useFiles,
} from '../../../data/files/FileStore';
import { alertUser } from '../../../data/alert';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import Icon from '../../../shared/components/Icon';
import { Chip, DashedButton } from '../../../shared/components/Ui';

// 파일 종류별 아이콘
const KIND_ICON = { 슬라이드: 'grid', PDF: 'file', 문서: 'file', 이미지: 'image', 표: 'grid', 녹음: 'mic' };
// 크기 · 날짜 표시
const sizeText = (n) => (!Number.isFinite(n) ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
const dateText = (ms) => { if (!ms) return ''; const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };

export default function FilesScreen({ navigation, route }) {

  useFiles(); // 파일이 추가/삭제되면 화면 다시 그리기
  useCloudFiles(); // 공유 공간 파일이 동기화되면 다시 그리기
  const [busy, setBusy] = useState(false);
  const [delId, setDelId] = useState(null);
  const [reading, setReading] = useState({}); // 내용 인식 중인 파일 id → true
  const [readError, setReadError] = useState({}); // 파일 id → 실패 이유
  const focusId = route.params?.focusId; // 강조하고 이동할 파일 번호 (없을 수 있음)
  const shared = cloudAvailable(); // 지금 공간이 공유 공간인지 (클라우드 파일은 공유 공간에만 있음)

  // 지금 보고 있는 보관 위치. 검색/AI에서 이동해 온 파일이 클라우드에 있으면 그 탭부터 열기
  const [tab, setTab] = useState(() => {
    const cloudHit = focusId && getFiles('cloud').some((f) => f.id === focusId);
    return cloudHit ? 'cloud' : 'local';
  });
  const files = getFiles(tab); // 선택한 탭의 파일들
  const localStorageHelp = Platform.OS === 'web'
    ? '브라우저는 원본 파일 접근을 유지할 수 없어 앱 저장소에 사본을 보관해요.'
    : '처음 저장할 때 다운로드 폴더를 한 번 선택하면 앱에서 만든 사진·녹음과 다운로드 파일이 그곳에 저장돼요. 그곳에 저장할 수 없으면 ‘오늘의 플래너’ 폴더를 만들어 사용해요. 기기에서 가져온 파일은 원본을 참조하므로 복사하지 않으며, 원본이 이동·삭제되거나 권한이 만료되면 다시 선택해야 할 수 있어요.';
  const addFiles = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (tab === 'cloud') {
        const r = await pickAndUploadCloudFiles();
        if (r.failed.length) {
          alertUser(r.added ? '일부 파일을 올리지 못했어요' : '파일을 올리지 못했어요', r.failed.map((f) => `${f.name}: ${f.message}`).join('\n'));
        }
      } else {
        await pickAndAddFiles();
      }
    } catch (e) {
      alertUser('파일을 추가하지 못했어요', e?.message || '다시 시도해 주세요.');
    }
    setBusy(false);
  };
  const recognize = async (id) => {
    if (reading[id]) return;
    setReading((r) => ({ ...r, [id]: true }));
    setReadError((r) => ({ ...r, [id]: '' }));
    try { await recognizeFile(id); }
    catch (e) { setReadError((r) => ({ ...r, [id]: e?.message || '내용을 읽지 못했어요' })); }
    setReading((r) => ({ ...r, [id]: false }));
  };
  const open = async (id) => {
    try { await openCloudFile(id); } catch (e) { alertUser('파일을 열지 못했어요', e.message); }
  };
  const delIsCloud = delId !== null && getFiles('cloud').some((f) => f.id === delId);
  const [highlightId, setHighlightId] = useState(focusId || null);
  const scrollRef = useRef(null);

  // 2.5초 뒤에 강조를 해제
  useEffect(() => {
    if (!focusId) return undefined;
    const id = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(id);
  }, [focusId]);

  // 강조할 카드의 위치로 스크롤
  const onCardLayout = (id, e) => {
    if (id === focusId && scrollRef.current) {
      scrollRef.current.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - spacing.lg), animated: true });
    }
  };

  return (
    <View style={styles.root}>
      <ScreenHeader title="파일 보관함" onBack={navigation.goBack} />
      <ScrollView ref={scrollRef} contentContainerStyle={styles.list}>
        {/* 내 기기 파일 / 공유 클라우드 탭 */}
        <View style={styles.tabs}>
          {['local', 'cloud'].map((key) => {
            const on = tab === key;
            return <Chip key={key} label={`${STORAGE_INFO[key].label} ${getFiles(key).length}`} active={on} onPress={() => setTab(key)} />;
          })}
        </View>
        <Text style={styles.count}>{STORAGE_INFO[tab].desc}</Text>
        <Text style={styles.storageHelp}>
          {tab === 'local'
            ? localStorageHelp
            : shared
              ? '여기에 올린 파일은 공유 공간에 보관되며, 해당 공간의 멤버가 함께 볼 수 있어요.'
              : '메뉴 > 워크스페이스 전환에서 공유 공간을 선택하면 멤버와 함께 쓸 파일을 올릴 수 있어요.'}
        </Text>

        {(tab === 'local' || shared) && (
          <DashedButton
            label={busy
              ? (tab === 'cloud' ? '공유 공간에 올리는 중…' : '기기 파일 연결 중…')
              : tab === 'cloud' ? '공유 공간에 올리기' : '기기에서 파일 선택'}
            onPress={addFiles}
            style={busy && { opacity: 0.5 }}
          />
        )}

        {files.length === 0 && (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>
              {tab === 'cloud' ? (shared ? '이 공간에 올린 파일이 없어요' : '공유 클라우드는 공유 공간에서 쓸 수 있어요') : '표시할 파일이 없어요'}
            </Text>
            <Text style={styles.emptySub}>
              {tab === 'cloud'
                ? shared
                  ? '공유 공간에 파일을 올리면 여기에서 확인할 수 있어요. 파일당 50MB까지 올릴 수 있어요.'
                  : '공유 공간으로 전환한 뒤 파일을 올려 보세요.'
                : '기기에서 파일을 선택하거나 앱에서 사진·녹음을 만들면 여기에 표시돼요.'}
            </Text>
          </View>
        )}

        {files.map((f) => (
          <View
            key={f.id}
            onLayout={(e) => onCardLayout(f.id, e)}
            style={[styles.card, highlightId === f.id && styles.cardFocus]}
          >
            <View style={styles.icon}>
              <Icon name={KIND_ICON[f.kind] || 'file'} size={22} color={colors.mintDark} />
            </View>
            <View style={styles.info}>
              <Text style={styles.name}>{f.name}</Text>
              <Text style={styles.meta}>
                {[f.referenceOnly ? '기기 파일 연결' : Platform.OS === 'web' ? '브라우저에 저장' : '휴대폰에 저장', f.kind, sizeText(f.size), dateText(f.createdAt)].filter(Boolean).join(' · ')}
              </Text>
              {f.text ? (
                <Text style={styles.desc} numberOfLines={3}>{f.text.slice(0, 120)}</Text>
              ) : canRecognize(f) ? (
                <View style={styles.actions}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`${f.name} 내용 인식`} disabled={!!reading[f.id]} onPress={() => recognize(f.id)} style={styles.smallBtn}>
                    {reading[f.id] ? <ActivityIndicator size="small" color={colors.mintDark} /> : null}
                    <Text style={styles.smallBtnText}>{reading[f.id] ? '읽는 중…' : '내용 인식'}</Text>
                  </Pressable>
                  <Text style={styles.note}>{readError[f.id] || '읽은 내용은 파일 카드에서 미리 볼 수 있어요'}</Text>
                </View>
              ) : (
                <Text style={styles.note}>파일 이름으로 검색돼요</Text>
              )}
              {f.storage === 'cloud' && (
                <Pressable accessibilityRole="button" accessibilityLabel={`${f.name} 열기`} onPress={() => open(f.id)} style={[styles.smallBtn, { alignSelf: 'flex-start' }]}>
                  <Text style={styles.smallBtnText}>열기</Text>
                </Pressable>
              )}
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={`${f.name} 삭제`} onPress={() => setDelId(f.id)} hitSlop={10}>
              <Icon name="trash" size={20} color={colors.muted} />
            </Pressable>
          </View>
        ))}
      </ScrollView>
      <ConfirmDialog
        visible={delId !== null}
        title="파일을 삭제할까요?"
        sub={delIsCloud
          ? '공간의 모든 멤버에게서 지워지고 복구할 수 없어요. 올린 사람이나 공간 주인만 지울 수 있어요.'
          : getFiles('local').find((file) => file.id === delId)?.referenceOnly
            ? '파일 보관함에서 연결 정보만 제거해요. 기기의 원본 파일은 삭제하지 않아요.'
            : '다운로드 폴더에 저장된 파일도 삭제돼요. 복구할 수 없어요.'}
        confirmText="삭제"
        danger
        onCancel={() => setDelId(null)}
        onConfirm={async () => {
          try { await (delIsCloud ? deleteCloudFile(delId) : deleteFile(delId)); setDelId(null); }
          catch (e) { setDelId(null); alertUser('파일을 삭제하지 못했어요', e.message); }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream },
  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  count: { fontSize: font.body, color: colors.muted },
  storageHelp: { fontSize: font.body, color: colors.ink, lineHeight: 20 },
  // 탭
  tabs: { flexDirection: 'row', gap: spacing.sm },
  // 파일이 없을 때 안내
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  emptySub: { fontSize: font.body, color: colors.muted, textAlign: 'center', lineHeight: 20 },
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
  },
  cardFocus: { borderColor: colors.mint, borderWidth: 2, backgroundColor: colors.mintSoft },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.mintSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: { flex: 1, gap: 4 },
  name: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  meta: { fontSize: font.caption, color: colors.muted },
  note: { fontSize: font.caption, color: colors.muted, marginTop: 2 },
  desc: { fontSize: font.body, color: colors.ink, lineHeight: 20, marginTop: 2 },
  actions: { gap: 4, marginTop: 2 },
  smallBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingHorizontal: spacing.md, minHeight: 32, borderRadius: 16, borderWidth: 1, borderColor: colors.mint, backgroundColor: colors.mintSoft, marginTop: 4 },
  smallBtnText: { fontSize: font.body, fontWeight: '700', color: colors.mintDark },
});
