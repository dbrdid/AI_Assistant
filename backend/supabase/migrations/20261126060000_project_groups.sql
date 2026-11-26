-- 프로젝트 그룹과 그룹별 권한 (서버에서 막기)
--
-- 1) project_groups: 프로젝트 안의 그룹 (이름·색·순서)
-- 2) project_group_members: 그룹에 속한 프로젝트 멤버와 권한 view(보기) · edit(편집) · manage(관리)
-- 3) item_group_access: 문서(notes)·할 일(tasks)을 볼 수 있는 그룹. 없으면 지금처럼 공간 멤버 모두
--
-- 볼 수 있는 사람: 제한이 없거나 / 만든 사람 / 공간 OWNER / 그 그룹 프로젝트의 팀장 / 그 그룹 멤버
-- 고칠 수 있는 사람: 위에서 보기(view)만 있는 사람은 제외. 제한 없는 항목은 지금 규칙 그대로
--
-- 서버가 막는 곳: sync_pull·sync_snapshot(안 보이는 항목은 보내지 않음), 표 직접 읽기(RLS),
--   notes·tasks 수정·삭제(트리거). 메모의 원문(input_sources·source_text_versions)과 메모 연결 행도 같이 숨김
-- 그룹·권한이 바뀌면 workspace_access_marks.changed_seq를 올려서, 그보다 이전 커서로 받는 기기는
--   SNAPSHOT_REQUIRED → 전체 다시 받기 (새로 보이게 된 항목은 받고, 안 보이게 된 항목은 기기에서 지워짐)
-- 그룹 수 한도(구독)는 아직 없음 (추후)

-- ---------------------------------------------------------------------
-- 표
-- ---------------------------------------------------------------------
create table public.project_groups (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  project_id    uuid not null,
  name          text not null check (char_length(btrim(name)) between 1 and 20),
  color         text not null default '#8B8BF5' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  position      integer not null default 0,
  revision      bigint not null default 1,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (workspace_id, id),
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete cascade
);
create index project_groups_project_idx on public.project_groups (workspace_id, project_id);

create table public.project_group_members (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  group_id      uuid not null,
  member_id     uuid not null,
  access        text not null default 'edit' check (access in ('view', 'edit', 'manage')),
  revision      bigint not null default 1,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (group_id, member_id),
  foreign key (workspace_id, group_id)  references public.project_groups (workspace_id, id) on delete cascade,
  foreign key (workspace_id, member_id) references public.project_members (workspace_id, id) on delete cascade
);
create index project_group_members_member_idx on public.project_group_members (workspace_id, member_id);

create table public.item_group_access (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  entity        text not null check (entity in ('notes', 'tasks')),
  entity_key    uuid not null,
  group_id      uuid not null,
  revision      bigint not null default 1,
  created_by    uuid not null references public.accounts (id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (entity, entity_key, group_id),
  foreign key (workspace_id, group_id) references public.project_groups (workspace_id, id) on delete cascade
);
create index item_group_access_item_idx on public.item_group_access (workspace_id, entity, entity_key) where deleted_at is null;

-- 권한이 마지막으로 바뀐 서버 순번 (이보다 앞선 커서는 전체 다시 받기)
create table public.workspace_access_marks (
  workspace_id  uuid primary key references public.workspaces (id) on delete cascade,
  changed_seq   bigint not null default 0
);

-- 변경 기록에 그룹 표 3개도 남길 수 있게
alter table public.workspace_changes drop constraint workspace_changes_entity_table_check;
alter table public.workspace_changes add constraint workspace_changes_entity_table_check
  check (entity_table in (
    'projects', 'project_participants', 'input_sources', 'source_text_versions',
    'notes', 'note_projects', 'tasks', 'events',
    'meetings', 'agenda_items', 'agenda_transitions', 'workspace_members', 'assets',
    'note_attachments', 'project_members', 'project_invites', 'project_files',
    'project_groups', 'project_group_members', 'item_group_access'));

alter table public.project_groups         enable row level security;
alter table public.project_group_members  enable row level security;
alter table public.item_group_access      enable row level security;
alter table public.workspace_access_marks enable row level security;   -- 정책 없음: 아래 함수만 씀

create policy project_groups_select_member on public.project_groups
  for select to authenticated using (private.is_active_member(workspace_id));
create policy project_group_members_select_member on public.project_group_members
  for select to authenticated using (private.is_active_member(workspace_id));
create policy item_group_access_select_member on public.item_group_access
  for select to authenticated using (private.is_active_member(workspace_id));

-- ---------------------------------------------------------------------
-- 권한 계산
-- ---------------------------------------------------------------------
-- 항목 권한: null(못 봄) · 'view' · 'edit' · 'manage' · 'open'(제한 없음: 지금 규칙)
create or replace function private.item_access(p_ws uuid, p_entity text, p_key uuid, p_creator uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_best integer;
begin
  if not exists (select 1 from public.item_group_access a
                  where a.workspace_id = p_ws and a.entity = p_entity and a.entity_key = p_key and a.deleted_at is null) then
    return 'open';
  end if;
  if v_uid is null then return 'manage'; end if;   -- 서버 작업(서비스 키·예약 작업)
  if p_creator = v_uid
     or exists (select 1 from public.workspace_members m
                 where m.workspace_id = p_ws and m.account_id = v_uid and m.status = 'ACTIVE' and m.role = 'OWNER')
     or exists (select 1 from public.item_group_access a
                  join public.project_groups g on g.workspace_id = a.workspace_id and g.id = a.group_id and g.deleted_at is null
                 where a.workspace_id = p_ws and a.entity = p_entity and a.entity_key = p_key and a.deleted_at is null
                   and private.is_project_leader(p_ws, g.project_id, v_uid)) then
    return 'manage';
  end if;
  select max(case gm.access when 'manage' then 3 when 'edit' then 2 else 1 end) into v_best
    from public.item_group_access a
    join public.project_groups g         on g.workspace_id = a.workspace_id and g.id = a.group_id and g.deleted_at is null
    join public.project_group_members gm on gm.workspace_id = a.workspace_id and gm.group_id = a.group_id and gm.deleted_at is null
    join public.project_members pm       on pm.workspace_id = gm.workspace_id and pm.id = gm.member_id and pm.deleted_at is null
   where a.workspace_id = p_ws and a.entity = p_entity and a.entity_key = p_key and a.deleted_at is null
     and pm.account_id = v_uid;
  return case v_best when 3 then 'manage' when 2 then 'edit' when 1 then 'view' end;
end $$;

create or replace function private.note_visible(p_ws uuid, p_note uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_note is null or coalesce((select private.item_access(p_ws, 'notes', n.id, n.created_by) is not null
                                       from public.notes n where n.workspace_id = p_ws and n.id = p_note), true)
$$;

-- 메모 원문: 그 원문을 쓰는 메모 중 하나라도 안 보이면 숨김
create or replace function private.source_visible(p_ws uuid, p_source uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_source is null or not exists (
    select 1 from public.notes n
     where n.workspace_id = p_ws and n.source_id = p_source
       and private.item_access(p_ws, 'notes', n.id, n.created_by) is null)
$$;

-- 변경 기록 한 줄을 이 사람에게 보내도 되는지 (data가 없으면 id만 가니 보냄)
create or replace function private.change_visible(p_ws uuid, p_entity text, p_key text, p_data jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if p_data is null then return true; end if;
  return case p_entity
    when 'notes' then private.item_access(p_ws, 'notes', p_key::uuid, (p_data ->> 'created_by')::uuid) is not null
    when 'tasks' then private.item_access(p_ws, 'tasks', p_key::uuid, (p_data ->> 'created_by')::uuid) is not null
    when 'note_projects'        then private.note_visible(p_ws, (p_data ->> 'note_id')::uuid)
    when 'note_attachments'     then private.note_visible(p_ws, (p_data ->> 'note_id')::uuid)
    when 'input_sources'        then private.source_visible(p_ws, p_key::uuid)
    when 'source_text_versions' then private.source_visible(p_ws, (p_data ->> 'source_id')::uuid)
    else true end;
end $$;

-- 그룹을 관리할 수 있는지: 프로젝트 관리자(OWNER·팀장·팀장 없음) 또는 그 그룹(없으면 프로젝트의 어느 그룹)의 manage
create or replace function private.can_manage_group(p_ws uuid, p_project uuid, p_group uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.workspace_members m
                  where m.workspace_id = p_ws and m.account_id = (select auth.uid()) and m.status = 'ACTIVE' and m.role in ('OWNER', 'EDITOR'))
     and (private.can_manage_project(p_ws, p_project, (select auth.uid()))
          or exists (select 1 from public.project_group_members gm
                       join public.project_groups g  on g.workspace_id = gm.workspace_id and g.id = gm.group_id and g.deleted_at is null
                       join public.project_members pm on pm.workspace_id = gm.workspace_id and pm.id = gm.member_id and pm.deleted_at is null
                      where gm.workspace_id = p_ws and g.project_id = p_project and gm.deleted_at is null and gm.access = 'manage'
                        and pm.account_id = (select auth.uid()) and (p_group is null or gm.group_id = p_group)))
$$;

-- 권한이 바뀐 지점 기록 (변경 기록을 남긴 뒤에 부름)
create or replace function private.mark_access_changed(p_ws uuid)
returns void language sql security definer set search_path = '' as $$
  insert into public.workspace_access_marks (workspace_id, changed_seq)
  select p_ws, h.last_seq from public.workspace_sync_heads h where h.workspace_id = p_ws
  on conflict (workspace_id) do update set changed_seq = excluded.changed_seq
$$;

revoke all on function private.item_access(uuid, text, uuid, uuid), private.note_visible(uuid, uuid),
  private.source_visible(uuid, uuid), private.change_visible(uuid, text, text, jsonb),
  private.can_manage_group(uuid, uuid, uuid), private.mark_access_changed(uuid) from public, anon, authenticated;
-- 표 읽기 정책(RLS)이 로그인 사용자 권한으로 부르므로 이 셋은 허용 (참·거짓/권한 이름만 돌려줌)
grant execute on function private.item_access(uuid, text, uuid, uuid), private.note_visible(uuid, uuid),
  private.source_visible(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 수정·삭제 막기: 보기 권한만 있거나 못 보는 항목
-- ---------------------------------------------------------------------
create or replace function private.guard_item_edit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  if (select auth.uid()) is null then return coalesce(new, old); end if;
  v_access := private.item_access(old.workspace_id, tg_table_name, old.id, old.created_by);
  if v_access is null or v_access = 'view' then
    raise exception 'FORBIDDEN: 이 항목을 고칠 권한이 없어요' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger notes_guard_group_edit before update or delete on public.notes
  for each row execute function private.guard_item_edit();
create trigger tasks_guard_group_edit before update or delete on public.tasks
  for each row execute function private.guard_item_edit();

-- ---------------------------------------------------------------------
-- 표 직접 읽기도 같은 기준
-- ---------------------------------------------------------------------
alter policy notes_select_member on public.notes
  using (private.is_active_member(workspace_id) and private.item_access(workspace_id, 'notes', id, created_by) is not null);
alter policy tasks_select_member on public.tasks
  using (private.is_active_member(workspace_id) and private.item_access(workspace_id, 'tasks', id, created_by) is not null);
alter policy note_projects_select_member on public.note_projects
  using (private.is_active_member(workspace_id) and private.note_visible(workspace_id, note_id));
alter policy note_attachments_select_member on public.note_attachments
  using (private.is_active_member(workspace_id) and private.note_visible(workspace_id, note_id));
alter policy input_sources_select_member on public.input_sources
  using (private.is_active_member(workspace_id) and private.source_visible(workspace_id, id));
alter policy source_text_versions_select_member on public.source_text_versions
  using (private.is_active_member(workspace_id) and private.source_visible(workspace_id, source_id));

-- 전체 받기: 지금 서버 정의 그대로에 보이는 항목만 + 그룹 표 3개
CREATE OR REPLACE FUNCTION public.sync_snapshot(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_head   public.workspace_sync_heads%rowtype;
  v_epoch  bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not private.is_active_member(p_workspace_id) then
    raise exception 'FORBIDDEN: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '42501';
  end if;

  select * into v_head from public.workspace_sync_heads where workspace_id = p_workspace_id for share;
  select auth_epoch into v_epoch from public.workspaces where id = p_workspace_id;

  return jsonb_build_object(
    'status', 'OK',
    'as_of_seq', v_head.last_seq,
    'auth_epoch', v_epoch,
    'workspace', (select to_jsonb(w) from public.workspaces w where w.id = p_workspace_id),
    'members', (select coalesce(jsonb_agg(jsonb_build_object(
                   'account_id', m.account_id, 'role', m.role, 'status', m.status,
                   'display_name', p.display_name, 'avatar_path', p.avatar_path)), '[]'::jsonb)
                  from public.workspace_members m
                  left join public.profiles p on p.account_id = m.account_id
                 where m.workspace_id = p_workspace_id),
    'projects',             (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.projects t             where t.workspace_id = p_workspace_id),
    'project_members',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_members t      where t.workspace_id = p_workspace_id),
    'project_invites',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_invites t      where t.workspace_id = p_workspace_id),
    'project_participants', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_participants t where t.workspace_id = p_workspace_id),
    'input_sources',         (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.input_sources t where t.workspace_id = p_workspace_id and private.source_visible(p_workspace_id, t.id)),
    'source_text_versions',  (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.source_text_versions t where t.workspace_id = p_workspace_id and private.source_visible(p_workspace_id, t.source_id)),
    'notes',                 (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.notes t where t.workspace_id = p_workspace_id and private.item_access(p_workspace_id, 'notes', t.id, t.created_by) is not null),
    'note_projects',         (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.note_projects t where t.workspace_id = p_workspace_id and private.note_visible(p_workspace_id, t.note_id)),
    'note_attachments',      (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.note_attachments t where t.workspace_id = p_workspace_id and private.note_visible(p_workspace_id, t.note_id)),
    'project_files',        (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_files t        where t.workspace_id = p_workspace_id),
    'assets',               (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.assets t               where t.workspace_id = p_workspace_id and t.status = 'AVAILABLE'),
    'tasks',                 (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.tasks t where t.workspace_id = p_workspace_id and private.item_access(p_workspace_id, 'tasks', t.id, t.created_by) is not null),
    'events',               (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.events t               where t.workspace_id = p_workspace_id),
    'meetings',             (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.meetings t             where t.workspace_id = p_workspace_id),
    'agenda_items',         (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.agenda_items t         where t.workspace_id = p_workspace_id),
    'agenda_transitions',   (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.agenda_transitions t   where t.workspace_id = p_workspace_id),
    'project_groups',        (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_groups t where t.workspace_id = p_workspace_id and true),
    'project_group_members', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_group_members t where t.workspace_id = p_workspace_id and true),
    'item_group_access',     (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.item_group_access t where t.workspace_id = p_workspace_id and true)
  );
end $function$;

-- ---------------------------------------------------------------------
-- 받기: 안 보이는 항목은 빼고 보냄. 순번(next_seq)은 빼기 전 기준이라 같은 곳을 되풀이하지 않음
-- 권한이 바뀐 지점보다 앞선 커서는 전체 다시 받기
-- ---------------------------------------------------------------------
create or replace function public.sync_pull(p_workspace_id uuid, p_after_seq bigint, p_limit integer default 500)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_head     public.workspace_sync_heads%rowtype;
  v_epoch    bigint;
  v_limit    integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
  v_changes  jsonb;
  v_next     bigint;
  v_mark     bigint;
begin
  if (select auth.uid()) is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if not private.is_active_member(p_workspace_id) then
    raise exception 'FORBIDDEN: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '42501';
  end if;

  select * into v_head from public.workspace_sync_heads where workspace_id = p_workspace_id;
  select auth_epoch into v_epoch from public.workspaces where id = p_workspace_id;
  select changed_seq into v_mark from public.workspace_access_marks where workspace_id = p_workspace_id;

  if p_after_seq is null or p_after_seq < v_head.min_retained_seq or p_after_seq > v_head.last_seq
     or p_after_seq < coalesce(v_mark, 0) then
    return jsonb_build_object(
      'status', 'SNAPSHOT_REQUIRED',
      'last_seq', v_head.last_seq, 'min_retained_seq', v_head.min_retained_seq, 'auth_epoch', v_epoch);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', c.seq, 'entity', c.entity_table, 'key', c.entity_key, 'op', c.op,
           'revision', c.revision, 'data', c.data, 'operation_id', c.operation_id,
           'actor_id', c.actor_id, 'committed_at', c.committed_at) order by c.seq)
           filter (where private.change_visible(p_workspace_id, c.entity_table, c.entity_key, c.data)), '[]'::jsonb),
         max(c.seq)
    into v_changes, v_next
    from (select *
            from public.workspace_changes
           where workspace_id = p_workspace_id and seq > p_after_seq
           order by seq
           limit v_limit) c;

  v_next := coalesce(v_next, p_after_seq);
  return jsonb_build_object(
    'status', 'OK', 'changes', v_changes,
    'next_seq', v_next, 'has_more', v_next < v_head.last_seq,
    'last_seq', v_head.last_seq, 'auth_epoch', v_epoch);
end $$;

-- ---------------------------------------------------------------------
-- 그룹 관리 (화면에서 부름). 바뀐 행은 변경 기록으로 다른 기기에 전달
-- ---------------------------------------------------------------------
-- 그룹 만들기·이름/색 바꾸기. p_group_id가 없으면 새로 만듦
create or replace function public.save_project_group(
  p_workspace_id uuid, p_project_id uuid, p_name text, p_color text default null, p_group_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_row public.project_groups%rowtype;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if not exists (select 1 from public.projects where workspace_id = p_workspace_id and id = p_project_id and deleted_at is null) then
    raise exception 'NOT_FOUND: 프로젝트가 없어요' using errcode = 'P0002';
  end if;
  if not private.can_manage_group(p_workspace_id, p_project_id, p_group_id) then
    raise exception 'FORBIDDEN: 그룹을 관리할 권한이 없어요' using errcode = '42501';
  end if;
  if p_group_id is null then
    insert into public.project_groups (workspace_id, project_id, name, color, position, created_by)
    values (p_workspace_id, p_project_id, btrim(p_name), coalesce(p_color, '#8B8BF5'),
            coalesce((select max(position) + 1 from public.project_groups where project_id = p_project_id), 0), v_uid)
    returning * into v_row;
  else
    update public.project_groups
       set name = btrim(p_name), color = coalesce(p_color, color), revision = revision + 1, updated_at = now()
     where workspace_id = p_workspace_id and id = p_group_id and project_id = p_project_id and deleted_at is null
    returning * into v_row;
    if v_row.id is null then raise exception 'NOT_FOUND: 그룹이 없어요' using errcode = 'P0002'; end if;
  end if;
  perform private.log_row_change(p_workspace_id, 'project_groups', v_row.id::text, to_jsonb(v_row), v_uid);
  return to_jsonb(v_row);
end $$;

-- 그룹 삭제: 그룹·소속·공개 범위를 함께 지움 (그 그룹에만 공개된 항목은 다시 모두에게 보임)
create or replace function public.delete_project_group(p_workspace_id uuid, p_group_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_row public.project_groups%rowtype; r record;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  select * into v_row from public.project_groups where workspace_id = p_workspace_id and id = p_group_id and deleted_at is null;
  if v_row.id is null then raise exception 'NOT_FOUND: 그룹이 없어요' using errcode = 'P0002'; end if;
  if not private.can_manage_project(p_workspace_id, v_row.project_id, v_uid)
     or not private.can_manage_group(p_workspace_id, v_row.project_id, null) then
    raise exception 'FORBIDDEN: 그룹을 삭제할 권한이 없어요' using errcode = '42501';
  end if;
  for r in update public.project_group_members set deleted_at = now(), revision = revision + 1, updated_at = now()
            where group_id = p_group_id and deleted_at is null returning * loop
    perform private.log_row_change(p_workspace_id, 'project_group_members', r.id::text, to_jsonb(r), v_uid);
  end loop;
  for r in update public.item_group_access set deleted_at = now(), revision = revision + 1, updated_at = now()
            where group_id = p_group_id and deleted_at is null returning * loop
    perform private.log_row_change(p_workspace_id, 'item_group_access', r.id::text, to_jsonb(r), v_uid);
  end loop;
  update public.project_groups set deleted_at = now(), revision = revision + 1, updated_at = now()
   where id = p_group_id returning * into v_row;
  perform private.log_row_change(p_workspace_id, 'project_groups', v_row.id::text, to_jsonb(v_row), v_uid);
  perform private.mark_access_changed(p_workspace_id);
end $$;

-- 그룹 멤버 넣기·권한 바꾸기·빼기 (p_access가 null이면 뺌)
create or replace function public.set_group_member(p_workspace_id uuid, p_group_id uuid, p_member_id uuid, p_access text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_group public.project_groups%rowtype; v_row public.project_group_members%rowtype;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_access is not null and p_access not in ('view', 'edit', 'manage') then
    raise exception 'INVALID_REQUEST: 권한은 view·edit·manage 중 하나예요' using errcode = '22023';
  end if;
  select * into v_group from public.project_groups where workspace_id = p_workspace_id and id = p_group_id and deleted_at is null;
  if v_group.id is null then raise exception 'NOT_FOUND: 그룹이 없어요' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.project_members where workspace_id = p_workspace_id and id = p_member_id
                    and project_id = v_group.project_id and deleted_at is null) then
    raise exception 'NOT_FOUND: 이 프로젝트의 멤버가 아니에요' using errcode = 'P0002';
  end if;
  if not private.can_manage_group(p_workspace_id, v_group.project_id, p_group_id) then
    raise exception 'FORBIDDEN: 그룹을 관리할 권한이 없어요' using errcode = '42501';
  end if;
  if p_access is null then
    update public.project_group_members set deleted_at = now(), revision = revision + 1, updated_at = now()
     where group_id = p_group_id and member_id = p_member_id and deleted_at is null returning * into v_row;
    if v_row.id is null then return null; end if;
  else
    insert into public.project_group_members (workspace_id, group_id, member_id, access, created_by)
    values (p_workspace_id, p_group_id, p_member_id, p_access, v_uid)
    on conflict (group_id, member_id) do update
      set access = excluded.access, deleted_at = null, revision = public.project_group_members.revision + 1, updated_at = now()
    returning * into v_row;
  end if;
  perform private.log_row_change(p_workspace_id, 'project_group_members', v_row.id::text, to_jsonb(v_row), v_uid);
  perform private.mark_access_changed(p_workspace_id);
  return to_jsonb(v_row);
end $$;

-- 문서·할 일의 공개 그룹 정하기 (빈 목록이면 제한 없음 = 모두에게)
create or replace function public.set_item_groups(p_workspace_id uuid, p_entity text, p_key uuid, p_group_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_creator uuid; v_access text; v_g uuid; v_project uuid; r record;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_entity = 'notes' then select created_by into v_creator from public.notes where workspace_id = p_workspace_id and id = p_key;
  elsif p_entity = 'tasks' then select created_by into v_creator from public.tasks where workspace_id = p_workspace_id and id = p_key;
  else raise exception 'INVALID_REQUEST: 문서(notes)나 할 일(tasks)만 정할 수 있어요' using errcode = '22023';
  end if;
  if v_creator is null then raise exception 'NOT_FOUND: 항목이 없어요' using errcode = 'P0002'; end if;
  v_access := private.item_access(p_workspace_id, p_entity, p_key, v_creator);
  if v_access is null or v_access = 'view' then
    raise exception 'FORBIDDEN: 이 항목을 고칠 권한이 없어요' using errcode = '42501';
  end if;
  foreach v_g in array coalesce(p_group_ids, '{}') loop
    select project_id into v_project from public.project_groups where workspace_id = p_workspace_id and id = v_g and deleted_at is null;
    if v_project is null then raise exception 'NOT_FOUND: 그룹이 없어요' using errcode = 'P0002'; end if;
    if not private.can_manage_group(p_workspace_id, v_project, v_g) then
      raise exception 'FORBIDDEN: 그룹을 관리할 권한이 없어요' using errcode = '42501';
    end if;
  end loop;
  -- 빠진 그룹은 지우고, 새 그룹은 넣음 (지운 적 있으면 되살림)
  for r in update public.item_group_access set deleted_at = now(), revision = revision + 1, updated_at = now()
            where workspace_id = p_workspace_id and entity = p_entity and entity_key = p_key and deleted_at is null
              and not (group_id = any (coalesce(p_group_ids, '{}'))) returning * loop
    perform private.log_row_change(p_workspace_id, 'item_group_access', r.id::text, to_jsonb(r), v_uid);
  end loop;
  for r in insert into public.item_group_access (workspace_id, entity, entity_key, group_id, created_by)
            select p_workspace_id, p_entity, p_key, g, v_uid from unnest(coalesce(p_group_ids, '{}')) g
           on conflict (entity, entity_key, group_id) do update
             set deleted_at = null, revision = public.item_group_access.revision + 1, updated_at = now()
             where public.item_group_access.deleted_at is not null
           returning * loop
    perform private.log_row_change(p_workspace_id, 'item_group_access', r.id::text, to_jsonb(r), v_uid);
  end loop;
  perform private.mark_access_changed(p_workspace_id);
end $$;

revoke all on function public.sync_pull(uuid, bigint, integer), public.save_project_group(uuid, uuid, text, text, uuid),
  public.delete_project_group(uuid, uuid), public.set_group_member(uuid, uuid, uuid, text),
  public.set_item_groups(uuid, text, uuid, uuid[]) from public, anon;
grant execute on function public.sync_pull(uuid, bigint, integer), public.save_project_group(uuid, uuid, text, text, uuid),
  public.delete_project_group(uuid, uuid), public.set_group_member(uuid, uuid, uuid, text),
  public.set_item_groups(uuid, text, uuid, uuid[]) to authenticated;
