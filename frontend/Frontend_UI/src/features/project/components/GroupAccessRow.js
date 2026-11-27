// 문서·할 일의 공개 범위: 프로젝트 모두 또는 고른 그룹만 (Notion 공유 메뉴의 "접근 권한" 줄처럼 한 줄 + 아래 시트)
// 그룹이 있는 공유 프로젝트의 저장된 항목에서만 보인다. 서버가 권한을 다시 확인하고, 실패하면 시트에 이유를 보여 준다.
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import Icon from '../../../shared/components/Icon';
import { SheetModal } from '../../../shared/components/Motion';
import { itemGroupsOf, projectOf, setItemGroups, useProjects } from '../../../data/projects/ProjectStore';
import { colors } from '../../../shared/theme/theme';

export default function GroupAccessRow({ kind, id, style, textStyle }) {
  useProjects();   // 그룹·공개 범위가 바뀌면 다시 그림
  const project = id ? projectOf(kind === 'task' ? 'tasks' : 'memos', id) : null;
  const groups = project?.groups ?? [];
  const current = id ? itemGroupsOf(kind, id) : [];
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!project || groups.length === 0) return null;

  const names = groups.filter((g) => current.includes(g.id)).map((g) => g.name);
  const value = names.length ? names.join(', ') : '프로젝트 모두';
  const toggle = (gid) => setPicked((p) => (p.includes(gid) ? p.filter((x) => x !== gid) : [...p, gid]));
  const apply = async () => {
    setBusy(true); setError('');
    try { await setItemGroups(kind, id, picked); setOpen(false); }
    catch (e) { setError(e?.message ?? '바꾸지 못했어요'); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`공개 범위: ${value}`} onPress={() => { setPicked(current); setError(''); setOpen(true); }}
        style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }, style]}>
        <Icon name={names.length ? 'lock' : 'users'} size={16} color={colors.muted} />
        <Text style={[{ color: colors.muted, fontSize: 14 }, textStyle]}>공개 범위</Text>
        <Text numberOfLines={1} style={[{ flex: 1, color: colors.ink, fontSize: 14 }, textStyle]}>{value}</Text>
        <Icon name="chevronDown" size={15} color={colors.muted} />
      </Pressable>
      <SheetModal visible={open} onClose={() => setOpen(false)} label="공개 범위 선택">
        <Text style={{ color: colors.ink, fontSize: 16, fontWeight: '600', minHeight: 32 }}>공개 범위</Text>
        <Text style={{ color: colors.muted, fontSize: 13, marginBottom: 8 }}>고른 그룹의 멤버만 이 항목을 볼 수 있어요. 아무것도 고르지 않으면 프로젝트 모두에게 보여요.</Text>
        <ScrollView style={{ maxHeight: 320 }}>
          {groups.map((g) => {
            const on = picked.includes(g.id);
            return (
              <Pressable key={g.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${g.name} 그룹`} onPress={() => toggle(g.id)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48 }}>
                <Icon name={on ? 'checkSquare' : 'square'} size={20} color={on ? colors.ink : colors.muted} />
                <Text style={{ flex: 1, color: colors.ink, fontSize: 15 }}>{g.name}</Text>
                <Text style={{ color: colors.muted, fontSize: 13 }}>{g.members.length}명</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {!!error && <Text style={{ color: colors.coral, fontSize: 13, marginTop: 6 }}>{error}</Text>}
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={{ flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.card }}>
            <Text style={{ color: colors.ink, fontSize: 15 }}>취소</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={apply} style={{ flex: 1, minHeight: 46, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.action, opacity: busy ? 0.5 : 1 }}>
            <Text style={{ color: colors.onPrimary, fontSize: 15, fontWeight: '600' }}>{busy ? '적용 중' : '적용'}</Text>
          </Pressable>
        </View>
      </SheetModal>
    </>
  );
}
