alter table public.projects
  add column table_properties jsonb not null default '{"fields":[],"properties":{}}'::jsonb,
  add constraint projects_table_properties_shape check (
    jsonb_typeof(table_properties) = 'object'
    and table_properties ?& array['fields', 'properties']
    and jsonb_typeof(table_properties -> 'fields') = 'array'
    and jsonb_typeof(table_properties -> 'properties') = 'object'
    and octet_length(table_properties::text) <= 262144
  );

do $migration$
declare
  definition text := replace(pg_get_functiondef('public.sync_push(uuid,uuid,jsonb,uuid)'::regprocedure), E'\r\n', E'\n');
  project_update text := replace($fragment$update public.projects t
           set name$fragment$, E'\r\n', E'\n');
begin
  if (length(definition) - length(replace(definition, project_update, ''))) / length(project_update) <> 1 then
    raise exception 'project table properties: unexpected sync_push definition';
  end if;
  execute replace(definition, project_update, $fragment$update public.projects t
           set table_properties = case when v_data ? 'table_properties' then v_data -> 'table_properties' else t.table_properties end,
               name$fragment$);
end $migration$;
