#!/usr/bin/env bash
# 轮次启动：从私有 backup 仓库拉最新一份完整快照，合并分片恢复到 STATE_DIR。
# 只认带 complete 标记、sha256 校验通过、gzip -t 通过的快照；
# 若最新一份损坏，自动回退到更早的一份（最多试 KEEP 份）。
set -uo pipefail

: "${BACKUP_REPO:?缺少 BACKUP_REPO}"
: "${BACKUP_SSH_KEY:?缺少 BACKUP_SSH_KEY}"
: "${STATE_DIR:?缺少 STATE_DIR}"
: "${APP_DATA_DIR:?缺少 APP_DATA_DIR}"

REPO_DIR=/tmp/restore-repo
BRANCH=main

mkdir -p ~/.ssh "${STATE_DIR}" "${APP_DATA_DIR}"
printf '%s\n' "${BACKUP_SSH_KEY}" > ~/.ssh/id_backup
chmod 600 ~/.ssh/id_backup
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null || true
export GIT_SSH_COMMAND="ssh -i ~/.ssh/id_backup -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p 22"

rm -rf "${REPO_DIR}"
if ! timeout 300 git clone --depth 1 "${BACKUP_REPO}" "${REPO_DIR}"; then
  echo "::warning::备份仓库 clone 失败，本轮用空库继续"
  exit 0
fi

restored=0
for d in $(ls -1d "${REPO_DIR}"/db/snap-* 2>/dev/null | sort -r); do
  [ -f "${d}/complete" ] || continue
  [ -f "${d}/sha256" ] || continue
  ls "${d}"/part-* >/dev/null 2>&1 || continue

  TMP=$(mktemp /tmp/pgrestore.XXXXXX)
  cat "${d}"/part-* > "${TMP}" 2>/dev/null || { rm -f "${TMP}"; continue; }
  sum=$(sha256sum "${TMP}" | cut -d' ' -f1)
  want=$(cat "${d}/sha256")
  if [ "${sum}" != "${want}" ]; then
    echo "::warning::快照 $(basename "${d}") sha256 不符，尝试更早一份"
    rm -f "${TMP}"; continue
  fi
  if ! gzip -t "${TMP}" 2>/dev/null; then
    echo "::warning::快照 $(basename "${d}") gzip 损坏，尝试更早一份"
    rm -f "${TMP}"; continue
  fi
  mv "${TMP}" "${STATE_DIR}/pg.sql.gz"
  echo "✓ 已从备份恢复 $(basename "${d}") ($(du -sh "${STATE_DIR}/pg.sql.gz" | cut -f1))"
  restored=1
  break
done

if [ "${restored}" = 0 ]; then
  echo "::warning::备份仓库里没有可用的完整快照，本轮用空库继续"
fi

# 证据文件 / transcripts 增量镜像回 app 目录
if [ -d "${REPO_DIR}/state/data" ]; then
  cp -au "${REPO_DIR}/state/data/." "${APP_DATA_DIR}/" 2>/dev/null || true
  echo "✓ 证据/transcripts 已恢复: $(du -sh "${APP_DATA_DIR}" 2>/dev/null | cut -f1)"
fi
