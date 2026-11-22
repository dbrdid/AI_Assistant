alter table public.notes add column parent_note_id uuid;
alter table public.notes add constraint notes_parent_workspace_fkey
  foreign key (workspace_id, parent_note_id) references public.notes (workspace_id, id);
create index notes_parent_idx on public.notes (workspace_id, parent_note_id) where parent_note_id is not null;

create function private.validate_note_parent() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.parent_note_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.parent_note_id is not distinct from old.parent_note_id then return new; end if;

  perform 1 from public.workspace_sync_heads where workspace_id = new.workspace_id for update;
  if not exists (
    select 1 from public.notes
    where workspace_id = new.workspace_id and id = new.parent_note_id and deleted_at is null
  ) then
    raise exception 'INVALID_REQUEST: parent note is unavailable' using errcode = '22023';
  end if;
  if exists (
    with recursive ancestors(id, parent_note_id) as (
      select n.id, n.parent_note_id from public.notes n
      where n.workspace_id = new.workspace_id and n.id = new.parent_note_id
      union
      select n.id, n.parent_note_id from public.notes n
      join ancestors a on a.parent_note_id = n.id
      where n.workspace_id = new.workspace_id
    )
    select 1 from ancestors where id = new.id
  ) then
    raise exception 'INVALID_REQUEST: note hierarchy would contain a cycle' using errcode = '22023';
  end if;
  return new;
end $$;
revoke all on function private.validate_note_parent() from public, anon, authenticated;
create trigger notes_validate_parent before insert or update of parent_note_id on public.notes
for each row execute function private.validate_note_parent();

do $migration$
declare
  definition text := pg_get_functiondef('public.sync_push(uuid,uuid,jsonb,uuid)'::regprocedure);
  purge_definition text := pg_get_functiondef('private.trash_purge(uuid,text,uuid,uuid,uuid)'::regprocedure);
  insert_columns text := 'source_version_id, strokes, created_by)';
  insert_values text := $fragment$coalesce(v_data -> 'strokes', '[]'::jsonb),$fragment$;
  update_values text := $fragment$strokes = case when v_data ? 'strokes' then v_data -> 'strokes' else t.strokes end$fragment$;
  purge_note text := 'delete from public.notes where workspace_id = p_ws and id = p_id;';
  fragment text;
begin
  foreach fragment in array array[insert_columns, insert_values, update_values] loop
    if (length(definition) - length(replace(definition, fragment, ''))) / length(fragment) <> 1 then
      raise exception 'note hierarchy: unexpected sync_push definition';
    end if;
  end loop;
  definition := replace(definition, insert_columns, 'source_version_id, strokes, parent_note_id, created_by)');
  definition := replace(definition, insert_values, insert_values || $fragment$ (v_data ->> 'parent_note_id')::uuid,$fragment$);
  definition := replace(definition, update_values, update_values ||
    $fragment$, parent_note_id = case when v_data ? 'parent_note_id' then (v_data ->> 'parent_note_id')::uuid else t.parent_note_id end$fragment$);
  execute definition;

  if (length(purge_definition) - length(replace(purge_definition, purge_note, ''))) / length(purge_note) <> 1 then
    raise exception 'note hierarchy: unexpected trash_purge definition';
  end if;
  execute replace(purge_definition, purge_note, $fragment$
    for v_row in update public.notes t set parent_note_id = null
      where t.workspace_id = p_ws and t.parent_note_id = p_id returning to_jsonb(t) loop
      perform private.log_change(p_ws, 'notes', v_row ->> 'id', 'UPSERT', v_row, p_actor, p_operation_id);
    end loop;
    $fragment$ || purge_note);
end $migration$;
