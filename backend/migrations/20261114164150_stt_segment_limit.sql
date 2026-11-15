-- =====================================================================
-- #26 긴 녹음: 구간 개수 한도 60 → 200
--   전사 모델(gpt-transcribe)은 문장별 시각을 주지 않으므로, 구간을 짧게(기본 2분) 나누고
--   구간 시작 시각을 전사문에 붙여 녹음 시각을 보존한다(앱 recordings.ts).
--   3시간 녹음을 1분 구간으로 나누면 180개 → 여유를 두고 200개까지 허용.
--   그 밖의 규칙(구간 1초~15분, 25MB, 전체 3시간+1분, 분 단위 차감)은 그대로.
-- =====================================================================

alter table private.stt_recordings drop constraint stt_recordings_segment_count_check;
alter table private.stt_recordings add constraint stt_recordings_segment_count_check
  check (segment_count between 1 and 200);

alter table private.stt_segments drop constraint stt_segments_seq_check;
alter table private.stt_segments add constraint stt_segments_seq_check
  check (seq between 0 and 199);

-- stt_recording_create: 개수 확인 한 줄과 주석만 바꿈 (나머지 본문은 그대로)
do $patch$
declare
  v_def text := pg_get_functiondef('public.stt_recording_create(uuid, jsonb, uuid, text[], text[])'::regprocedure);
  v_new text;
  v_from1 constant text := 'if v_n < 1 or v_n > 60 then';
  v_to1   constant text := 'if v_n < 1 or v_n > 200 then';
  v_from2 constant text := '구간 확인: 1~60개';
  v_to2   constant text := '구간 확인: 1~200개';
begin
  if (length(v_def) - length(replace(v_def, v_from1, ''))) / length(v_from1) <> 1 then
    raise exception 'patch #26: segment check not found exactly once';
  end if;
  if (length(v_def) - length(replace(v_def, v_from2, ''))) / length(v_from2) <> 1 then
    raise exception 'patch #26: comment not found exactly once';
  end if;
  v_new := replace(replace(v_def, v_from1, v_to1), v_from2, v_to2);
  execute v_new;
end
$patch$;
