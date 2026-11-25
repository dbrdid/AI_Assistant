-- =====================================================================
-- 워크스페이스·프로젝트 알림 (11/25)
--   #34 푸시 알림(20261115060936)의 "알림 만들기"에 종류를 더함. 보내기(push-tick → push-send → Expo)는 그대로.
--
--   새 종류                    언제                                          받는 사람                         설정 키
--   WORKSPACE_ROLE_CHANGED     공간 역할이 바뀜                              그 멤버                           workspace
--   WORKSPACE_REMOVED          공간에서 내보내짐                             그 멤버                           workspace
--   WORKSPACE_DELETED          공간이 삭제됨                                 남아 있던 ACTIVE 멤버             workspace
--   PROJECT_MEMBER_ADDED       프로젝트 팀원으로 추가됨(계정 연결)           그 사람                           project
--   PROJECT_UPDATED            프로젝트 진행 상태·마감일·보관·삭제           프로젝트 팀원(없으면 공간 멤버)   project
--   PROJECT_ITEM_ADDED         프로젝트에 할 일·일정·메모가 들어옴           프로젝트 팀원(없으면 공간 멤버)   project
--   TASK_ASSIGNED              할 일 담당자(assignee_id)로 정해짐            담당자                            project
--
--   지키는 것
--   - 내가 한 일은 나에게 보내지 않음 (auth.uid() = 행동한 사람. cron·관리 작업처럼 사람이 없으면 모두에게)
--   - 알림 때문에 저장이 실패하지 않음: 트리거마다 오류를 잡아 경고만 남김 (sync_push·RPC는 그대로 성공)
--   - 몰아서 보내기: PROJECT_UPDATED·PROJECT_ITEM_ADDED는 2분 기다렸다 보내고, 그사이 같은 프로젝트·같은 사람의
--     같은 종류는 한 알림으로 합침("새 항목 3개가 추가됐어요"). 같은 기록은 한 번만 셈
--   - 내보내짐·공간 삭제 알림은 workspace_id를 비워 둠: 알림함(list_notifications)은 내가 멤버인 공간의 알림만
--     보여 주므로, 비워야 나간 뒤에도 알림함에 남음 (공간 id는 data.workspace_id에)
--   - 설정: 기존 workspace(공간 소식) + 새 project(프로젝트 소식, 기본 켬)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 종류 · 설정
-- ---------------------------------------------------------------------
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check check (kind in (
    'BRIEFING_DAILY', 'BRIEFING_WEEKLY', 'EVENT_REMINDER', 'TASK_REMINDER', 'PROJECT_REMINDER',
    'WORKSPACE_JOINED', 'RECORDING_DONE', 'INVITE', 'SYSTEM',
    'WORKSPACE_ROLE_CHANGED', 'WORKSPACE_REMOVED', 'WORKSPACE_DELETED',
    'PROJECT_MEMBER_ADDED', 'PROJECT_UPDATED', 'PROJECT_ITEM_ADDED', 'TASK_ASSIGNED'));

-- 몰아 보내기에서 "아직 안 보낸 같은 묶음" 찾기
create index if not exists notifications_group_idx on public.notifications (account_id, kind, (data ->> 'group'))
  where status = 'PENDING' and data ? 'group';

-- 기본값: project 추가 (일간 브리핑 09:00은 20261115071101 그대로)
create or replace function private.notification_defaults()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('push', true, 'workspace', true, 'recording', true, 'reminders', true, 'project', true,
    'briefing_daily', jsonb_build_object('on', false, 'time', '09:00'),
    'briefing_weekly', jsonb_build_object('on', false, 'day', 1, 'time', '09:00'))
$$;

create or replace function private.notification_category(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_kind in ('TASK_REMINDER', 'EVENT_REMINDER', 'PROJECT_REMINDER') then 'reminders'
    when p_kind in ('WORKSPACE_JOINED', 'INVITE', 'WORKSPACE_ROLE_CHANGED', 'WORKSPACE_REMOVED', 'WORKSPACE_DELETED') then 'workspace'
    when p_kind in ('PROJECT_MEMBER_ADDED', 'PROJECT_UPDATED', 'PROJECT_ITEM_ADDED', 'TASK_ASSIGNED') then 'project'
    when p_kind = 'RECORDING_DONE' then 'recording'
    when p_kind = 'BRIEFING_DAILY' then 'briefing_daily'
    when p_kind = 'BRIEFING_WEEKLY' then 'briefing_weekly'
    else 'system' end
$$;

/** 이 종류를 이 사람에게 보내도 되는지 (전체 끄기·종류별 끄기) */
create or replace function private.notification_allowed(p_account uuid, p_kind text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  v_set jsonb := private.notification_settings(p_account);
  v_cat text := private.notification_category(p_kind);
begin
  if not coalesce((v_set ->> 'push')::boolean, true) then return false; end if;
  if v_cat in ('reminders', 'workspace', 'recording', 'project') and not coalesce((v_set ->> v_cat)::boolean, true) then return false; end if;
  return true;
end $$;

-- 알림 하나 넣기 (20261115060936과 같고, project 설정을 봄)
create or replace function private.notify(p_account uuid, p_workspace uuid, p_kind text, p_title text, p_body text,
                                          p_data jsonb, p_dedupe text, p_ref_table text default null, p_ref_id uuid default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_ok boolean;
begin
  if not private.notification_allowed(p_account, p_kind) then return false; end if;
  insert into public.notifications (account_id, workspace_id, kind, ref_table, ref_id, title, body, data, dedupe_key)
  values (p_account, p_workspace, p_kind, p_ref_table, p_ref_id, left(p_title, 100), left(p_body, 300), coalesce(p_data, '{}'::jsonb), p_dedupe)
  on conflict (dedupe_key) where dedupe_key is not null do nothing
  returning true into v_ok;
  return coalesce(v_ok, false);
end $$;

/**
 * 몰아 보내기: 아직 안 보낸(PENDING·잠기지 않은) 같은 묶음(p_group)이 있으면 그 알림의 개수를 올리고 문구를 바꿈.
 * 없으면 p_delay 뒤에 보낼 알림을 새로 넣음. 같은 묶음에 같은 p_item은 한 번만 셈.
 *   p_many_body의 {n}은 합친 개수로 바뀜. 반환: 넣거나 합쳤으면 true
 */
create or replace function private.notify_grouped(p_account uuid, p_workspace uuid, p_kind text, p_title text,
                                                  p_first_body text, p_many_body text, p_data jsonb, p_group text, p_item text,
                                                  p_ref_table text default null, p_ref_id uuid default null,
                                                  p_delay interval default interval '2 minutes')
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_items jsonb;
  v_n integer;
begin
  if not private.notification_allowed(p_account, p_kind) then return false; end if;
  select n.id, coalesce(n.data -> 'items', '[]'::jsonb) into v_id, v_items
    from public.notifications n
   where n.account_id = p_account and n.kind = p_kind and n.status = 'PENDING' and n.locked_at is null
     and n.data ? 'group' and n.data ->> 'group' = p_group
   order by n.created_at desc limit 1
   for update;
  if v_id is not null then
    if v_items ? p_item then return true; end if;                 -- 이미 센 기록
    v_n := jsonb_array_length(v_items) + 1;
    update public.notifications
       set body = left(replace(p_many_body, '{n}', v_n::text), 300),
           data = data || jsonb_build_object('count', v_n,
                    'items', case when jsonb_array_length(v_items) >= 50 then v_items else v_items || to_jsonb(p_item) end)
     where id = v_id;
    return true;
  end if;
  insert into public.notifications (account_id, workspace_id, kind, ref_table, ref_id, title, body, data, scheduled_for)
  values (p_account, p_workspace, p_kind, p_ref_table, p_ref_id, left(p_title, 100), left(p_first_body, 300),
          coalesce(p_data, '{}'::jsonb) || jsonb_build_object('group', p_group, 'count', 1, 'items', jsonb_build_array(p_item)),
          now() + p_delay);
  return true;
end $$;

/** 바꿀 항목만 보내면 됨 (20261115060936과 같고, project를 받음). 반환: 저장된 전체 설정 */
create or replace function public.set_notification_settings(p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_cur jsonb;
  k text;
  v jsonb;
  b jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if jsonb_typeof(p_patch) is distinct from 'object' then
    raise exception 'INVALID_REQUEST: 설정은 객체로 보내 주세요' using errcode = '22023';
  end if;
  v_cur := private.notification_settings(v_uid);
  for k, v in select * from jsonb_each(p_patch) loop
    if k in ('push', 'workspace', 'recording', 'reminders', 'project') then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'INVALID_REQUEST: %는 true/false', k using errcode = '22023'; end if;
      v_cur := v_cur || jsonb_build_object(k, v);
    elsif k in ('briefing_daily', 'briefing_weekly') then
      if jsonb_typeof(v) <> 'object' then raise exception 'INVALID_REQUEST: %는 객체', k using errcode = '22023'; end if;
      b := v_cur -> k;
      if v ? 'on' then
        if jsonb_typeof(v -> 'on') <> 'boolean' then raise exception 'INVALID_REQUEST: %.on은 true/false', k using errcode = '22023'; end if;
        b := b || jsonb_build_object('on', v -> 'on');
      end if;
      if v ? 'time' then
        if coalesce(v ->> 'time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
          raise exception 'INVALID_REQUEST: %.time은 HH:MM (24시간)', k using errcode = '22023';
        end if;
        b := b || jsonb_build_object('time', v -> 'time');
      end if;
      if v ? 'day' then
        if k <> 'briefing_weekly' or jsonb_typeof(v -> 'day') <> 'number' or (v ->> 'day')::numeric not in (0, 1, 2, 3, 4, 5, 6) then
          raise exception 'INVALID_REQUEST: briefing_weekly.day는 0(일)~6(토)' using errcode = '22023';
        end if;
        b := b || jsonb_build_object('day', (v ->> 'day')::int);
      end if;
      v_cur := v_cur || jsonb_build_object(k, b);
    else
      raise exception 'INVALID_REQUEST: 모르는 알림 설정 %', k using errcode = '22023';
    end if;
  end loop;
  update public.user_settings
     set preferences = jsonb_set(coalesce(preferences, '{}'::jsonb), '{notifications}', v_cur, true)
   where account_id = v_uid;
  return v_cur;
end $$;

-- ---------------------------------------------------------------------
-- 2. 문구 도우미
-- ---------------------------------------------------------------------
create or replace function private.role_label(p_role text)
returns text language sql immutable set search_path = '' as $$
  select case p_role when 'OWNER' then '관리자' when 'EDITOR' then '멤버' when 'VIEWER' then '보기 전용' else p_role end
$$;

create or replace function private.progress_label(p_status text)
returns text language sql immutable set search_path = '' as $$
  select case p_status when 'TODO' then '진행 전' when 'IN_PROGRESS' then '진행 중' when 'DONE' then '완료'
                       when 'ON_HOLD' then '보류' when 'CANCELED' then '취소' else p_status end
$$;

/** 「제목」 (너무 길면 줄임) */
create or replace function private.quote_title(p_title text, p_fallback text default '제목 없음')
returns text language sql immutable set search_path = '' as $$
  select '「' || case when char_length(coalesce(nullif(btrim(p_title), ''), p_fallback)) > 30
                      then left(btrim(p_title), 29) || '…' else coalesce(nullif(btrim(p_title), ''), p_fallback) end || '」'
$$;

-- ---------------------------------------------------------------------
-- 3. 워크스페이스: 역할 변경 · 내보내짐
-- ---------------------------------------------------------------------
create or replace function private.notify_member_changed()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_ws text;
begin
  begin
    if new.account_id is not distinct from v_actor then return new; end if;   -- 내가 바꾼 내 상태
    select w.name into v_ws from public.workspaces w where w.id = new.workspace_id and w.deleted_at is null;
    if v_ws is null then return new; end if;

    if new.status = 'ACTIVE' and old.status = 'ACTIVE' and new.role is distinct from old.role then
      perform private.notify(new.account_id, new.workspace_id, 'WORKSPACE_ROLE_CHANGED', v_ws,
        '내 역할이 ' || private.role_label(new.role) || '(으)로 바뀌었어요',
        jsonb_build_object('type', 'workspace', 'workspace_id', new.workspace_id, 'role', new.role),
        'WORKSPACE_ROLE_CHANGED:' || new.workspace_id || ':' || new.account_id || ':' || new.role || ':' || (extract(epoch from now()) * 1000)::bigint);
    elsif old.status = 'ACTIVE' and new.status = 'REMOVED' then
      perform private.notify(new.account_id, null, 'WORKSPACE_REMOVED', v_ws,
        '공간에서 내보내졌어요. 이 공간의 기록은 더 볼 수 없어요',
        jsonb_build_object('type', 'workspace_closed', 'workspace_id', new.workspace_id),
        'WORKSPACE_REMOVED:' || new.workspace_id || ':' || new.account_id || ':' || (extract(epoch from coalesce(new.ended_at, now())) * 1000)::bigint);
    end if;
  exception when others then
    raise warning 'notify_member_changed: % %', sqlstate, sqlerrm;            -- 알림 오류로 멤버 변경이 막히지 않게
  end;
  return new;
end $$;
drop trigger if exists workspace_members_notify_changed on public.workspace_members;
create trigger workspace_members_notify_changed after update of role, status on public.workspace_members
  for each row execute function private.notify_member_changed();

-- ---------------------------------------------------------------------
-- 4. 워크스페이스: 삭제
-- ---------------------------------------------------------------------
create or replace function private.notify_workspace_deleted()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_to uuid;
begin
  begin
    if old.deleted_at is not null or new.deleted_at is null then return new; end if;
    for v_to in select m.account_id from public.workspace_members m
                 where m.workspace_id = new.id and m.status = 'ACTIVE' and m.account_id is distinct from v_actor loop
      perform private.notify(v_to, null, 'WORKSPACE_DELETED', new.name, '공간이 삭제됐어요',
        jsonb_build_object('type', 'workspace_closed', 'workspace_id', new.id),
        'WORKSPACE_DELETED:' || new.id || ':' || v_to);
    end loop;
  exception when others then
    raise warning 'notify_workspace_deleted: % %', sqlstate, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists workspaces_notify_deleted on public.workspaces;
create trigger workspaces_notify_deleted after update of deleted_at on public.workspaces
  for each row execute function private.notify_workspace_deleted();

-- ---------------------------------------------------------------------
-- 5. 프로젝트: 팀원으로 추가됨
--    새로 추가, 다른 프로젝트에서 옮겨 옴, 이름만 있던 팀원에 계정을 연결, 지웠던 팀원을 되살림
-- ---------------------------------------------------------------------
create or replace function private.notify_project_member_added()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_project text;
  v_ws text;
begin
  begin
    if new.account_id is null or new.deleted_at is not null or new.account_id is not distinct from v_actor then return new; end if;
    if tg_op = 'UPDATE' and old.account_id is not distinct from new.account_id and old.project_id = new.project_id
       and old.deleted_at is null then return new; end if;                    -- 역할·이름만 바뀜
    if not exists (select 1 from public.workspace_members m
                    where m.workspace_id = new.workspace_id and m.account_id = new.account_id and m.status = 'ACTIVE') then return new; end if;
    select p.name, w.name into v_project, v_ws
      from public.projects p join public.workspaces w on w.id = p.workspace_id and w.deleted_at is null
     where p.workspace_id = new.workspace_id and p.id = new.project_id and p.deleted_at is null;
    if v_project is null then return new; end if;
    perform private.notify(new.account_id, new.workspace_id, 'PROJECT_MEMBER_ADDED', v_project,
      v_ws || ' · 프로젝트 팀원으로 추가됐어요 (' || new.role || ')',
      jsonb_build_object('type', 'projects', 'workspace_id', new.workspace_id, 'id', new.project_id),
      'PROJECT_MEMBER_ADDED:' || new.id || ':' || new.project_id || ':' || new.account_id,
      'projects', new.project_id);
  exception when others then
    raise warning 'notify_project_member_added: % %', sqlstate, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists project_members_notify_added on public.project_members;
create trigger project_members_notify_added after insert or update of account_id, project_id, deleted_at on public.project_members
  for each row execute function private.notify_project_member_added();

-- ---------------------------------------------------------------------
-- 6. 프로젝트: 진행 상태 · 마감일 · 보관 · 삭제
-- ---------------------------------------------------------------------
create or replace function private.notify_project_updated()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_ws text;
  v_change text;
  v_to uuid;
begin
  begin
    select w.name into v_ws from public.workspaces w where w.id = new.workspace_id and w.deleted_at is null;
    if v_ws is null then return new; end if;

    if old.deleted_at is null and new.deleted_at is not null then
      for v_to in select r from private.item_recipients(new.workspace_id, new.id) r where r is distinct from v_actor loop
        perform private.notify(v_to, new.workspace_id, 'PROJECT_UPDATED', new.name, v_ws || ' · 프로젝트가 휴지통으로 옮겨졌어요',
          jsonb_build_object('type', 'projects', 'workspace_id', new.workspace_id, 'id', new.id),
          'PROJECT_DELETED:' || new.id || ':' || v_to || ':' || (extract(epoch from new.deleted_at) * 1000)::bigint, 'projects', new.id);
      end loop;
      return new;
    end if;
    if new.deleted_at is not null then return new; end if;

    v_change := case
      when new.progress_status is distinct from old.progress_status then '진행 상태가 ' || private.progress_label(new.progress_status) || '(으)로 바뀌었어요'
      when new.due_date is distinct from old.due_date then
        case when new.due_date is null then '마감일이 지워졌어요' else '마감일이 ' || to_char(new.due_date, 'FMMM"월" FMDD"일"') || '로 바뀌었어요' end
      when new.status is distinct from old.status then
        case when new.status = 'ARCHIVED' then '프로젝트가 보관됐어요' else '보관했던 프로젝트를 다시 열었어요' end
      else null end;
    if v_change is null then return new; end if;

    for v_to in select r from private.item_recipients(new.workspace_id, new.id) r where r is distinct from v_actor loop
      perform private.notify_grouped(v_to, new.workspace_id, 'PROJECT_UPDATED', new.name,
        v_ws || ' · ' || v_change, v_ws || ' · 프로젝트 정보가 {n}번 바뀌었어요',
        jsonb_build_object('type', 'projects', 'workspace_id', new.workspace_id, 'id', new.id),
        'PROJECT_UPDATED:' || new.id, 'rev:' || new.revision, 'projects', new.id);
    end loop;
  exception when others then
    raise warning 'notify_project_updated: % %', sqlstate, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists projects_notify_updated on public.projects;
create trigger projects_notify_updated after update of progress_status, due_date, status, deleted_at on public.projects
  for each row execute function private.notify_project_updated();

-- ---------------------------------------------------------------------
-- 7. 프로젝트: 새 항목 (할 일 · 일정 · 메모 연결)
-- ---------------------------------------------------------------------
/**
 * 항목 하나가 프로젝트에 들어옴 → 팀원에게 몰아서.
 * 프로젝트를 같은 저장(같은 트랜잭션)에서 만들었으면 보내지 않음: 새 프로젝트를 만들며 팀원·할 일을 한 번에 넣는
 * 앱 흐름에서 "팀원으로 추가됐어요"와 겹치지 않게
 */
create or replace function private.notify_project_item(p_workspace uuid, p_project uuid, p_label text, p_title text, p_item text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_project text;
  v_created timestamptz;
  v_ws text;
  v_to uuid;
begin
  select p.name, p.created_at, w.name into v_project, v_created, v_ws
    from public.projects p join public.workspaces w on w.id = p.workspace_id and w.deleted_at is null
   where p.workspace_id = p_workspace and p.id = p_project and p.deleted_at is null;
  if v_project is null or v_created = now() then return; end if;    -- now() = 이 트랜잭션 시작 시각
  for v_to in select r from private.item_recipients(p_workspace, p_project) r where r is distinct from v_actor loop
    perform private.notify_grouped(v_to, p_workspace, 'PROJECT_ITEM_ADDED', v_project,
      v_ws || ' · ' || p_label || ' ' || private.quote_title(p_title) || '이(가) 추가됐어요',
      v_ws || ' · 새 항목 {n}개가 추가됐어요',
      jsonb_build_object('type', 'projects', 'workspace_id', p_workspace, 'id', p_project),
      'PROJECT_ITEM_ADDED:' || p_project, p_item, 'projects', p_project);
  end loop;
end $$;

create or replace function private.notify_task_event_added()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.project_id is null or new.deleted_at is not null then return new; end if;
    if tg_op = 'UPDATE' and old.project_id is not distinct from new.project_id then return new; end if;
    perform private.notify_project_item(new.workspace_id, new.project_id,
      case tg_table_name when 'tasks' then '할 일' else '일정' end, new.title, tg_table_name || ':' || new.id);
  exception when others then
    raise warning 'notify_task_event_added: % %', sqlstate, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists tasks_notify_project_item on public.tasks;
create trigger tasks_notify_project_item after insert or update of project_id on public.tasks
  for each row execute function private.notify_task_event_added();
drop trigger if exists events_notify_project_item on public.events;
create trigger events_notify_project_item after insert or update of project_id on public.events
  for each row execute function private.notify_task_event_added();

create or replace function private.notify_note_linked()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_title text;
begin
  begin
    select n.title into v_title from public.notes n
     where n.workspace_id = new.workspace_id and n.id = new.note_id and n.deleted_at is null;
    if not found then return new; end if;
    perform private.notify_project_item(new.workspace_id, new.project_id, '메모', coalesce(v_title, '제목 없는 메모'), 'notes:' || new.note_id);
  exception when others then
    raise warning 'notify_note_linked: % %', sqlstate, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists note_projects_notify_linked on public.note_projects;
create trigger note_projects_notify_linked after insert on public.note_projects
  for each row execute function private.notify_note_linked();

-- ---------------------------------------------------------------------
-- 8. 할 일 담당자
-- ---------------------------------------------------------------------
create or replace function private.notify_task_assigned()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_ws text;
begin
  begin
    if new.assignee_id is null or new.deleted_at is not null or new.assignee_id is not distinct from v_actor then return new; end if;
    if tg_op = 'UPDATE' and old.assignee_id is not distinct from new.assignee_id then return new; end if;
    if not exists (select 1 from public.workspace_members m
                    where m.workspace_id = new.workspace_id and m.account_id = new.assignee_id and m.status = 'ACTIVE') then return new; end if;
    select w.name into v_ws from public.workspaces w where w.id = new.workspace_id and w.deleted_at is null;
    if v_ws is null then return new; end if;
    perform private.notify(new.assignee_id, new.workspace_id, 'TASK_ASSIGNED', new.title,
      v_ws || ' · 할 일 담당자로 정해졌어요' || case when new.due_at is not null
        then ' (마감 ' || to_char(new.due_at at time zone 'Asia/Seoul', 'FMMM"월" FMDD"일"') || ')' else '' end,
      jsonb_build_object('type', 'tasks', 'workspace_id', new.workspace_id, 'id', new.id),
      'TASK_ASSIGNED:' || new.id || ':' || new.assignee_id || ':' || new.revision, 'tasks', new.id);
  exception when others then
    raise warning 'notify_task_assigned: % %', sqlstate, sqlerrm;
  end;
  return new;
end $$;
drop trigger if exists tasks_notify_assigned on public.tasks;
create trigger tasks_notify_assigned after insert or update of assignee_id on public.tasks
  for each row execute function private.notify_task_assigned();

-- ---------------------------------------------------------------------
-- 9. 권한: 새 내부 함수는 앱이 직접 부를 수 없음
-- ---------------------------------------------------------------------
revoke all on function private.notification_allowed(uuid, text),
  private.notify_grouped(uuid, uuid, text, text, text, text, jsonb, text, text, text, uuid, interval),
  private.role_label(text), private.progress_label(text), private.quote_title(text, text),
  private.notify_member_changed(), private.notify_workspace_deleted(), private.notify_project_member_added(),
  private.notify_project_updated(), private.notify_project_item(uuid, uuid, text, text, text),
  private.notify_task_event_added(), private.notify_note_linked(), private.notify_task_assigned()
  from public, anon, authenticated;
