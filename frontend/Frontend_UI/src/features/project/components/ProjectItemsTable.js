import React, { useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { randomUUID } from 'expo-crypto';
import { Chip, PillButton } from '../../../shared/components/Ui';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { colors, font, spacing } from '../../../shared/theme/theme';
import { alertUser } from '../../../data/alert';
import { DEFAULT_TABLE_VIEW, PROPERTY_TYPES, parsePropertyValue, projectTableRows, removeProjectProperty } from './projectTableView.mjs';
import Icon from '../../../shared/components/Icon';
// 마지막 글자의 받침에 맞춰 조사를 고른다(예: 종류로, 상태로, 메모가, 할 일이).
const hasBatchim = word => { const code = String(word).trim().slice(-1).charCodeAt(0) - 0xac00; return code >= 0 && code <= 11171 && code % 28 !== 0; };
const withRo = word => `${word}${hasBatchim(word) && (String(word).trim().slice(-1).charCodeAt(0) - 0xac00) % 28 !== 8 ? '으로' : '로'}`;


const columns = [
  { key: 'title', label: '이름', width: 138 },
  { key: 'type', label: '종류', width: 56 },
  { key: 'status', label: '상태', width: 66 },
  { key: 'date', label: '날짜', width: 64 },
];

export default function ProjectItemsTable({ initialSettings, onSaveSettings, sharedTable, canEditSharedTable, onSaveSharedTable, onFindCellConflict, sections, onOpen }) {
  const [settings, setSettings] = useState(() => initialSettings ?? { view: DEFAULT_TABLE_VIEW, saved: [] });
  const [isNamingView, setNamingView] = useState(false);
  const [viewName, setViewName] = useState('');
  const [propertyEditor, setPropertyEditor] = useState(null);
  const [propertyInput, setPropertyInput] = useState('');
  const [propertyConflict, setPropertyConflict] = useState(null);
  const [propertyNotice, setPropertyNotice] = useState('');
  const [filterDraft, setFilterDraft] = useState(null);
  const [isSavingProperty, setSavingProperty] = useState(false);
  const pendingPropertyWrite = useRef(false);
  const hasSharedTable = sharedTable != null;
  const canEditProperties = !hasSharedTable || canEditSharedTable;
  const { fields = [], properties = {} } = hasSharedTable ? sharedTable : settings;
  const { view: storedView, saved } = settings;
  const hasField = key => fields.some(field => field.key === key);
  const view = {
    ...storedView,
    ...(storedView.sortKey.startsWith('property:') && !hasField(storedView.sortKey) ? { sortKey: 'title', descending: false } : {}),
    ...(storedView.propertyFilter && !hasField(storedView.propertyFilter.key) ? { propertyFilter: null } : {}),
  };
  const { type, status, sortKey, descending } = view;
  const rows = projectTableRows(sections, view, properties);
  const filterField = fields.find(field => field.key === filterDraft?.key);
  const filterValue = filterField ? parsePropertyValue(filterField.type, filterDraft.input) : undefined;
  const hasFilterValue = filterValue !== null && filterValue !== undefined;
  const activeFilterField = fields.find(field => field.key === view.propertyFilter?.key);
  const tableColumns = [...columns, ...fields.map(field => ({ ...field, width: field.type === 'checkbox' ? 72 : 120 }))];
  const statuses = [...new Set(sections.flatMap(section => section.items.map(item => item.status)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  if (status && !statuses.includes(status)) statuses.push(status);
  const saveSettings = (next) => {
    onSaveSettings(next);
    setSettings(next);
  };
  const updateView = (patch) => saveSettings({ ...settings, view: { ...view, ...patch } });
  const trimmedName = viewName.trim();
  const canSaveView = trimmedName.length > 0 && !saved.some(candidate => candidate.name === trimmedName);
  const saveNamedView = () => {
    if (!canSaveView) return;
    saveSettings({ ...settings, saved: [...saved, { name: trimmedName, view }] });
    setNamingView(false);
  };
  const closeProperty = () => {
    if (pendingPropertyWrite.current) return;
    setPropertyConflict(null);
    setPropertyEditor(null);
  };
  const openProperty = async (editor) => {
    if (pendingPropertyWrite.current) return;
    setPropertyNotice('');
    setPropertyEditor({ ...editor, expected: sharedTable });
    if (!hasSharedTable || editor.mode !== 'edit' || !onFindCellConflict) return;
    pendingPropertyWrite.current = true;
    setSavingProperty(true);
    try {
      setPropertyConflict(await onFindCellConflict(editor.rowKey, editor.key));
    } catch (error) {
      setPropertyEditor(null);
      alertUser('속성을 열지 못했어요', error.message);
    } finally {
      pendingPropertyWrite.current = false;
      setSavingProperty(false);
    }
  };
  const saveProperties = async (next) => {
    if (!canEditProperties || pendingPropertyWrite.current) return;
    pendingPropertyWrite.current = true;
    setSavingProperty(true);
    try {
      if (hasSharedTable) {
        const result = await onSaveSharedTable(propertyEditor.expected, { fields: next.fields, properties: next.properties });
        if (result?.pending) setPropertyNotice('기기에 저장했어요. 연결되면 동기화합니다.');
        saveSettings({ ...settings, view: next.view, saved: next.saved });
      } else {
        saveSettings(next);
      }
      setPropertyEditor(null);
    } catch (error) {
      if (error.resolveTableConflict && propertyEditor.mode === 'edit') {
        const { rowKey, key } = propertyEditor;
        setPropertyConflict({
          local: next.properties[rowKey]?.[key],
          remote: error.remoteTable.properties[rowKey]?.[key],
          resolve: error.resolveTableConflict,
        });
      } else alertUser('속성을 저장하지 못했어요', error.message);
    } finally {
      pendingPropertyWrite.current = false;
      setSavingProperty(false);
    }
  };
  const resolvePropertyConflict = async (choice) => {
    if (!propertyConflict || pendingPropertyWrite.current) return;
    pendingPropertyWrite.current = true;
    setSavingProperty(true);
    try {
      const result = await propertyConflict.resolve(choice);
      if (result?.pending) setPropertyNotice('선택한 값을 기기에 저장했어요. 연결되면 동기화합니다.');
      setPropertyConflict(null);
      setPropertyEditor(null);
    } catch (error) {
      alertUser('충돌을 해결하지 못했어요', error.message);
    } finally {
      pendingPropertyWrite.current = false;
      setSavingProperty(false);
    }
  };
  const displayConflictValue = value => value == null ? '값 없음' : value === true ? '체크됨' : value === false ? '체크 안 됨' : String(value);
  const isAddingField = propertyEditor?.mode === 'add';
  const isRenamingField = propertyEditor?.mode === 'rename';
  const isNamingField = isAddingField || isRenamingField;
  const isManagingFields = propertyEditor?.mode === 'manage';
  const isDeletingField = propertyEditor?.mode === 'delete';
  const fieldName = propertyInput.trim();
  const normalizeName = (name) => name.normalize('NFC').toLowerCase();
  const valueToSave = propertyEditor?.mode === 'edit' ? parsePropertyValue(propertyEditor.type, propertyInput) : null;
  const canSaveProperty = isNamingField
    ? !!fieldName && !tableColumns.some(column => column.key !== propertyEditor.key && normalizeName(column.label) === normalizeName(fieldName))
    : valueToSave !== undefined;
  const saveProperty = () => {
    if (!propertyEditor || !canSaveProperty) return;
    const table = { ...settings, fields, properties };
    if (isAddingField) {
      void saveProperties({ ...table, fields: [...fields, { key: `property:${randomUUID()}`, label: fieldName, type: propertyEditor.type }] });
    } else if (isRenamingField) {
      void saveProperties({ ...table, fields: fields.map(field => field.key === propertyEditor.key ? { ...field, label: fieldName } : field) });
    } else {
      const { rowKey, key, expected } = propertyEditor;
      const initial = hasSharedTable ? expected : table;
      const values = { ...initial.properties[rowKey] };
      if (valueToSave === null) delete values[key];
      else values[key] = valueToSave;
      const next = { ...initial.properties };
      if (Object.keys(values).length) next[rowKey] = values;
      else delete next[rowKey];
      void saveProperties({ ...table, fields: initial.fields, properties: next });
    }
  };

  return (
    <View style={styles.wrap}>
      {!!propertyNotice && <Text accessibilityLiveRegion="polite" style={styles.value}>{propertyNotice}</Text>}
      <View style={styles.savedRow}>
        <PillButton kind="ghost" label="저장된 보기" onPress={() => {
          setViewName('');
          setNamingView(true);
        }} />
        <PillButton kind="ghost" label="기본 보기" onPress={() => updateView(DEFAULT_TABLE_VIEW)} />
        {canEditProperties && <PillButton kind="ghost" label="속성 추가" onPress={() => {
          setPropertyInput('');
          openProperty({ mode: 'add', type: 'text' });
        }} />}
        {canEditProperties && fields.length > 0 && <PillButton kind="ghost" label="속성 관리" onPress={() => openProperty({ mode: 'manage' })} />}
        {fields.length > 0 && <PillButton kind="ghost" label={activeFilterField ? `필터: ${activeFilterField.label}` : '속성 필터'} onPress={() => setFilterDraft({
          key: activeFilterField?.key ?? fields[0].key,
          input: activeFilterField ? String(view.propertyFilter.value) : '',
        })} />}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        <Chip label="모든 종류" active={type === 'all'} onPress={() => updateView({ type: 'all' })} />
        {sections.map(section => <Chip key={section.key} label={section.label} active={type === section.key} onPress={() => updateView({ type: section.key })} />)}
      </ScrollView>
      {statuses.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          <Chip label="모든 상태" active={status === null} onPress={() => updateView({ status: null })} />
          {statuses.map(value => <Chip key={value} label={value} active={status === value} onPress={() => updateView({ status: value })} />)}
        </ScrollView>
      )}
      {rows.length === 0 ? <Text style={styles.empty}>이 보기에 표시할 항목이 없어요.</Text> : (
        <ScrollView horizontal>
          <View style={styles.table}>
            <View style={styles.row}>
              {tableColumns.map(({ key, label, width }) => {
                const active = sortKey === key;
                const direction = descending ? '내림차순' : '오름차순';
                return (
                  <Pressable
                    key={key}
                    accessibilityRole="button"
                    accessibilityLabel={active ? `${label}, ${direction}` : `${withRo(label)} 정렬`}
                    onPress={() => updateView({ sortKey: key, descending: active && !descending })}
                    style={[styles.cell, { width }]}
                  >
                    <Text style={styles.header}>{label}{active && (descending ? ' ↓' : ' ↑')}</Text>
                  </Pressable>
                );
              })}
            </View>
            {rows.map(item => (
              <View key={item.rowKey} style={styles.row}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={[item.title, item.type, item.status, item.date].filter(Boolean).join(', ')}
                  onPress={() => onOpen(item.section, item.id)}
                  style={({ pressed }) => [styles.cells, pressed && styles.pressed]}
                >
                  {columns.map(({ key, width }) => (
                    <View key={key} style={[styles.cell, { width }]}>
                      <Text numberOfLines={1} style={[styles.value, key === 'title' && styles.title]}>{(key === 'date' && item.date ? item.date.slice(5).replace('-', '/') : item[key]) || '—'}</Text>
                    </View>
                  ))}
                </Pressable>
                {tableColumns.slice(columns.length).map(field => {
                  const value = properties[item.rowKey]?.[field.key];
                  const display = value == null ? '—' : field.type === 'checkbox' ? (value ? '체크됨' : '체크 안 됨') : String(value);
                  const direct = field.type === 'checkbox' && !hasSharedTable;
                  return (
                    <Pressable key={field.key} disabled={!canEditProperties} accessibilityRole={canEditProperties ? 'button' : undefined} accessibilityLabel={`${item.title}, ${field.label}, ${display}`} accessibilityState={field.type === 'checkbox' ? { checked: !!value } : undefined} style={[styles.cell, styles.propertyCell, { width: field.width }]} onPress={() => {
                      if (direct) {
                        const values = { ...properties[item.rowKey], [field.key]: !value };
                        void saveProperties({ ...settings, fields, properties: { ...properties, [item.rowKey]: values } });
                        return;
                      }
                      setPropertyInput(value == null ? '' : String(value));
                      openProperty({ ...field, rowKey: item.rowKey, mode: 'edit' });
                    }}>
                      {field.type === 'checkbox' ? <Icon name={value ? 'checkSquare' : 'square'} size={18} color={value ? colors.ink : colors.muted} /> : <Text numberOfLines={1} style={styles.value}>{display}</Text>}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      )}
      <Modal transparent visible={filterDraft !== null} animationType="fade" onRequestClose={() => setFilterDraft(null)}>
        <View style={styles.backdrop}>
          <View accessibilityViewIsModal style={styles.dialog}>
            <Text accessibilityRole="header" style={styles.title}>속성 필터</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters} keyboardShouldPersistTaps="handled">
              {fields.map(field => <Chip key={field.key} label={field.label} active={filterDraft?.key === field.key} onPress={() => setFilterDraft({ key: field.key, input: '' })} />)}
            </ScrollView>
            {filterField?.type === 'checkbox' ? (
              <View style={styles.savedRow}>
                <Chip label="체크됨" active={filterDraft?.input === 'true'} onPress={() => setFilterDraft({ ...filterDraft, input: 'true' })} />
                <Chip label="체크 안 됨" active={filterDraft?.input === 'false'} onPress={() => setFilterDraft({ ...filterDraft, input: 'false' })} />
              </View>
            ) : (
              <TextInput
                accessibilityLabel={filterField?.type === 'number' ? '최솟값' : '포함할 텍스트'}
                placeholder={filterField?.type === 'number' ? '최솟값' : '포함할 텍스트'}
                placeholderTextColor={colors.muted}
                value={filterDraft?.input ?? ''}
                onChangeText={input => setFilterDraft({ ...filterDraft, input })}
                maxLength={200}
                style={styles.input}
              />
            )}
            <PillButton label="필터 적용" disabled={!hasFilterValue} onPress={() => {
              if (!hasFilterValue || !filterField) return;
              updateView({ propertyFilter: { key: filterField.key, value: filterValue } });
              setFilterDraft(null);
            }} />
            {!!activeFilterField && <PillButton kind="ghost" label="속성 필터 해제" onPress={() => {
              updateView({ propertyFilter: null });
              setFilterDraft(null);
            }} />}
            <PillButton kind="ghost" label="취소" onPress={() => setFilterDraft(null)} />
          </View>
        </View>
      </Modal>
      <Modal transparent visible={propertyEditor !== null && !isDeletingField} animationType="fade" onRequestClose={closeProperty}>
        <View style={styles.backdrop}>
          <View accessibilityViewIsModal style={styles.dialog}>
            <Text accessibilityRole="header" style={styles.title}>{isManagingFields ? '속성 관리' : isAddingField ? '새 속성' : propertyEditor?.label}</Text>
            {propertyConflict ? <>
              <Text accessibilityLiveRegion="polite" style={styles.value}>같은 셀의 수정이 겹쳤어요.</Text>
              <Text style={styles.value}>내 값, {displayConflictValue(propertyConflict.local)}</Text>
              <Text style={styles.value}>서버 값, {displayConflictValue(propertyConflict.remote)}</Text>
              <PillButton label="내 값 유지" disabled={isSavingProperty} onPress={() => resolvePropertyConflict('keep_both')} />
              <PillButton kind="ghost" label="서버 값 사용" disabled={isSavingProperty} onPress={() => resolvePropertyConflict('use_server')} />
              <PillButton kind="ghost" label="나중에 해결" disabled={isSavingProperty} onPress={closeProperty} />
            </> : isManagingFields ? (
              <ScrollView style={styles.savedList}>
                {fields.map(field => (
                  <View key={field.key} style={styles.savedRow}>
                    <PillButton kind="ghost" style={styles.savedName} label={field.label} onPress={() => {
                      setPropertyInput(field.label);
                      openProperty({ ...field, mode: 'rename' });
                    }} />
                    <Pressable accessibilityRole="button" accessibilityLabel={`${field.label} 속성 삭제`} style={styles.cell} onPress={() => openProperty({ ...field, mode: 'delete' })}>
                      <Text style={styles.value}>삭제</Text>
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            ) : <>
            {isAddingField && <View style={styles.savedRow}>
              {PROPERTY_TYPES.map(({ id, label }) => <Chip key={id} label={label} active={propertyEditor.type === id} onPress={() => setPropertyEditor({ ...propertyEditor, type: id })} />)}
            </View>}
            {!isNamingField && propertyEditor?.type === 'checkbox' ? (
              <View style={styles.savedRow}>
                {[['true', '체크됨'], ['false', '체크 안 됨'], ['', '값 없음']].map(([value, label]) => (
                  <Chip key={label} label={label} active={propertyInput === value} onPress={() => setPropertyInput(value)} />
                ))}
              </View>
            ) : <TextInput
              accessibilityLabel={isNamingField ? '속성 이름' : '속성 값'}
              placeholder={isNamingField ? '속성 이름' : '속성 값'}
              placeholderTextColor={colors.muted}
              value={propertyInput}
              onChangeText={setPropertyInput}
              maxLength={isNamingField ? 40 : 200}
              style={styles.input}
            />}
            {!!propertyInput && !canSaveProperty && <Text style={styles.value}>{isNamingField ? '다른 속성 이름을 입력해 주세요.' : '숫자 형식으로 입력해 주세요.'}</Text>}
            <PillButton label={isSavingProperty ? '저장 중' : '저장'} disabled={isSavingProperty || !canEditProperties || !canSaveProperty} onPress={saveProperty} />
            </>}
            {!propertyConflict && <PillButton kind="ghost" label={isManagingFields ? '닫기' : '취소'} onPress={closeProperty} />}
          </View>
        </View>
      </Modal>
      <ConfirmDialog
        visible={isDeletingField}
        title={`${propertyEditor?.label ?? ''} 속성을 삭제할까요?`}
        sub="이 열에 입력한 값도 삭제됩니다."
        confirmText="속성 삭제"
        danger
        onCancel={() => { if (!pendingPropertyWrite.current) openProperty({ mode: 'manage' }); }}
        onConfirm={() => {
          void saveProperties(removeProjectProperty({ ...settings, fields, properties }, propertyEditor.key));
        }}
      />
      <Modal transparent visible={isNamingView} animationType="fade" onRequestClose={() => setNamingView(false)}>
        <View style={styles.backdrop}>
          <View accessibilityViewIsModal style={styles.dialog}>
            <Text accessibilityRole="header" style={styles.title}>저장된 보기</Text>
            <ScrollView style={styles.savedList} keyboardShouldPersistTaps="handled">
              {saved.map(candidate => (
                <View key={candidate.name} style={styles.savedRow}>
                  <PillButton kind="ghost" style={styles.savedName} label={candidate.name} onPress={() => {
                    saveSettings({ ...settings, view: candidate.view });
                    setNamingView(false);
                  }} />
                  <Pressable accessibilityRole="button" accessibilityLabel={`${candidate.name} 보기 삭제`} style={styles.cell} onPress={() => saveSettings({ ...settings, saved: saved.filter(item => item.name !== candidate.name) })}>
                    <Text style={styles.value}>삭제</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
            <TextInput
              accessibilityLabel="새 보기 이름"
              placeholder="새 보기 이름"
              placeholderTextColor={colors.muted}
              value={viewName}
              onChangeText={setViewName}
              maxLength={40}
              style={styles.input}
            />
            <PillButton label="현재 보기 저장" disabled={!canSaveView} onPress={saveNamedView} />
            <PillButton kind="ghost" label="닫기" onPress={() => setNamingView(false)} />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  filters: { gap: spacing.sm },
  table: { borderTopWidth: 1, borderTopColor: colors.line },
  row: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  cells: { flexDirection: 'row' },
  propertyCell: { borderStartWidth: StyleSheet.hairlineWidth, borderStartColor: colors.line },
  cell: { minHeight: 46, justifyContent: 'center', paddingHorizontal: spacing.sm },
  header: { fontSize: font.caption, color: colors.muted, fontWeight: '500' },
  value: { fontSize: font.body, color: colors.muted },
  title: { color: colors.ink, fontWeight: '600' },
  empty: { paddingVertical: spacing.lg, color: colors.muted },
  pressed: { backgroundColor: colors.mintSoft },
  savedRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  savedName: { flex: 1, minWidth: 0 },
  savedList: { maxHeight: 220 },
  backdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, backgroundColor: 'rgba(0,0,0,0.35)' },
  dialog: { width: '100%', maxWidth: 360, padding: spacing.lg, gap: spacing.sm, borderRadius: 12, backgroundColor: colors.card },
  input: { minHeight: 44, paddingHorizontal: spacing.md, borderRadius: 6, backgroundColor: colors.cream, borderWidth: 1, borderColor: colors.line, color: colors.ink },
});
