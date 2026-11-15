-- =====================================================================
-- 공유 공간 변경 신호 (Realtime Broadcast, 비공개 채널)
--
--   주제(topic): 'workspace:<공간 id 소문자>'
--   이벤트:     'changed' → {workspace_id, last_seq}   공간 순번이 올라갈 때 (기록 저장, 멤버 변경)
--               'closed'  → {workspace_id, closed: true} 공간이 삭제될 때
--   신호에는 데이터를 싣지 않음. 앱은 신호를 받으면 sync_pull로 받아 옴 (권한은 sync_pull이 다시 확인)
--
--   받기: 그 공간의 ACTIVE 멤버만 (realtime.messages RLS, broadcast만)
--   보내기: 서버 트리거만. 클라이언트용 INSERT 정책이 없으므로 앱은 이 주제로 보낼 수 없음
--
--   알아둘 점: 채널 권한은 구독(join)할 때 확인됨. 연결 중에 내보내진 사람은 다시 연결하기 전까지
--             숫자 신호만 더 받을 수 있고, 데이터는 sync_pull이 막음 (FORBIDDEN → 앱이 공간을 닫음)
--   realtime.send는 실패해도 경고만 남기므로, 신호 실패가 저장(sync_push)을 막지 않음
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 보내기 (트리거)
-- ---------------------------------------------------------------------
create or replace function private.signal_workspace_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('workspace_id', new.workspace_id, 'last_seq', new.last_seq),
    'changed',
    'workspace:' || new.workspace_id::text,
    true);
  return null;
end $$;

create or replace function private.signal_workspace_closed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform realtime.send(
    jsonb_build_object('workspace_id', new.id, 'closed', true),
    'closed',
    'workspace:' || new.id::text,
    true);
  return null;
end $$;

revoke all on function private.signal_workspace_change() from public, anon, authenticated;
revoke all on function private.signal_workspace_closed() from public, anon, authenticated;

drop trigger if exists workspace_heads_signal on public.workspace_sync_heads;
create trigger workspace_heads_signal
  after update of last_seq on public.workspace_sync_heads
  for each row when (new.last_seq > old.last_seq)
  execute function private.signal_workspace_change();

drop trigger if exists workspaces_closed_signal on public.workspaces;
create trigger workspaces_closed_signal
  after update of deleted_at on public.workspaces
  for each row when (old.deleted_at is null and new.deleted_at is not null)
  execute function private.signal_workspace_closed();

-- ---------------------------------------------------------------------
-- 2. 받기 권한: 주제가 'workspace:<uuid>'이고 그 공간의 ACTIVE 멤버일 때만
-- ---------------------------------------------------------------------
create or replace function private.can_listen_workspace(p_topic text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if p_topic is null
     or p_topic !~ '^workspace:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  return private.is_active_member(substr(p_topic, 11)::uuid);
end $$;

revoke all on function private.can_listen_workspace(text) from public, anon;
grant execute on function private.can_listen_workspace(text) to authenticated;

drop policy if exists "workspace members receive change signals" on realtime.messages;
create policy "workspace members receive change signals"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and private.can_listen_workspace((select realtime.topic()))
  );
