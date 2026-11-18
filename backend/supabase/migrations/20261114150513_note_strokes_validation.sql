-- Match InkCanvas's stored stroke format so a malformed shared note cannot break rendering.
create or replace function private.valid_note_strokes(p_strokes jsonb)
returns boolean language plpgsql immutable strict set search_path = '' as $$
declare s jsonb; point jsonb;
begin
  if jsonb_typeof(p_strokes) <> 'array' or octet_length(p_strokes::text) > 1048576 then return false; end if;
  for s in select value from jsonb_array_elements(p_strokes) loop
    if jsonb_typeof(s) <> 'object'
       or jsonb_typeof(s->'id') is distinct from 'string'
       or char_length(s->>'id') not between 1 and 100
       or jsonb_typeof(s->'c') is distinct from 'string'
       or char_length(s->>'c') not between 1 and 64
       or jsonb_typeof(s->'w') is distinct from 'number'
       or jsonb_typeof(s->'p') is distinct from 'array' then return false; end if;
    if (s->>'w')::numeric <= 0 or (s->>'w')::numeric > 100
       or jsonb_array_length(s->'p') not between 1 and 10000 then return false; end if;
    for point in select value from jsonb_array_elements(s->'p') loop
      if jsonb_typeof(point) <> 'array' then return false; end if;
      if jsonb_array_length(point) <> 2
         or jsonb_typeof(point->0) is distinct from 'number'
         or jsonb_typeof(point->1) is distinct from 'number' then return false; end if;
    end loop;
  end loop;
  return true;
end $$;
revoke all on function private.valid_note_strokes(jsonb) from public, anon, authenticated;
grant execute on function private.valid_note_strokes(jsonb) to service_role;
alter table public.notes add constraint notes_strokes_shape check (private.valid_note_strokes(strokes));

