import { SheetModal } from '../../../shared/components/Motion';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, font, radius, spacing } from '../../../shared/theme/theme';
import { BLOCK_TYPES, readMemoBlocks, splitEditedBlock, writeMemoBlocks } from '../utils/memoBlocks.mjs';

export default function MemoBlockEditor({ body, onChange }) {
  const [menuIndex, setMenuIndex] = useState(null);
  const inputs = useRef(new Map());
  const pendingFocus = useRef(null);
  const blocks = readMemoBlocks(body);
  useEffect(() => {
    if (menuIndex !== null || pendingFocus.current === null) return;
    inputs.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  }, [body, menuIndex]);

  const addBlock = () => {
    const lastBlock = blocks.at(-1);
    if (lastBlock.type === 'text' && !lastBlock.text) {
      inputs.current.get(blocks.length - 1)?.focus();
      return;
    }
    pendingFocus.current = blocks.length;
    onChange(body + '\n');
  };
  const updateBlock = (index, patch) => {
    onChange(writeMemoBlocks(blocks.map((block, position) => position === index ? { ...block, ...patch } : block)));
  };
  const editBlockText = (index, text) => {
    const replacement = splitEditedBlock(blocks[index], text);
    if (replacement.length > 1) pendingFocus.current = index + replacement.length - 1;
    const next = [...blocks];
    next.splice(index, 1, ...replacement);
    onChange(writeMemoBlocks(next));
  };
  const moveBlock = (offset) => {
    const destination = menuIndex + offset;
    const next = [...blocks];
    const [block] = next.splice(menuIndex, 1);
    next.splice(destination, 0, block);
    pendingFocus.current = destination;
    onChange(writeMemoBlocks(next));
    setMenuIndex(null);
  };
  return (
    <View style={styles.editor}>
      {blocks.map((block, index) => (
        <View key={index} style={styles.row}>
          <Pressable accessibilityRole="button" accessibilityLabel={`${index + 1}번째 블록 메뉴`} onPress={() => setMenuIndex(index)} style={styles.control}>
            <Text style={styles.controlText}>⋮</Text>
          </Pressable>
          {block.type === 'todo' && (
            <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: block.checked }} aria-checked={block.checked} accessibilityLabel={block.text || '할 일'} onPress={() => updateBlock(index, { checked: !block.checked })} style={styles.control}>
              <Text style={styles.controlText}>{block.checked ? '☑' : '☐'}</Text>
            </Pressable>
          )}
          {block.type === 'bullet' && <Text style={styles.bullet}>•</Text>}
          <TextInput
            ref={(input) => {
              if (input) inputs.current.set(index, input);
              else inputs.current.delete(index);
            }}
            accessibilityLabel={`${index + 1}번째 ${BLOCK_TYPES.find(({ id }) => id === block.type).label}`}
            value={block.text}
            onChangeText={(text) => editBlockText(index, text)}
            placeholder={block.type === 'heading' ? '소제목' : block.type === 'todo' ? '할 일' : '내용을 입력하세요'}
            placeholderTextColor={colors.muted}
            multiline
            scrollEnabled={false}
            style={[styles.input, block.type === 'heading' && styles.heading, block.checked && styles.completed]}
          />
        </View>
      ))}
      <Pressable accessibilityRole="button" onPress={addBlock} style={styles.action}>
        <Text style={styles.actionText}>+ 블록 추가</Text>
      </Pressable>
      <SheetModal visible={menuIndex !== null} onClose={() => setMenuIndex(null)} label="블록 설정">
        <View style={styles.backdrop}>
          <View style={styles.menu} accessibilityViewIsModal>
            <Text accessibilityRole="header" style={styles.heading}>블록 설정</Text>
            {BLOCK_TYPES.map(({ id, label }) => (
              <Pressable key={id} accessibilityRole="radio" accessibilityState={{ checked: blocks[menuIndex]?.type === id }} style={styles.action} onPress={() => {
                pendingFocus.current = menuIndex;
                updateBlock(menuIndex, { type: id });
                setMenuIndex(null);
              }}>
                <Text style={styles.actionText}>{label}</Text>
              </Pressable>
            ))}
            {menuIndex > 0 && <Pressable accessibilityRole="button" style={styles.action} onPress={() => moveBlock(-1)}><Text style={styles.actionText}>위로 이동</Text></Pressable>}
            {menuIndex !== null && menuIndex < blocks.length - 1 && <Pressable accessibilityRole="button" style={styles.action} onPress={() => moveBlock(1)}><Text style={styles.actionText}>아래로 이동</Text></Pressable>}
            <Pressable accessibilityRole="button" style={styles.action} onPress={() => {
              pendingFocus.current = Math.max(0, Math.min(menuIndex, blocks.length - 2));
              onChange(writeMemoBlocks(blocks.filter((_, index) => index !== menuIndex)));
              setMenuIndex(null);
            }}><Text style={styles.actionText}>블록 삭제</Text></Pressable>
            <Pressable accessibilityRole="button" style={styles.action} onPress={() => setMenuIndex(null)}><Text style={styles.actionText}>닫기</Text></Pressable>
          </View>
        </View>
      </SheetModal>
    </View>
  );
}

const styles = StyleSheet.create({
  editor: { paddingVertical: spacing.sm, paddingBottom: spacing.xl },
  row: { flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 0, borderBottomColor: colors.line },
  control: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  controlText: { color: colors.muted, fontSize: 20 },
  bullet: { marginTop: 10, marginRight: spacing.sm, fontSize: 20, color: colors.ink },
  input: { flex: 1, minHeight: 44, paddingVertical: 10, fontSize: font.bodyLg, lineHeight: 24, color: colors.ink, textAlignVertical: 'top' },
  heading: { fontSize: 20, fontWeight: '500', color: colors.ink },
  completed: { color: colors.muted, textDecorationLine: 'line-through' },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md },
  actionText: { fontSize: font.body, color: colors.ink },
  backdrop: { flex: 1, alignItems: 'stretch' },
  menu: { width: '100%', padding: 0, borderRadius: radius.md, backgroundColor: colors.card },
});
