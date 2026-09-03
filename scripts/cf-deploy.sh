#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_PATH="$(bash "${SCRIPT_DIR}/cf-config.sh")"

cd "${REPO_ROOT}"

echo "==> using wrangler config: ${CONFIG_PATH}"
bash "${SCRIPT_DIR}/cf-validate-config.sh" "${CONFIG_PATH}"

rm -rf .next .open-next
npx opennextjs-cloudflare build

# D1 初始化只在首次部署需要。db/schema.sql 用的是裸 CREATE TABLE（无 IF NOT EXISTS），
# 对已有库再跑一次必定在第一条语句报 "table posts already exists" 并把整个部署打断。
echo "==> checking D1 state"
HAS_POSTS="$(npx wrangler d1 execute DB --remote -c "${CONFIG_PATH}" \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='posts'" --json 2>/dev/null \
  | grep -c '"posts"')" || HAS_POSTS=0

if [[ "${HAS_POSTS}" -gt 0 ]]; then
  echo "    posts 表已存在，跳过 schema 与 seed-template（避免打断部署/覆盖已有设置）"
else
  echo "==> applying D1 schema"
  npx wrangler d1 execute DB \
    --remote \
    --file="${REPO_ROOT}/db/schema.sql" \
    -c "${CONFIG_PATH}"

  if [[ -f "${REPO_ROOT}/db/seed-template.sql" ]]; then
    echo "==> applying template defaults"
    npx wrangler d1 execute DB \
      --remote \
      --file="${REPO_ROOT}/db/seed-template.sql" \
      -c "${CONFIG_PATH}"
  fi
fi

npx opennextjs-cloudflare deploy -c "${CONFIG_PATH}"
