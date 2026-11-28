// ChatMessageBubble.js — 말풍선 및 AI 승인 초안 카드 (프로젝트 · 할 일/일정 · 문서 초안)
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { nextField, summary as projectSummary } from '../projectTemplate.mjs';
import Icon from '../../../shared/components/Icon';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';

const sourceIcons = { memo: 'file', file: 'paperclip', project: 'folder', task: 'checkSquare', event: 'calendar' };
const sourceLabels = { memo: '메모', file: '파일', project: '프로젝트', task: '할 일', event: '일정' };
const sourceIcon = src => (src.route ? sourceIcons[src.type] ?? 'file' : 'paperclip');

export function ProjectForm({ form, onAction }) {
  const chip = (label, onPress, strong, key = label) => (
    <Pressable key={key} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.formChip, pressed && { opacity: 0.6 }]}>
      <Text style={[styles.formChipText, strong && styles.formChipPrimary]}>{label}</Text>
    </Pressable>
  );
  if (form.created) {
    return (
      <View style={styles.form}>
        <Text style={styles.aiText}>
          {form.syncPending ? '기기에 저장했어요. 공유 공간 동기화를 기다리고 있어요.' : form.change ? '프로젝트 상태를 변경했어요.' : `'${form.values.title}' 프로젝트를 만들었어요.`}
        </Text>
        <View style={styles.formRow}>{chip('프로젝트 열기', () => onAction('open'), true)}</View>
      </View>
    );
  }
  if (form.cancelled || form.conflict) {
    return <View style={styles.form}><Text style={styles.formNote}>{form.conflict ?? '프로젝트 작업을 취소했어요.'}</Text></View>;
  }
  if (form.change) {
    return (
      <View style={styles.form}>
        {form.change.target
          ? <Text style={styles.aiText}>{form.change.target.title}{'\n'}{form.change.target.status} → {form.change.status}</Text>
          : <Text style={styles.aiText}>이름이 같은 프로젝트가 있어요. 변경할 항목을 골라 주세요.</Text>}
        <View style={styles.formRow}>
          {form.change.target
            ? chip('상태 변경', () => onAction('create'), true)
            : form.change.candidates.map(project => chip(`${project.title} (${project.status}, ${project.due || '마감 없음'})`, () => onAction('target', project.id), false, project.id))}
          {chip('취소', () => onAction('cancel'))}
        </View>
      </View>
    );
  }
  const field = nextField(form.values);
  return (
    <View style={styles.form}>
      {!!field && Object.keys(form.values).length > 0 && <Text style={styles.formNote}>{projectSummary(form.values)}</Text>}
      {field ? (
        <>
          <Text style={styles.aiText}>{field.ask}</Text>
          {field.options
            ? <View style={styles.formRow}>{field.options().map(([label, value]) => chip(label, () => onAction('set', field.key, value)))}</View>
            : <Text style={styles.formNote}>아래 입력창에 써서 보내 주세요.</Text>}
        </>
      ) : (
        <>
          <Text style={styles.aiText}>{projectSummary(form.values)}</Text>
          <View style={styles.formRow}>{chip('프로젝트 만들기', () => onAction('create'), true)}{chip('취소', () => onAction('cancel'))}</View>
        </>
      )}
      {field && <View style={styles.formRow}>{chip('취소', () => onAction('cancel'))}</View>}
    </View>
  );
}

export function TaskForm({ form, onAction }) {
  const chip = (label, action, strong = false, key = label) => (
    <Pressable key={key} accessibilityRole="button" onPress={action} style={({ pressed }) => [styles.formChip, pressed && { opacity: 0.6 }]}>
      <Text style={[styles.formChipText, strong && styles.formChipPrimary]}>{label}</Text>
    </Pressable>
  );
  const resolvedKind = form.target?.kind ?? form.kind;
  const name = resolvedKind === 'event' ? '일정' : '할 일';
  if (form.cancelled || form.conflict) {
    return <View style={styles.form}><Text style={styles.formNote}>{form.conflict ?? '작업을 취소했어요.'}</Text></View>;
  }
  if (form.savedId) {
    return (
      <View style={styles.form}>
        <Text style={styles.aiText}>{form.pending ? '기기에 저장했어요. 공유 공간 동기화가 대기 중이에요.' : `${name}을 저장했어요.`}</Text>
        <View style={styles.formRow}>{chip(`${name} 열기`, () => onAction('open'), true)}</View>
      </View>
    );
  }
  const { target, candidates, fields } = form;
  if (form.action === 'change' && !target) {
    return (
      <View style={styles.form}>
        <Text style={styles.aiText}>이름이 같은 항목이 있어요. 변경할 항목을 골라 주세요.</Text>
        <View style={styles.formRow}>
          {candidates.map(item => chip(`${item.title} (${item.date}, ${item.status})`, () => onAction('target', item.id), false, item.id))}
          {chip('취소', () => onAction('cancel'))}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.form}>
      <Text style={styles.aiText}>
        {target
          ? `${target.title} (${target.date})\n${target.status} → ${fields.status}`
          : `${fields.title}\n${fields.date}${fields.start ? ' ' + fields.start : ''}`}
      </Text>
      {!!form.overlap && <Text style={styles.formNote}>같은 시간에 다른 항목이 있어요.</Text>}
      <View style={styles.formRow}>
        {chip(target ? '상태 변경' : `${name} 추가`, () => onAction('save'), true)}
        {chip('취소', () => onAction('cancel'))}
      </View>
    </View>
  );
}

export default function ChatMessageBubble({ message, onOpenSource, onMakeDoc, onProject, onTask, onCommand, onDraft }) {
  if (message.role === 'user') {
    return (
      <View style={styles.userRow}>
        {message.attachments?.length > 0 && (
          <View style={styles.sentFiles}>
            {message.attachments.map((a) => (
              <View key={a.id} style={styles.sentFile} accessibilityLabel={`${a.kind === 'image' ? '사진' : a.kind === 'audio' ? '음성' : '파일'} ${a.name}`}>
                <Icon name={a.kind === 'image' ? 'image' : a.kind === 'audio' ? 'mic' : 'file'} size={14} color={a.warning ? colors.coral : colors.mintDark} />
                <View style={{ flexShrink: 1 }}>
                  <Text style={styles.sentFileText} numberOfLines={1}>{a.name}</Text>
                  {!!a.warning && <Text style={styles.sentFileWarning}>{a.warning}</Text>}
                </View>
              </View>
            ))}
          </View>
        )}
        <View style={styles.userBubble}>
          <Text style={styles.userText} selectable>{message.text}</Text>
        </View>
      </View>
    );
  }

  const sources = message.done && message.sources ? message.sources : [];
  return (
    <View style={styles.aiRow}>
      <View style={styles.aiCol}>
        <View style={[styles.aiBubble, styles.aiBubbleFit, message.error && styles.errorBubble]}>
          <Text style={[styles.aiText, message.error && styles.errorText]} selectable>{message.text}</Text>
        </View>
        {message.projectForm && <ProjectForm form={message.projectForm} onAction={(...args) => onProject(message, ...args)} />}
        {message.taskForm && <TaskForm form={message.taskForm} onAction={(...args) => onTask(message, ...args)} />}
        {message.chatCommand && (
          <Pressable accessibilityRole="button" style={({ pressed }) => [styles.formChip, styles.formChipStart, pressed && { opacity: 0.6 }]} onPress={() => onCommand(message.chatCommand)}>
            <Text style={[styles.formChipText, styles.formChipPrimary]}>작업 검토</Text>
          </Pressable>
        )}
        {message.documentDraft && (
          <View style={styles.formRow}>
            {message.documentDraft.cancelled ? (
              <Text style={styles.formNote}>초안을 취소했어요.</Text>
            ) : (
              <>
                <Pressable accessibilityRole="button" style={({ pressed }) => [styles.formChip, pressed && { opacity: 0.6 }]} onPress={() => onDraft(message, false)}>
                  <Text style={[styles.formChipText, styles.formChipPrimary]}>{message.documentDraft.savedId ? '문서 열기' : '문서 만들기'}</Text>
                </Pressable>
                {!message.documentDraft.savedId && (
                  <Pressable accessibilityRole="button" style={({ pressed }) => [styles.formChip, pressed && { opacity: 0.6 }]} onPress={() => onDraft(message, true)}>
                    <Text style={styles.formChipText}>취소</Text>
                  </Pressable>
                )}
              </>
            )}
          </View>
        )}
        {message.done && !message.error && !message.projectForm && !message.taskForm && !message.documentLookup && !message.toolResult && !!onMakeDoc && (
          <Pressable accessibilityRole="button" onPress={() => onMakeDoc(message)} hitSlop={6} style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', minHeight: 36 }, pressed && { opacity: 0.6 }]}>
            <Icon name="file" size={15} color={colors.muted} /><Text style={{ fontSize: font.caption + 1, color: colors.muted }}>문서로 만들기</Text>
          </Pressable>
        )}
        {sources.length > 0 && (
          <View style={styles.sources}>
            <Text style={styles.sourcesLabel}>출처{sources.some((s) => s.route) ? ', 누르면 해당 위치로 이동해요' : ''}</Text>
            <View style={styles.sourceChips}>
              {sources.map((src) => (
                <Pressable
                  key={src.id}
                  accessibilityRole={src.route ? 'button' : 'text'}
                  accessibilityLabel={src.route ? `출처 ${sourceLabels[src.type] ?? '기록'} ${src.title} 열기` : `첨부 ${src.title}`}
                  disabled={!src.route}
                  onPress={() => onOpenSource(src)}
                  style={({ pressed }) => [styles.sourceChip, pressed && { backgroundColor: colors.mintSoft }]}
                >
                  <Icon name={sourceIcon(src)} size={15} color={colors.mintDark} />
                  <Text style={styles.sourceText} numberOfLines={1}>{src.title}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  userRow: { alignItems: 'flex-end', gap: 6 },
  userBubble: { maxWidth: '80%', backgroundColor: colors.action, paddingHorizontal: spacing.lg, paddingVertical: 11, borderRadius: radius.card, borderBottomRightRadius: 6 },
  userText: { fontSize: font.bodyLg, color: colors.onPrimary, lineHeight: 22 },
  sentFiles: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 6, maxWidth: '80%' },
  sentFile: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, maxWidth: '100%' },
  sentFileText: { flexShrink: 1, fontSize: font.caption, fontWeight: '700', color: colors.ink },
  sentFileWarning: { fontSize: 10, color: colors.coral },
  aiRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  aiBubble: { maxWidth: '100%', paddingVertical: 2 },
  aiBubbleFit: { alignSelf: 'flex-start', maxWidth: '100%' },
  aiCol: { flex: 1, gap: spacing.sm },
  aiText: { fontSize: font.bodyLg, color: colors.ink, lineHeight: 22 },
  errorBubble: {},
  errorText: { color: colors.coral, fontSize: font.body },
  form: { gap: spacing.sm, marginTop: spacing.xs },
  formRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  formChip: { minHeight: 44, minWidth: 44, paddingHorizontal: 8, justifyContent: 'center' },
  formChipStart: { alignSelf: 'flex-start' },
  formChipPrimary: { color: colors.ink, fontWeight: '600' },
  formChipText: { fontSize: 13, color: colors.muted },
  formNote: { fontSize: font.caption + 1, color: colors.muted, lineHeight: 19 },
  sources: { gap: 6 },
  sourcesLabel: { fontSize: font.caption, color: colors.muted },
  sourceChips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sourceChip: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10, backgroundColor: colors.card, borderWidth: 0, borderColor: colors.line },
  sourceText: { flexShrink: 1, fontSize: font.caption + 1, fontWeight: '800', color: colors.ink },
});
