#!/bin/bash
# 동시성: (a) 마지막 1자리를 두 사람이 동시에 수락 (b) 20명 동시 수락 + 저장 + 초대 생성이 섞여도 교착 없음·seq 연속
P="psql -h /tmp -p 54329 -U postgres -d stella -qtAX -v ON_ERROR_STOP=1"
as() { echo "select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, false); set role authenticated;"; }
OWNER=00000000-0000-4000-8000-0000000000d0
$P -c "insert into auth.users (id, email, raw_user_meta_data) select ('00000000-0000-4000-8000-0000000001' || lpad(g::text, 2, '0'))::uuid, 'u'||g||'@t.dev', jsonb_build_object('name','U'||g) from generate_series(1,30) g;
       insert into auth.users (id, email, raw_user_meta_data) values ('$OWNER','d@t.dev','{\"name\":\"D\"}');"
u() { printf '00000000-0000-4000-8000-0000000001%02d' "$1"; }
WS=$($P -c "$(as $OWNER) select public.create_workspace('동시성');" | tail -1)

# (a) 1자리 초대를 u1(트랜잭션 안에서 2초 붙잡음)과 u2가 동시에 수락
CODE=$($P -c "$(as $OWNER) select public.create_invite('$WS','EDITOR',24,1)->>'code';" | tail -1)
( $P -c "begin; $(as $(u 1)) select public.accept_invite('$CODE')->>'role'; select pg_sleep(2); commit;" > /tmp/claude-0/a1.out 2>&1 ) &
sleep 0.5
$P -c "$(as $(u 2)) select public.accept_invite('$CODE');" > /tmp/claude-0/a2.out 2>&1
wait
echo "(a) u1: $(grep -v '^$' /tmp/claude-0/a1.out | grep -v set_config | tr '\n' ' ')"
echo "(a) u2: $(grep -o 'INVITE_[A-Z_]*' /tmp/claude-0/a2.out)"

# (b) 50명짜리 초대 + 20명 동시 수락 + OWNER가 메모 저장 20번 + 초대 생성·취소 10번 동시에
CODE=$($P -c "$(as $OWNER) select public.create_invite('$WS','EDITOR',24,50)->>'code';" | tail -1)
for i in $(seq 3 22); do
  $P -c "$(as $(u $i)) select public.accept_invite('$CODE')->>'role';" > /tmp/claude-0/b_$i.out 2>&1 &
done
( for k in $(seq 1 20); do $P -c "$(as $OWNER) select public.sync_push('$WS', gen_random_uuid(), ('[{\"entity\":\"notes\",\"op\":\"UPSERT\",\"id\":\"' || gen_random_uuid() || '\",\"data\":{\"title\":\"n$k\",\"body\":\"x\"}}]')::jsonb)->>'status';"; done > /tmp/claude-0/b_push.out 2>&1 ) &
( for k in $(seq 1 10); do $P -c "$(as $OWNER) select public.revoke_invite((public.create_invite('$WS','VIEWER',1,1)->>'invite_id')::uuid)->>'status';"; done > /tmp/claude-0/b_inv.out 2>&1 ) &
wait
echo "(b) accepts EDITOR: $(cat /tmp/claude-0/b_*.out | grep -c '^EDITOR$') / 20"
echo "(b) pushes ACCEPTED: $(grep -c ACCEPTED /tmp/claude-0/b_push.out) / 20, invites REVOKED: $(grep -c REVOKED /tmp/claude-0/b_inv.out) / 10"
echo "(b) errors: $(cat /tmp/claude-0/b_*.out | grep -ci 'error\|deadlock')"
$P -c "select 'use_count=' || use_count from public.workspace_invites where workspace_id='$WS' and max_uses=50;
       select 'members=' || count(*) from public.workspace_members where workspace_id='$WS' and status='ACTIVE';
       select 'seq: last=' || h.last_seq || ' changes=' || count(c.*) || ' contiguous=' || (count(c.*) = max(c.seq) and min(c.seq) = 1)
         from public.workspace_sync_heads h join public.workspace_changes c using (workspace_id) where h.workspace_id='$WS' group by h.last_seq;
       select 'member changes=' || count(*) from public.workspace_changes where workspace_id='$WS' and entity_table='workspace_members';"

# (c) 가짜 결제: 같은 사람이 결제 버튼을 10번 동시에 (요청 id는 매번 다름) → 결제 1번, 나머지는 ALREADY_ACTIVE
PAYER=$(u 30)
for k in $(seq 1 10); do
  $P -c "$(as $PAYER) select public.subscription_checkout('PRO', gen_random_uuid())->>'action';" > /tmp/claude-0/c_$k.out 2>&1 &
done
wait
echo "(c) SUBSCRIBED: $(cat /tmp/claude-0/c_*.out | grep -c '^SUBSCRIBED$') / 1, ALREADY_ACTIVE: $(cat /tmp/claude-0/c_*.out | grep -c '^ALREADY_ACTIVE$') / 9, errors: $(cat /tmp/claude-0/c_*.out | grep -ci 'error\|deadlock')"
$P -c "select '(c) PAID payments=' || count(*) from public.payments where account_id='$PAYER' and status='PAID';"

# (d) 프로젝트 초대: 15명이 각자 받은 코드로 동시에 참여 + 관리자가 팀원 저장 10번 동시에 → 교착 없음, 팀원 15명, 순번 연속
PJ=00000000-0000-4000-8000-00000000d0d0
$P -c "$(as $OWNER) select public.sync_push('$WS', gen_random_uuid(), '[{\"entity\":\"projects\",\"op\":\"UPSERT\",\"id\":\"$PJ\",\"data\":{\"name\":\"동시 참여\"}}]'::jsonb)->>'status';" > /dev/null
$P -c "update public.subscriptions set plan='PRO', current_period_start=now(), current_period_end=now()+interval '1 month' where account_id='$OWNER';"   # 한도 50회
for i in $(seq 1 15); do
  echo "$($P -c "$(as $OWNER) select public.create_project_invite('$PJ', 'LINK')->>'code';" | tail -1)" > /tmp/claude-0/d_code_$i
done
for i in $(seq 1 15); do
  n=$((i + 40))
  $P -c "insert into auth.users (id, email, raw_user_meta_data) values ('$(u $n)', 'd$n@t.dev', '{\"name\":\"D$n\"}') on conflict do nothing;" > /dev/null
  $P -c "$(as $(u $n)) select jsonb_array_length(public.join_with_invite('$(cat /tmp/claude-0/d_code_$i)')->'projects');" > /tmp/claude-0/d_$i.out 2>&1 &
done
( for k in $(seq 1 10); do $P -c "$(as $OWNER) select public.sync_push('$WS', gen_random_uuid(), ('[{\"entity\":\"project_members\",\"op\":\"UPSERT\",\"id\":\"' || gen_random_uuid() || '\",\"data\":{\"project_id\":\"$PJ\",\"name\":\"이름$k\"}}]')::jsonb)->>'status';"; done > /tmp/claude-0/d_push.out 2>&1 ) &
wait
echo "(d) joined with project: $(cat /tmp/claude-0/d_[0-9]*.out | grep -c '^1$') / 15, pushes ACCEPTED: $(grep -c ACCEPTED /tmp/claude-0/d_push.out) / 10, errors: $(cat /tmp/claude-0/d_*.out | grep -ci 'error\|deadlock')"
$P -c "select '(d) project members=' || count(*) || ' (계정 ' || count(account_id) || ')' from public.project_members where project_id='$PJ';
       select '(d) seq contiguous=' || (count(*) = max(seq) and min(seq) = 1) from public.workspace_changes where workspace_id='$WS';"

# (e) 휴지통 (#32): 30일 지난 메모 20개를 cron이 지우는 동안 관리자가 메모 저장 10번 + 다른 메모 영구 삭제 5번 동시에 → 교착 없음, 순번 연속
for i in $(seq 1 25); do
  NID=$(printf '00000000-0000-4000-8000-0000000e%04d' $i)
  $P -c "$(as $OWNER) select public.sync_push('$WS', gen_random_uuid(), '[{\"entity\":\"notes\",\"op\":\"UPSERT\",\"id\":\"$NID\",\"data\":{\"title\":\"휴지통 $i\",\"body\":\"\"}}]'::jsonb)->>'status';" > /dev/null
  $P -c "$(as $OWNER) select public.sync_push('$WS', gen_random_uuid(), '[{\"entity\":\"notes\",\"op\":\"DELETE\",\"id\":\"$NID\",\"base_revision\":1,\"data\":{}}]'::jsonb)->>'status';" > /dev/null
done
$P -c "update public.notes set deleted_at = now() - interval '31 days' where id::text like '00000000-0000-4000-8000-0000000e%' and right(id::text, 4)::int <= 20;" > /dev/null
$P -c "select private.trash_purge_expired();" > /tmp/claude-0/e_cron.out 2>&1 &
( for k in $(seq 1 10); do $P -c "$(as $OWNER) select public.sync_push('$WS', gen_random_uuid(), ('[{\"entity\":\"notes\",\"op\":\"UPSERT\",\"id\":\"' || gen_random_uuid() || '\",\"data\":{\"title\":\"동시 $k\",\"body\":\"\"}}]')::jsonb)->>'status';"; done > /tmp/claude-0/e_push.out 2>&1 ) &
for i in $(seq 21 25); do
  NID=$(printf '00000000-0000-4000-8000-0000000e%04d' $i)
  $P -c "$(as $OWNER) select public.sync_push('$WS', gen_random_uuid(), '[{\"entity\":\"notes\",\"op\":\"PURGE\",\"id\":\"$NID\",\"base_revision\":2,\"data\":{}}]'::jsonb)->>'status';" > /tmp/claude-0/e_purge_$i.out 2>&1 &
done
wait
echo "(e) cron purged: $(grep -E '^[0-9]+$' /tmp/claude-0/e_cron.out | tail -1) / 20, pushes ACCEPTED: $(grep -c ACCEPTED /tmp/claude-0/e_push.out) / 10, purges ACCEPTED: $(cat /tmp/claude-0/e_purge_*.out | grep -c ACCEPTED) / 5, errors: $(cat /tmp/claude-0/e_*.out | grep -ci 'error\|deadlock')"
$P -c "select '(e) trash notes left=' || count(*) from public.notes where id::text like '00000000-0000-4000-8000-0000000e%';
       select '(e) seq contiguous=' || (count(*) = max(seq) and min(seq) = 1) from public.workspace_changes where workspace_id='$WS';"
