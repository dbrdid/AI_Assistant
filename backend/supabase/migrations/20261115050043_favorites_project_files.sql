-- =====================================================================
-- #29 메모 즐겨찾기 · 프로젝트에 파일 직접 연결 (11/15, 프론트 화면 기준)
--
--   1) 메모 즐겨찾기 (note_favorites) — 사람마다 따로 (11/15 결정)
--      화면: 메모 목록 선택 모드의 "★ 즐겨찾기 / ★ 해제", 즐겨찾기 메뉴, 카드의 ★
--      공유 공간 메모만 서버에 둠 (개인 공간 메모는 기기에만 있으니 즐겨찾기도 기기에)
--      내가 별표해도 팀원에게는 안 보임. 동기화 원장(workspace_changes)에 넣지 않고
--      내 다른 기기는 list_note_favorites로 받음 (앱을 열 때·공간을 받을 때)
--      set_note_favorites(공간, 메모 id들, true|false) — 보기 전용(VIEWER)도 가능 (내 표시일 뿐)
--
--   2) 프로젝트 ↔ 파일 (project_files) — 지금까지는 메모를 거쳐서만 연결(note_attachments)
--      화면: 프로젝트 상세의 "＋ 파일 연결", 연결 해제
--      note_projects처럼 sync_push의 연결(LINK) 대상: { entity: 'project_files', op: 'UPSERT'|'DELETE',
--        data: { project_id, asset_id, position? } }. 업로드 검증이 끝난(AVAILABLE) 이 공간의 첨부만
--      다른 기기에는 sync_pull·sync_snapshot으로 전달. 파일을 지우면(assets DELETED) 연결은 남고 앱이 "삭제된 파일"로 표시
--      한 파일을 다른 프로젝트로 옮기는 것은 앱이 한 묶음에 (옛 연결 DELETE + 새 연결 UPSERT)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 메모 즐겨찾기
-- ---------------------------------------------------------------------
create table public.note_favorites (
  account_id    uuid not null references public.accounts (id) on delete cascade,
  workspace_id  uuid not null,
  note_id       uuid not null,
  created_at    timestamptz not null default now(),
  primary key (account_id, note_id),
  foreign key (workspace_id, note_id) references public.notes (workspace_id, id) on delete cascade
);
create index note_favorites_note_idx on public.note_favorites (workspace_id, note_id);
create index note_favorites_account_ws_idx on public.note_favorites (account_id, workspace_id);
comment on table public.note_favorites is '메모 즐겨찾기 (사람마다 따로). 공유 공간 메모만. 쓰기는 set_note_favorites로';

alter table public.note_favorites enable row level security;
revoke all on public.note_favorites from anon;
revoke insert, update, delete on public.note_favorites from authenticated;
create policy note_favorites_select_own on public.note_favorites
  for select to authenticated using (account_id = (select auth.uid()) and private.is_active_member(workspace_id));

/** 즐겨찾기 켜기·끄기 (여러 개 한 번에). 반환: 바뀐 개수와 지금 이 공간의 내 즐겨찾기 전체 */
create or replace function public.set_note_favorites(p_workspace_id uuid, p_note_ids uuid[], p_favorite boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := (select auth.uid());
  v_ids  uuid[];
  v_n    integer;
  v_miss integer;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  if p_workspace_id is null or p_favorite is null then
    raise exception 'INVALID_REQUEST: workspace_id와 favorite(true/false)가 필요합니다' using errcode = '22023';
  end if;
  v_ids := array(select distinct x from unnest(coalesce(p_note_ids, '{}')) x where x is not null);
  if cardinality(v_ids) = 0 or cardinality(v_ids) > 500 then
    raise exception 'INVALID_REQUEST: 메모는 1~500개' using errcode = '22023';
  end if;
  if not private.is_active_member(p_workspace_id) then
    raise exception 'FORBIDDEN: 이 공간의 ACTIVE 멤버가 아닙니다' using errcode = '42501';
  end if;

  if p_favorite then
    -- 이 공간에 있는 메모만 (휴지통 메모도 별표 가능: 복구하면 그대로)
    select count(*) into v_miss from unnest(v_ids) x
     where not exists (select 1 from public.notes n where n.id = x and n.workspace_id = p_workspace_id);
    if v_miss > 0 then
      raise exception 'NOT_FOUND: 이 공간에 없는 메모가 %개 있습니다', v_miss using errcode = '22023';
    end if;
    insert into public.note_favorites (account_id, workspace_id, note_id)
    select v_uid, p_workspace_id, x from unnest(v_ids) x
    on conflict do nothing;
    get diagnostics v_n = row_count;
  else
    delete from public.note_favorites f
     where f.account_id = v_uid and f.workspace_id = p_workspace_id and f.note_id = any (v_ids);
    get diagnostics v_n = row_count;
  end if;

  return jsonb_build_object('ok', true, 'changed', v_n,
    'note_ids', (select coalesce(jsonb_agg(f.note_id order by f.created_at, f.note_id), '[]'::jsonb)
                   from public.note_favorites f where f.account_id = v_uid and f.workspace_id = p_workspace_id));
end $$;

/** 내 즐겨찾기 메모 id (공간 하나 또는 내가 ACTIVE 멤버인 모든 공간) */
create or replace function public.list_note_favorites(p_workspace_id uuid default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('workspace_id', f.workspace_id, 'note_id', f.note_id, 'created_at', f.created_at)
                            order by f.created_at, f.note_id), '[]'::jsonb)
    from public.note_favorites f
   where f.account_id = (select auth.uid())
     and (p_workspace_id is null or f.workspace_id = p_workspace_id)
     and private.is_active_member(f.workspace_id)
$$;

revoke all on function public.set_note_favorites(uuid, uuid[], boolean), public.list_note_favorites(uuid) from public, anon;
grant execute on function public.set_note_favorites(uuid, uuid[], boolean), public.list_note_favorites(uuid) to authenticated;

-- 공간에서 나가거나 내보내지면 그 공간 즐겨찾기 정리 (다시 들어와도 새로 시작)
create or replace function private.note_favorites_cleanup()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status <> 'ACTIVE' and old.status = 'ACTIVE' then
    delete from public.note_favorites where account_id = new.account_id and workspace_id = new.workspace_id;
  end if;
  return new;
end $$;
revoke all on function private.note_favorites_cleanup() from public, anon, authenticated;
create trigger workspace_members_favorites_cleanup after update of status on public.workspace_members
  for each row execute function private.note_favorites_cleanup();

-- ---------------------------------------------------------------------
-- 2. 프로젝트 ↔ 파일
-- ---------------------------------------------------------------------
create table public.project_files (
  workspace_id  uuid not null,
  project_id    uuid not null,
  asset_id      uuid not null,
  position      integer not null default 0,
  added_by      uuid not null references public.accounts (id) on delete restrict,
  added_at      timestamptz not null default now(),
  primary key (workspace_id, project_id, asset_id),
  foreign key (workspace_id, project_id) references public.projects (workspace_id, id) on delete cascade,
  foreign key (workspace_id, asset_id)   references public.assets (workspace_id, id)   on delete restrict
);
create index project_files_asset_idx on public.project_files (workspace_id, asset_id);
create index project_files_added_by_idx on public.project_files (added_by);
comment on table public.project_files is '프로젝트에 직접 연결한 첨부 (메모를 거치지 않음). sync_push 연결(LINK) 대상';

alter table public.project_files enable row level security;
revoke all on public.project_files from anon;
revoke insert, update, delete on public.project_files from authenticated;
create policy project_files_select_member on public.project_files
  for select to authenticated using (private.is_active_member(workspace_id));

-- 원장에 추가
alter table public.workspace_changes drop constraint workspace_changes_entity_table_check;
alter table public.workspace_changes add constraint workspace_changes_entity_table_check
  check (entity_table in (
    'projects', 'project_participants', 'input_sources', 'source_text_versions',
    'notes', 'note_projects', 'tasks', 'events',
    'meetings', 'agenda_items', 'agenda_transitions', 'workspace_members', 'assets',
    'note_attachments', 'project_members', 'project_invites', 'project_files'));

-- sync_push · sync_snapshot: 지금 서버 함수에 바뀐 부분만 (고칠 곳을 정확히 한 번 못 찾으면 전체 실패)
do $mig$
declare
  d text;
  pairs text[][];
  k integer;
  v_from text;
  v_to text;
begin
  d := pg_get_functiondef('public.sync_push(uuid,uuid,jsonb,uuid)'::regprocedure);
  pairs := array[
    -- 1) 연결(LINK) 대상에 project_files
    array[$p$      when v_entity in ('note_projects', 'project_participants', 'note_attachments') then 'LINK'$p$,
          $p$      when v_entity in ('note_projects', 'project_participants', 'note_attachments', 'project_files') then 'LINK'$p$],
    -- 2) 연결 키: project_id · asset_id
    array[$p$        elsif v_entity = 'project_participants' then
          v_a := (v_data ->> 'project_id')::uuid; v_b := (v_data ->> 'account_id')::uuid;
        else$p$,
          $p$        elsif v_entity = 'project_participants' then
          v_a := (v_data ->> 'project_id')::uuid; v_b := (v_data ->> 'account_id')::uuid;
        elsif v_entity = 'project_files' then
          v_a := (v_data ->> 'project_id')::uuid; v_b := (v_data ->> 'asset_id')::uuid;
        else$p$],
    array[$p$/ note_attachments: note_id·asset_id)', i$p$,
          $p$/ note_attachments: note_id·asset_id / project_files: project_id·asset_id)', i$p$],
    -- 3) 연결할 파일 검사: 이 공간의 AVAILABLE 첨부만
    array[$p$      if v_entity = 'note_attachments' and v_kind = 'UPSERT' and not exists ($p$,
          $p$      if v_entity = 'project_files' and v_kind = 'UPSERT' and not exists (
           select 1 from public.assets
            where id = v_b and workspace_id = p_workspace_id
              and purpose = 'ATTACHMENT' and status = 'AVAILABLE') then
        raise exception 'INVALID_REQUEST: ops[%] 업로드 검증이 끝난(AVAILABLE) 이 공간의 첨부만 프로젝트에 연결할 수 있습니다', i using errcode = '22023';
      end if;
      if v_entity = 'note_attachments' and v_kind = 'UPSERT' and not exists ($p$],
    -- 4) 적용
    array[$p$    if v_entity in ('note_projects', 'project_participants', 'note_attachments') then$p$,
          $p$    if v_entity in ('note_projects', 'project_participants', 'note_attachments', 'project_files') then$p$],
    array[$p$      else
        v_a := (v_data ->> 'note_id')::uuid; v_b := (v_data ->> 'asset_id')::uuid;
        if v_kind = 'UPSERT' then
          insert into public.note_attachments$p$,
          $p$      elsif v_entity = 'project_files' then
        v_a := (v_data ->> 'project_id')::uuid; v_b := (v_data ->> 'asset_id')::uuid;
        if v_kind = 'UPSERT' then
          insert into public.project_files as t (workspace_id, project_id, asset_id, position, added_by)
          values (p_workspace_id, v_a, v_b, coalesce((v_data ->> 'position')::integer, 0), v_uid)
          on conflict do nothing
          returning to_jsonb(t) into v_row;
        else
          delete from public.project_files t
           where t.workspace_id = p_workspace_id and t.project_id = v_a and t.asset_id = v_b
          returning to_jsonb(t) into v_row;
        end if;
      else
        v_a := (v_data ->> 'note_id')::uuid; v_b := (v_data ->> 'asset_id')::uuid;
        if v_kind = 'UPSERT' then
          insert into public.note_attachments$p$]
  ];
  for k in 1 .. array_length(pairs, 1) loop
    v_from := pairs[k][1]; v_to := pairs[k][2];
    if (length(d) - length(replace(d, v_from, ''))) / length(v_from) <> 1 then
      raise exception 'patch #29: sync_push 고칠 곳 %을(를) 정확히 한 번 찾지 못했습니다', k;
    end if;
    d := replace(d, v_from, v_to);
  end loop;
  execute d;

  d := pg_get_functiondef('public.sync_snapshot(uuid)'::regprocedure);
  v_from := $p$    'note_attachments',     (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.note_attachments t     where t.workspace_id = p_workspace_id),$p$;
  v_to   := v_from || $p$
    'project_files',        (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.project_files t        where t.workspace_id = p_workspace_id),$p$;
  if (length(d) - length(replace(d, v_from, ''))) / length(v_from) <> 1 then
    raise exception 'patch #29: sync_snapshot 고칠 곳을 정확히 한 번 찾지 못했습니다';
  end if;
  execute replace(d, v_from, v_to);
end
$mig$;
