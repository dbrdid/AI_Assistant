-- =====================================================================
-- #35 초대 메일 발송 (11/15, 정한 정책: Edge Function + Gmail SMTP 465)
--   공간 초대·프로젝트 초대 모두. 코드는 만들 때 한 번만 앱에 오므로 앱이 코드를 함께 보내고,
--   서버는 코드의 해시로 그 초대가 맞는지·보낸 사람이 만든 사람인지 확인한 뒤 메일을 보냄
--   한도: 한 사람 하루 30통, 서비스 전체 하루 450통(Gmail 하루 약 500통), 같은 초대·같은 주소는 10분에 한 번
--   SMTP_PASSWORD가 아직 없으면 Edge Function이 MAIL_NOT_CONFIGURED → 앱은 지금처럼 공유 문구로 보냄
--   보낸 기록: private.invite_mails (주소·결과). 프로젝트 초대에는 mailed_at을 남겨 "초대 대기"에 '메일 보냄' 표시
-- =====================================================================

alter table public.project_invites add column mailed_at timestamptz;

create table private.invite_mails (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid references public.accounts (id) on delete set null,
  invite_id          uuid not null references public.workspace_invites (id) on delete cascade,
  project_invite_id  uuid references public.project_invites (id) on delete cascade,
  email              text not null check (char_length(email) <= 254),
  status             text not null default 'SENDING' check (status in ('SENDING', 'SENT', 'FAILED')),
  error              text check (char_length(error) <= 200),
  created_at         timestamptz not null default now(),
  finished_at        timestamptz
);
create index invite_mails_account_day_idx on private.invite_mails (account_id, created_at);
create index invite_mails_day_idx on private.invite_mails (created_at);
alter table private.invite_mails enable row level security;
comment on table private.invite_mails is '초대 메일 보낸 기록 (한도 계산·재시도). 앱은 직접 못 읽음';

create or replace function private.invite_mail_limits()
returns jsonb language sql immutable as $$ select '{"per_account_day": 30, "global_day": 450, "resend_minutes": 10}'::jsonb $$;

/**
 * Edge Function invite-mail ①: 보낼 수 있는지 확인 + 기록 한 줄 (SENDING)
 *   p_code: 초대 코드 (만들 때 받은 것), p_email: 공간 초대일 때 받는 주소 (프로젝트 초대는 초대에 적힌 주소)
 *   반환: { mail_id, email, kind: 'WORKSPACE'|'PROJECT', workspace_name, project_name, inviter_name, role, expires_at, code }
 */
create or replace function public.invite_mail_prepare(p_account_id uuid, p_code text, p_email text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_inv   public.workspace_invites%rowtype;
  v_pi    public.project_invites%rowtype;
  v_email text;
  v_lim   jsonb := private.invite_mail_limits();
  v_day   timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  v_id    uuid;
  v_norm  text := private.normalize_invite_code(p_code);
begin
  -- 같은 사람의 동시 요청을 한 줄로 (하루 한도 경합 방지)
  perform pg_advisory_xact_lock(hashtextextended('invite-mail:' || coalesce(p_account_id::text, ''), 0));

  v_inv := private.find_usable_invite(p_code, false);   -- 형식·취소·만료·다 씀 검사 (INVITE_*)
  select * into v_pi from public.project_invites where invite_id = v_inv.id;

  if v_pi.id is not null then
    if v_pi.created_by is distinct from p_account_id then
      raise exception 'FORBIDDEN: 초대한 사람만 메일을 보낼 수 있습니다' using errcode = '42501';
    end if;
    if v_pi.status <> 'PENDING' then
      raise exception 'INVITE_REVOKED: 대기 중인 초대가 아닙니다' using errcode = '22023';
    end if;
    if v_pi.email is null then
      raise exception 'INVALID_EMAIL: 링크 초대는 메일로 보내지 않습니다 (공유 문구로 보내 주세요)' using errcode = '22023';
    end if;
    v_email := v_pi.email;
  else
    if v_inv.invited_by is distinct from p_account_id then
      raise exception 'FORBIDDEN: 초대한 사람만 메일을 보낼 수 있습니다' using errcode = '42501';
    end if;
    v_email := nullif(lower(btrim(coalesce(p_email, v_inv.invitee_email, ''))), '');
  end if;
  if v_email is null or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' or char_length(v_email) > 254 then
    raise exception 'INVALID_EMAIL: 이메일 형식이 올바르지 않습니다' using errcode = '22023';
  end if;

  if exists (select 1 from private.invite_mails m
              where m.invite_id = v_inv.id and m.email = v_email and m.status in ('SENDING', 'SENT')
                and m.created_at > now() - make_interval(mins => (v_lim ->> 'resend_minutes')::int)) then
    raise exception 'MAIL_TOO_SOON: 방금 보낸 초대예요. 10분 뒤에 다시 보낼 수 있어요' using errcode = '22023';
  end if;
  if (select count(*) from private.invite_mails m where m.account_id = p_account_id and m.created_at >= v_day and m.status <> 'FAILED')
       >= (v_lim ->> 'per_account_day')::int then
    raise exception 'MAIL_LIMIT: 오늘 보낼 수 있는 초대 메일(%통)을 모두 보냈어요', v_lim ->> 'per_account_day' using errcode = '22023';
  end if;
  if (select count(*) from private.invite_mails m where m.created_at >= v_day and m.status <> 'FAILED')
       >= (v_lim ->> 'global_day')::int then
    raise exception 'MAIL_LIMIT: 오늘은 메일을 더 보낼 수 없어요. 공유 문구로 보내 주세요' using errcode = '22023';
  end if;

  insert into private.invite_mails (account_id, invite_id, project_invite_id, email)
  values (p_account_id, v_inv.id, v_pi.id, v_email) returning id into v_id;

  return jsonb_build_object(
    'mail_id', v_id, 'email', v_email, 'kind', case when v_pi.id is null then 'WORKSPACE' else 'PROJECT' end,
    'workspace_name', (select w.name from public.workspaces w where w.id = v_inv.workspace_id),
    'project_name', (select p.name from public.projects p where p.id = v_pi.project_id),
    'inviter_name', coalesce((select nullif(btrim(p.display_name), '') from public.profiles p where p.account_id = p_account_id), 'Stella 사용자'),
    'role', v_inv.role, 'expires_at', v_inv.expires_at,
    'code', case when char_length(v_norm) = 10 then substr(v_norm, 1, 5) || '-' || substr(v_norm, 6) else v_norm end);   -- 화면과 같은 ABCDE-FGHJK
end $$;

/** Edge Function invite-mail ②: 보낸 결과 (성공이면 공간 초대에 주소, 프로젝트 초대에 mailed_at + 원장) */
create or replace function public.invite_mail_result(p_mail_id uuid, p_ok boolean, p_error text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_m  private.invite_mails%rowtype;
  v_pi public.project_invites%rowtype;
begin
  update private.invite_mails set status = case when p_ok then 'SENT' else 'FAILED' end,
         error = case when p_ok then null else left(coalesce(p_error, 'UNKNOWN'), 200) end, finished_at = now()
   where id = p_mail_id and status = 'SENDING'
  returning * into v_m;
  if v_m.id is null then return jsonb_build_object('ok', false, 'unchanged', true); end if;
  if p_ok then
    update public.workspace_invites set invitee_email = coalesce(invitee_email, v_m.email) where id = v_m.invite_id;
    if v_m.project_invite_id is not null then
      select pi.* into v_pi from public.project_invites pi where pi.id = v_m.project_invite_id;
      perform private.lock_workspace_head(v_pi.workspace_id);
      update public.project_invites set mailed_at = now() where id = v_m.project_invite_id returning * into v_pi;
      perform private.log_row_change(v_pi.workspace_id, 'project_invites', v_pi.id::text, to_jsonb(v_pi), v_m.account_id);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'status', v_m.status);
end $$;

/** 화면용: 오늘 남은 초대 메일 */
create or replace function public.get_invite_mail_quota()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_lim jsonb := private.invite_mail_limits();
  v_used integer;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode = '28000'; end if;
  select count(*) into v_used from private.invite_mails m
   where m.account_id = v_uid and m.status <> 'FAILED'
     and m.created_at >= date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  return jsonb_build_object('limit', (v_lim ->> 'per_account_day')::int, 'used', v_used,
                            'remaining', greatest((v_lim ->> 'per_account_day')::int - v_used, 0));
end $$;

-- 보내다 멈춘 기록(SENDING 10분 넘음)은 실패로 (한도에서 빠짐)
create or replace function private.invite_mails_cleanup()
returns integer language sql security definer set search_path = '' as $$
  with u as (update private.invite_mails set status = 'FAILED', error = 'TIMEOUT', finished_at = now()
              where status = 'SENDING' and created_at < now() - interval '10 minutes' returning 1)
  select count(*)::int from u
$$;

revoke all on function private.invite_mail_limits(), private.invite_mails_cleanup() from public, anon, authenticated;
revoke all on function public.invite_mail_prepare(uuid, text, text), public.invite_mail_result(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.invite_mail_prepare(uuid, text, text), public.invite_mail_result(uuid, boolean, text) to service_role;
revoke all on function public.get_invite_mail_quota() from public, anon;
grant execute on function public.get_invite_mail_quota() to authenticated;

select cron.schedule('invite-mails-cleanup', '*/10 * * * *', $cmd$ select private.invite_mails_cleanup() $cmd$);
