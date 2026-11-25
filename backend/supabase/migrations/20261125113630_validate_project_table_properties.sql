create function private.valid_project_table_properties(p_table jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  field jsonb;
  entry record;
  cell record;
  field_key text;
  field_name text;
  field_type text;
  field_types jsonb := '{}'::jsonb;
  field_names jsonb := '{}'::jsonb;
begin
  if jsonb_typeof(p_table -> 'fields') is distinct from 'array'
    or jsonb_typeof(p_table -> 'properties') is distinct from 'object' then
    return false;
  end if;

  for field in select value from jsonb_array_elements(p_table -> 'fields') loop
    if jsonb_typeof(field) is distinct from 'object'
      or jsonb_typeof(field -> 'key') is distinct from 'string'
      or jsonb_typeof(field -> 'label') is distinct from 'string'
      or jsonb_typeof(field -> 'type') is distinct from 'string' then
      return false;
    end if;
    field_key := field ->> 'key';
    field_name := lower(btrim(field ->> 'label'));
    field_type := field ->> 'type';
    if field_key !~ '^property:.+$' or char_length(field_key) > 100
      or char_length(field_name) not between 1 and 40
      or field_type not in ('text', 'number', 'checkbox')
      or field_types ? field_key or field_names ? field_name then
      return false;
    end if;
    field_types := field_types || jsonb_build_object(field_key, field_type);
    field_names := field_names || jsonb_build_object(field_name, true);
  end loop;

  for entry in select * from jsonb_each(p_table -> 'properties') loop
    if entry.key !~ '^(memos|tasks|files):.+$' or char_length(entry.key) > 300
      or jsonb_typeof(entry.value) is distinct from 'object' then
      return false;
    end if;
    for cell in select * from jsonb_each(entry.value) loop
      case field_types ->> cell.key
        when 'text' then
          if jsonb_typeof(cell.value) <> 'string' or char_length(cell.value #>> '{}') > 200 then return false; end if;
        when 'number' then
          if jsonb_typeof(cell.value) <> 'number' then return false; end if;
          if abs((cell.value #>> '{}')::numeric) > 1.7976931348623157e308::numeric then return false; end if;
        when 'checkbox' then
          if jsonb_typeof(cell.value) <> 'boolean' then return false; end if;
        else return false;
      end case;
    end loop;
  end loop;
  return true;
end $$;

revoke all on function private.valid_project_table_properties(jsonb) from public, anon, authenticated;
grant execute on function private.valid_project_table_properties(jsonb) to service_role;

alter table public.projects
  add constraint projects_table_properties_values
  check (private.valid_project_table_properties(table_properties));
