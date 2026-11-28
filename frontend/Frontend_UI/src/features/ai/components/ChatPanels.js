// ChatPanels.js — AI 채팅 보조 모달·시트 (첨부, AI 선택, 더보기, 사용량, 제목 수정, 파일, 이전 대화)
import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { PinIcon } from './ChatIcons';
import SlidePanel from './SlidePanel';
import UpSheet from './UpSheet';
import Icon from '../../../shared/components/Icon';
import { AI_ROUTE_LABEL, LOCAL_AI_AVAILABLE, PLANS } from '../../../data/settings/SettingsStore';
import { TITLE_MAX, sortChats } from '../../../data/ai/ChatStore';
import { colors, font, radius, shadow, spacing } from '../../../shared/theme/theme';

const pad = (n) => String(n).padStart(2, '0');
const when = (ms) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function ChatPanels({
  panel,
  setPanel,
  headerBottom,
  insets,
  route,
  chooseRoute,
  usage,
  onOpenSubscription,
  renaming,
  setRenaming,
  saveRename,
  pinned,
  togglePin,
  startRename,
  deleteCurrent,
  deleteChatById,
  chatUploads,
  jumpTo,
  vaultFiles,
  attachments,
  status,
  addFiles,
  addVaultFile,
  chats,
  chatId,
  openChat,
}) {
  return (
    <>
      <Modal transparent visible={panel === 'attach'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPanel(null)}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>첨부하기</Text>
            <Pressable accessibilityRole="button" onPress={() => addFiles('image')} style={styles.option}>
              <Text style={styles.optionName}>사진</Text>
              <Text style={styles.optionSub}>사진 속 글자를 읽어서 함께 보내요 (클라우드 AI, 월 사용 횟수 차감)</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => addFiles('file')} style={styles.option}>
              <Text style={styles.optionName}>파일</Text>
              <Text style={styles.optionSub}>PDF, Word, PowerPoint, 텍스트 파일에서 글자를 꺼내 함께 보내요</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setPanel('archive')} style={styles.option}>
              <Text style={styles.optionName}>파일 보관함에서 선택</Text>
              <Text style={styles.optionSub}>기기 또는 현재 공유 공간에 저장된 파일을 첨부해요</Text>
            </Pressable>
            <Text style={styles.sheetNote}>파일은 대화 기록에 저장되지 않지만, 처리에 필요한 내용은 서버로 전송될 수 있어요. 읽을 수 없는 형식이나 처리 한도를 넘은 파일만 따로 안내해요.</Text>
          </View>
        </Pressable>
      </Modal>

      <Modal transparent visible={panel === 'route'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPanel(null)}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>어떤 AI로 답할까요?</Text>
            {['external', 'self_hosted'].map((id) => {
              const on = id === route;
              const off = id === 'self_hosted' && !LOCAL_AI_AVAILABLE;
              return (
                <Pressable
                  key={id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: off }}
                  disabled={off}
                  onPress={() => chooseRoute(id)}
                  style={[styles.option, on && styles.optionOn, off && { opacity: 0.5 }]}
                >
                  <Text style={styles.optionName}>{AI_ROUTE_LABEL[id]}{on ? ', 사용 중' : off ? ', 준비 중' : ''}</Text>
                  <Text style={styles.optionSub}>
                    {id === 'external' ? '외부 AI 제공자가 답해요. 빠르고 사진 글자 인식도 돼요' : '팀 서버의 자체 모델이 답해요. 외부 AI로 넘기지 않아요 (서버 연결 후 사용)'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>

      <Modal transparent visible={panel === 'more'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.menuBackdrop} onPress={() => setPanel(null)}>
          <View style={[styles.menu, { top: (headerBottom || insets.top + 60) + spacing.xs }]} accessibilityViewIsModal>
            {[
              { key: 'history', label: '이전 대화', icon: 'history', onPress: () => setPanel('history') },
              { key: 'rename', label: '제목 수정', icon: 'pencil', onPress: () => startRename(null) },
              { key: 'pin', label: pinned ? '고정 해제' : '고정', icon: null, onPress: togglePin },
              { key: 'files', label: `업로드된 파일${chatUploads.length ? ` ${chatUploads.length}` : ''}`, icon: 'paperclip', onPress: () => setPanel('files') },
              { key: 'delete', label: '삭제', icon: 'trash', onPress: deleteCurrent, danger: true },
            ].map(({ key, label, icon, onPress, danger }) => (
              <Pressable key={key} accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}>
                {icon ? <Icon name={icon} size={20} color={danger ? colors.coral : colors.ink} /> : <PinIcon size={20} color={colors.ink} />}
                <Text style={[styles.menuText, danger && { color: colors.coral }]}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      <Modal transparent visible={panel === 'usage'} animationType="fade" onRequestClose={() => setPanel(null)}>
        <Pressable style={styles.backdrop} onPress={() => setPanel(null)}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>이번 달 AI 사용량</Text>
            {usage.error ? (
              <Text style={[styles.optionSub, { color: colors.coral }]}>{usage.error}</Text>
            ) : !usage.data ? (
              <ActivityIndicator color={colors.mintDark} style={{ alignSelf: 'flex-start', marginVertical: spacing.md }} />
            ) : (
              <>
                <Text style={styles.optionSub}>요금제 {PLANS[usage.data.plan].name}</Text>
                {usage.data.items.map((u) => {
                  const ratio = u.limit > 0 ? Math.min(1, u.used / u.limit) : 0;
                  return (
                    <View key={u.key} style={styles.usageRow}>
                      <View style={styles.usageHead}>
                        <Text style={styles.usageLabel}>{u.label}</Text>
                        <Text style={styles.usageNum}>{u.used}/{u.limit}회, 남은 {u.remaining}회</Text>
                      </View>
                      <View style={styles.usageTrack}>
                        <View style={[styles.usageFill, { width: `${ratio * 100}%`, backgroundColor: ratio >= 0.9 ? colors.coral : colors.mint }]} />
                      </View>
                    </View>
                  );
                })}
              </>
            )}
            <Pressable accessibilityRole="button" onPress={onOpenSubscription} style={styles.option}>
              <Text style={styles.optionName}>요금제 보기</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      <Modal transparent visible={!!renaming} animationType="fade" onRequestClose={() => setRenaming(null)}>
        <View style={styles.backdrop}>
          <View style={styles.sheet} accessibilityViewIsModal>
            <Text style={styles.sheetTitle}>제목 수정</Text>
            <TextInput
              style={styles.renameInput}
              value={renaming?.value ?? ''}
              onChangeText={(value) => setRenaming((r) => (r ? { ...r, value } : r))}
              onSubmitEditing={saveRename}
              maxLength={TITLE_MAX}
              autoFocus
              selectTextOnFocus
              placeholder="대화 제목"
              placeholderTextColor={colors.muted}
              accessibilityLabel="대화 제목"
            />
            <Text style={styles.sheetNote}>{(renaming?.value ?? '').length} / {TITLE_MAX}자. 직접 바꾼 제목은 AI가 다시 바꾸지 않아요</Text>
            <View style={styles.renameRow}>
              <Pressable accessibilityRole="button" onPress={() => setRenaming(null)} style={[styles.renameBtn, styles.renameCancel]}>
                <Text style={styles.renameCancelText}>취소</Text>
              </Pressable>
              <Pressable accessibilityRole="button" onPress={saveRename} style={[styles.renameBtn, styles.renameSave]}>
                <Text style={styles.renameSaveText}>저장</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <UpSheet visible={panel === 'files'} top={headerBottom} title="업로드된 파일" onClose={() => setPanel(null)}>
        {chatUploads.length === 0 ? (
          <Text style={styles.historyEmpty}>올린 사진이나 파일이 없어요</Text>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing.sm }}>
            {chatUploads.map((u) => (
              <Pressable
                key={`${u.messageId}:${u.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${u.name}, 올린 질문으로 이동`}
                onPress={() => jumpTo(u.messageId)}
                style={({ pressed }) => [styles.fileItem, pressed && styles.pressed]}
              >
                <View style={styles.fileBadge}>
                  <Icon name={u.kind === 'image' ? 'image' : 'file'} size={18} color={colors.mintDark} />
                  <Text style={styles.fileBadgeText}>{u.kind === 'image' ? '사진' : u.kind === 'document' ? '문서' : '파일'}</Text>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={styles.optionName} numberOfLines={1}>{u.name}</Text>
                  <Text style={styles.optionSub} numberOfLines={1}>{u.question}</Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        )}
      </UpSheet>

      <UpSheet visible={panel === 'archive'} top={headerBottom} title="파일 보관함에서 선택" onClose={() => setPanel(null)}>
        {vaultFiles.length === 0 ? (
          <Text style={styles.historyEmpty}>AI가 읽을 수 있는 파일이 없어요. 먼저 파일 보관함에 파일을 추가해 주세요.</Text>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing.sm }}>
            {vaultFiles.map((file) => {
              const storage = file.storage || 'local';
              const selected = attachments.some((a) => a.archiveFileId === file.id && a.archiveStorage === storage);
              const disabled = status !== 'idle' || selected;
              return (
                <Pressable
                  key={`${storage}:${file.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${file.name}${selected ? ', 이미 첨부됨' : ', AI 채팅에 첨부'}`}
                  accessibilityState={{ disabled, selected }}
                  disabled={disabled}
                  onPress={() => addVaultFile(file)}
                  style={({ pressed }) => [styles.fileItem, disabled && { opacity: 0.55 }, pressed && !disabled && styles.pressed]}
                >
                  <View style={styles.fileBadge}>
                    <Icon name="file" size={18} color={colors.mintDark} />
                    <Text style={styles.fileBadgeText}>{storage === 'cloud' ? '공유' : '기기'}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.optionName} numberOfLines={1}>{file.name}</Text>
                    <Text style={styles.optionSub} numberOfLines={1}>
                      {selected ? '이미 첨부됨' : file.text ? '내용 인식 완료. 선택해 첨부' : '선택하면 파일 내용을 읽어요'}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </UpSheet>

      <SlidePanel visible={panel === 'history'} title="이전 대화" onClose={() => setPanel(null)}>
        {chats.length === 0 ? (
          <Text style={styles.historyEmpty}>저장된 대화가 없어요</Text>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing.sm }}>
            {sortChats(chats).map((c) => (
              <View key={c.id} style={[styles.historyItem, c.id === chatId && styles.optionOn]}>
                <Pressable accessibilityRole="button" accessibilityLabel={`${c.pinnedAt ? '고정된 ' : ''}${c.title} 대화 열기`} onPress={() => openChat(c)} style={{ flex: 1, gap: 2 }}>
                  <View style={styles.historyTitleRow}>
                    {!!c.pinnedAt && <View style={styles.pinTag}><Text style={styles.pinTagText}>고정</Text></View>}
                    <Text style={[styles.optionName, { flexShrink: 1 }]} numberOfLines={1}>{c.title}</Text>
                  </View>
                  <Text style={styles.optionSub}>{when(c.updatedAt)}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`${c.title} 제목 수정`} onPress={() => startRename(c)} hitSlop={8} style={({ pressed }) => [styles.rowIconBtn, pressed && styles.pressed]}>
                  <Icon name="pencil" size={17} color={colors.mintDark} />
                </Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel={`${c.title} 대화 삭제`} onPress={() => (c.id === chatId ? deleteCurrent() : deleteChatById(c.id))} hitSlop={8} style={({ pressed }) => [styles.rowIconBtn, pressed && styles.pressed]}>
                  <Icon name="trash" size={17} color={colors.coral} />
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
      </SlidePanel>
    </>
  );
}

const styles = StyleSheet.create({
  pressed: { backgroundColor: colors.mintSoft },
  rowIconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  menuBackdrop: { flex: 1 },
  menu: { position: 'absolute', right: spacing.lg, minWidth: 220, paddingVertical: spacing.sm, borderRadius: radius.card, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, ...shadow.float, shadowColor: '#263935', shadowOpacity: 0.14 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.md, marginHorizontal: spacing.xs },
  menuText: { fontSize: font.body + 1, fontWeight: '700', color: colors.ink },
  historyTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  renameInput: { minHeight: 46, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, paddingHorizontal: spacing.lg, fontSize: font.bodyLg, color: colors.ink },
  renameRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  renameBtn: { flex: 1, minHeight: 46, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  renameCancel: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  renameCancelText: { fontSize: font.bodyLg, fontWeight: '700', color: colors.ink },
  renameSave: { backgroundColor: colors.action },
  renameSaveText: { fontSize: font.bodyLg, fontWeight: '800', color: colors.onPrimary },
  pinTag: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: colors.mintSoft },
  pinTagText: { fontSize: 11, fontWeight: '800', color: colors.mintDark },
  fileItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 52, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  fileBadge: { width: 36, alignItems: 'center', justifyContent: 'center', gap: 1 },
  fileBadgeText: { fontSize: 11, color: colors.muted },
  usageRow: { gap: 6, paddingVertical: spacing.xs },
  usageHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing.sm },
  usageLabel: { fontSize: font.body, fontWeight: '700', color: colors.ink },
  usageNum: { fontSize: font.caption, color: colors.muted },
  usageTrack: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
  usageFill: { height: 8, borderRadius: 4 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  sheet: { width: '100%', maxWidth: 380, backgroundColor: colors.cream, borderRadius: radius.lg + 4, padding: spacing.xl, gap: spacing.sm, borderWidth: 1, borderColor: colors.line },
  sheetTitle: { fontSize: font.title - 2, fontWeight: '800', color: colors.ink, marginBottom: spacing.xs },
  sheetNote: { fontSize: font.caption, color: colors.muted, marginTop: spacing.xs, lineHeight: 17 },
  option: { minHeight: 44, justifyContent: 'center', paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: 'transparent', gap: 2 },
  optionOn: { borderColor: colors.ink },
  optionName: { fontSize: font.bodyLg - 1, fontWeight: '500', color: colors.ink },
  optionSub: { fontSize: font.caption, color: colors.muted, lineHeight: 18 },
  historyEmpty: { fontSize: font.body, color: colors.muted, paddingVertical: spacing.lg },
  historyItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 48, padding: spacing.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: 'transparent' },
});
