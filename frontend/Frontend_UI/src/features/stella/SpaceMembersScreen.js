// Shared space members, billing owner and management log (Notion mobile: Members list + per-member role sheet).
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { runtime } from '../../integration/runtime';
import {
  changeMemberRole, claimWorkspaceBilling, getWorkspaceBilling, listAuditLogs, listMembers, recentValue, rememberValue, removeMember, setMemberExpiry,
  useWorkspaceAccessClosed, useWorkspaces,
} from '../../data/workspaces/WorkspaceStore';
import ConfirmDialog from '../../shared/components/ConfirmDialog';
import { SheetModal } from '../../shared/components/Motion';
import Icon from '../../shared/components/Icon';
import { WorkspaceHeader } from './WorkspaceScreen';
import { palette as c, styles as s } from './theme';

const ROLES = [
  ['OWNER', '관리자', '공간 설정, 결제, 초대와 멤버 관리'],
  ['EDITOR', '멤버', '문서, 일정, 프로젝트 편집'],
  ['VIEWER', '보기 전용', '읽기만 가능'],
];
const ROLE_LABEL = Object.fromEntries(ROLES.map(([code, label]) => [code, label]));
const EXPIRY = [[0, '만료 없음'], [1, '1일 뒤'], [7, '7일 뒤'], [30, '30일 뒤']];
const day = value => { const d = new Date(value); return `${d.getMonth() + 1}/${d.getDate()}`; };
const nameOf = m => m?.display_name || '이름 없음';

export default function SpaceMembersScreen({ navigation, route }) {
  const id = route?.params?.workspaceId;
  const ws = useWorkspaces().list.find(w => w.id === id);
  const closed = useWorkspaceAccessClosed(id);
  const me = runtime().session?.id;
  const serverId = ws?.serverId;
  const owner = ws?.roleCode === 'OWNER';
  // 마지막 결과를 먼저 보여 주고 조용히 새로 고침 (다시 열 때 스피너·빈 화면 깜빡임 없음)
  const [state, setState] = useState(() => (serverId && recentValue('membersScreen', serverId)) || { loading: true, members: [], billing: null, log: [], error: '' });
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [confirm, setConfirm] = useState(null); // 'billing' | 'remove'

  const load = useCallback(async () => {
    if (!serverId || closed) return;
    try {
      const [members, billing, log] = await Promise.all([
        listMembers(serverId), getWorkspaceBilling(serverId), owner ? listAuditLogs(serverId) : Promise.resolve([]),
      ]);
      setState(rememberValue('membersScreen', serverId, { loading: false, members, billing, log, error: '' }));
    } catch (e) {
      setState(prev => ({ ...prev, loading: false, error: e.message || '멤버 정보를 불러오지 못했어요' }));
    }
  }, [serverId, closed, owner]);
  useEffect(() => { load(); }, [load]);

  async function run(action) {
    setBusy(true); setActionError('');
    try { await action(); await load(); return true; }
    catch (e) { setActionError(e.message || '처리하지 못했어요. 잠시 후 다시 시도해 주세요'); return false; }
    finally { setBusy(false); }
  }
  const member = state.members.find(m => m.account_id === selected);
  const closeSheet = () => { setSelected(null); setActionError(''); };

  if (!ws || ws.personal || closed || !serverId) {
    return <View style={s.root}><WorkspaceHeader title="멤버" onBack={navigation.goBack} />
      <Text accessibilityLiveRegion="polite" style={s.empty}>{closed ? '이 공유 공간에 대한 접근이 종료됐어요.' : '공유 공간에서만 멤버를 관리할 수 있어요.'}</Text></View>;
  }

  const billing = state.billing;
  const byId = Object.fromEntries(state.members.map(m => [m.account_id, m]));
  const who = accountId => !accountId ? '시스템' : accountId === me ? '나' : byId[accountId] ? nameOf(byId[accountId]) : '이전 멤버';
  const logText = entry => ({
    BILLING_ASSIGNED: `결제 주체 지정, ${who(entry.target_id)}`,
    BILLING_CLEARED: `결제 주체 해제, ${who(entry.target_id)} (공간 FREE)`,
    MEMBER_EXPIRY_SET: entry.detail?.expires_at ? `접근 만료 ${day(entry.detail.expires_at)} 지정, ${who(entry.target_id)}` : `접근 만료 해제, ${who(entry.target_id)}`,
    MEMBER_EXPIRED: `만료되어 내보냄, ${who(entry.target_id)}`,
  })[entry.action] ?? entry.action;

  return <View style={s.root}>
    <WorkspaceHeader title="멤버" onBack={navigation.goBack} />
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.title}>{ws.name}</Text>
      {state.error ? <Text accessibilityRole="alert" style={[s.error, { marginTop: 16 }]}>{state.error}</Text> : null}
      {!!actionError && !selected && <Text accessibilityRole="alert" style={[s.error, { marginTop: 16 }]}>{actionError}</Text>}

      {billing && <View style={s.section}>
        <View style={s.sectionHead}><Text accessibilityRole="header" style={s.sectionTitle}>결제</Text></View>
        <View style={s.menuRow}>
          <Icon name="card" size={18} color={c.muted} />
          <View style={{ flex: 1 }}>
            <Text style={s.rowTitle}>{billing.billing_account_id ? `${billing.is_me ? '나' : billing.billing_name || '이름 없음'}, ${billing.plan}` : `결제 주체 없음, ${billing.plan}`}</Text>
            
          </View>
        </View>
        {owner && !billing.is_me && <Pressable accessibilityRole="button" disabled={busy} onPress={() => setConfirm('billing')}
          style={({ pressed }) => [s.secondary, { alignSelf: 'flex-start', marginTop: 8 }, (pressed || busy) && { opacity: .5 }]}>
          <Text style={s.secondaryText}>내 요금제로 결제 주체 되기</Text></Pressable>}
      </View>}

      {!state.loading && <View style={s.section}>
        <View style={s.sectionHead}><Text accessibilityRole="header" style={s.sectionTitle}>멤버 {state.members.length}</Text></View>
        {state.members.map(m => {
          const mine = m.account_id === me, editable = owner && !mine;
          return <Pressable key={m.account_id} accessibilityRole={editable ? 'button' : undefined} disabled={!editable}
            accessibilityLabel={`${nameOf(m)}${mine ? '(나)' : ''}, ${ROLE_LABEL[m.role]}${m.expires_at ? `, ${day(m.expires_at)}까지` : ''}${editable ? ', 역할과 만료 설정 열기' : ''}`}
            onPress={() => { setActionError(''); setSelected(m.account_id); }}
            style={({ pressed }) => [s.menuRow, pressed && { opacity: .6 }]}>
            <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.raised, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: c.text, fontSize: 13 }}>{nameOf(m).trim().charAt(0)}</Text>
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={s.rowTitle}>{nameOf(m)}{mine ? ' (나)' : ''}</Text>
              {m.expires_at ? <Text style={[s.rowBody, { marginTop: 0 }]}>{day(m.expires_at)}까지</Text> : null}
            </View>
            <Text style={s.linkText}>{ROLE_LABEL[m.role]}</Text>
            {editable ? <Icon name="chevronDown" size={16} color={c.subtle} /> : null}
          </Pressable>;
        })}
      </View>}

      {owner && state.log.length > 0 && <View style={s.section}>
        <View style={s.sectionHead}><Text accessibilityRole="header" style={s.sectionTitle}>관리 기록</Text></View>
        {state.log.map(entry => <View key={entry.id} style={[s.row, { paddingVertical: 8 }]}>
          <Text style={[s.rowBody, { flex: 1, marginTop: 0 }]}>{logText(entry)}</Text>
          <Text style={[s.meta, { marginTop: 0 }]}>{day(entry.created_at)}</Text>
        </View>)}
        
      </View>}
    </ScrollView>

    <SheetModal visible={!!member} onClose={closeSheet} label="멤버 설정">
      <View style={s.handle} />
      {member && <ScrollView keyboardShouldPersistTaps="handled">
        <View style={s.titleRow}><Text style={s.sectionTitle}>{nameOf(member)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="멤버 설정 닫기" onPress={closeSheet} style={s.iconButton}><Icon name="x" size={20} color={c.muted} /></Pressable></View>
        {!!actionError && <Text accessibilityRole="alert" style={s.error}>{actionError}</Text>}
        <Text style={[s.meta, { marginBottom: 4 }]}>역할</Text>
        {ROLES.map(([code, label, desc]) => <Pressable key={code} accessibilityRole="radio" accessibilityState={{ checked: member.role === code, disabled: busy }}
          accessibilityLabel={`${label}: ${desc}`} disabled={busy || member.role === code}
          onPress={() => run(() => changeMemberRole(serverId, member.account_id, code))} style={[s.menuRow, busy && { opacity: .5 }]}>
          <View style={{ flex: 1 }}><Text style={s.rowTitle}>{label}</Text><Text style={[s.rowBody, { marginTop: 0 }]}>{desc}</Text></View>
          {member.role === code ? <Icon name="check" size={18} color={c.text} /> : null}
        </Pressable>)}
        {member.role !== 'OWNER' && <>
          <Text style={[s.meta, { marginTop: 16, marginBottom: 4 }]}>접근 만료{member.expires_at ? `, 지금 ${day(member.expires_at)}까지` : ''}</Text>
          {EXPIRY.map(([days, label]) => {
            const on = days === 0 && !member.expires_at;
            return <Pressable key={days} accessibilityRole="radio" accessibilityState={{ checked: on, disabled: busy }} accessibilityLabel={`접근 만료: ${label}`}
              disabled={busy || on} onPress={() => run(() => setMemberExpiry(serverId, member.account_id, days ? new Date(Date.now() + days * 86400000) : null))}
              style={[s.menuRow, busy && { opacity: .5 }]}>
              <Text style={s.menuLabel}>{label}</Text>{on ? <Icon name="check" size={18} color={c.text} /> : null}
            </Pressable>;
          })}
          <Text style={[s.note, { marginTop: 4 }]}>지나면 자동으로 내보내요.</Text>
        </>}
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setConfirm('remove')} style={[s.menuRow, { marginTop: 12 }, busy && { opacity: .5 }]}>
          <Icon name="userX" size={18} color={c.danger} /><Text style={[s.menuLabel, { color: c.danger }]}>공간에서 내보내기</Text>
        </Pressable>
      </ScrollView>}
    </SheetModal>

    <ConfirmDialog visible={confirm === 'billing'} title="결제 주체가 될까요?"
      sub="이 공간의 첨부 용량 등 혜택이 내 구독 요금제를 따라요. 지금 결제 주체의 요금제는 더 이상 적용되지 않아요."
      confirmText="결제 주체 되기" onCancel={() => setConfirm(null)}
      onConfirm={() => { setConfirm(null); run(() => claimWorkspaceBilling(serverId)); }} />
    <ConfirmDialog visible={confirm === 'remove' && !!member} title={`${nameOf(member)}님을 내보낼까요?`}
      sub="이 사람의 기기에서 공간이 사라지고, 다시 들어오려면 새 초대가 필요해요. 공간 기록은 그대로 남아요."
      confirmText="내보내기" danger onCancel={() => setConfirm(null)}
      onConfirm={async () => { setConfirm(null); if (await run(() => removeMember(serverId, member.account_id))) setSelected(null); }} />
  </View>;
}
