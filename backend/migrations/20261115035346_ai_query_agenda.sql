-- =====================================================================
-- #27 AI 채팅(/query)·안건 논의 판단(/agenda) 사용량
--   AI 채팅은 팀 서버(로컬 AI)와 같은 2단계: 검색 조건 뽑기 → 앱이 기기에서 검색 → 찾은 발췌로 답변
--     - query_plan : 1단계(검색 조건). 짧고 싸서 사용자 "질문 횟수"에는 넣지 않고 남용 방지 한도만 (FREE 150 / PRO 1,500)
--     - query      : 2단계(답변) = 질문 1회 (기존 한도 FREE 50 / PRO 500 그대로)
--   agenda : 안건 비교 화면의 '논의됨/미논의' 판단 1회 (FREE 50 / PRO 500)
--   본문(질문·기록·회의 내용)은 여전히 어디에도 저장하지 않음 (ai_requests엔 해시·상태·토큰 수만)
-- =====================================================================

alter table public.ai_requests drop constraint ai_requests_endpoint_check;
alter table public.ai_requests add constraint ai_requests_endpoint_check
  check (endpoint in ('organize', 'analyze', 'query', 'query_plan', 'agenda', 'stt', 'ocr', 'image'));

create or replace function private.ai_monthly_limit(p_plan text, p_endpoint text)
returns integer language sql immutable set search_path = '' as $$
  select case p_endpoint
           when 'organize'   then case p_plan when 'PRO' then 1000 else 100 end
           when 'analyze'    then case p_plan when 'PRO' then 300  else 30  end
           when 'query'      then case p_plan when 'PRO' then 500  else 50  end
           when 'query_plan' then case p_plan when 'PRO' then 1500 else 150 end
           when 'agenda'     then case p_plan when 'PRO' then 500  else 50  end
           when 'stt'        then case p_plan when 'PRO' then 600  else 60  end   -- 단위: 분
           else                   case p_plan when 'PRO' then 300  else 30  end
         end;
$$;
