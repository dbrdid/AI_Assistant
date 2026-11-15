#!/bin/bash
# 로컬 DB 초기화 + bootstrap + 기존/새 migration 적용
set -e
P="psql -h /tmp -p 54329 -U postgres -v ON_ERROR_STOP=1 -q"
$P -d postgres -c "drop database if exists stella" -c "create database stella"
$P -d stella -f "$(dirname "$0")/bootstrap.sql"
for f in "$@"; do
  # pg_cron 확장은 로컬에 없으므로 create extension 줄만 건너뜀
  sed -e 's/^create extension if not exists pg_cron.*$/-- (local) pg_cron skipped/' -e 's/^create extension if not exists pg_net.*$/-- (local) pg_net skipped/' "$f" | $P -d stella -1 -f - > /dev/null
  echo "applied $(basename "$f")"
done
