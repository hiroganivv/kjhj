#!/usr/bin/env bash
# 实时备份：把数据库快照 + 证据/transcripts 增量推到私有 backup 仓库。
# 由 keepalive 每 3 分钟后台调用一次；也可在轮次结束同步调用做兜底。
# 设计要点：
#  - 420MB 快照超过 GitHub 单文件上限 -> split 成 40MB 分片
#  - 每次 push 用 --amend + force，仓库永远只有 1 个 commit，历史不膨胀
#  - 只保留最新 5 份数据库快照（db/snap-<ts>/）
#  - 证据目录做增量镜像（state/data/），只保留最新一份
#  - 先写分片、再写 complete 标记，恢复只认 complete，保证原子性
#  - flock 防止上一次还没推完就再次进入
set -uo pipefail

: "${BACKUP_REPO:?缺少 BACKUP_REPO}"
: "${BACKUP_SSH_KEY:?缺少 BACKUP_SSH_KEY}"
: "${APP_PG_DSN:?缺少 APP_PG_DSN}"
: "${APP_DATA_DIR:?缺少 APP_DATA_DIR}"

REPO_DIR=/tmp/backup-repo
LOCK=/tmp/backup.lock
KEEP=5
PART_SIZE=40m
BRANCH=main

exec 9>"${LOCK}"
if ! flock -n 9; then
  echo "skip: 上一次备份仍在运行"
  exit 0
fi

mkdir -p ~/.ssh
printf '%s\n' "${BACKUP_SSH_KEY}" > ~/.ssh/id_backup
chmod 600 ~/.ssh/id_backup
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null || true
# 之前 -H ssh.github.com 是非法参数导致 clone 卡死；-p 22 实测可用
export GIT_SSH_COMMAND="ssh -i ~/.ssh/id_backup -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p 22"

if [ ! -d "${REPO_DIR}/.git" ]; then
  if ! timeout 300 git clone --depth 1 "${BACKUP_REPO}" "${REPO_DIR}"; then
    echo "::warning::备份仓库 clone 失败"
    exit 1
  fi
else
  git -C "${REPO_DIR}" fetch --depth 1 origin "${BRANCH}" >/dev/null 2>&1 || true
  git -C "${REPO_DIR}" reset --hard "origin/${BRANCH}" >/dev/null 2>&1 || true
fi
cd "${REPO_DIR}" || exit 1
git config user.email "backup@local"
git config user.name "backup"

TS=$(date -u +%Y%m%d%H%M%S)
SNAP="db/snap-${TS}"
mkdir -p "${SNAP}"

TMP=$(mktemp /tmp/pgsnap.XXXXXX)
if ! pg_dump "${APP_PG_DSN}" | gzip > "${TMP}"; then
  echo "::warning::pg_dump 失败，本次不推送"
  rm -f "${TMP}"; rm -rf "${SNAP}"; exit 1
fi
if ! gzip -t "${TMP}" 2>/dev/null; then
  echo "::warning::快照 gzip 校验失败，本次不推送"
  rm -f "${TMP}"; rm -rf "${SNAP}"; exit 1
fi
sha256sum "${TMP}" | cut -d' ' -f1 > "${SNAP}/sha256"
split -b "${PART_SIZE}" -d -a 3 "${TMP}" "${SNAP}/part-"
rm -f "${TMP}"
# complete 最后写：恢复端只认带此标记且 sha256 校验通过的快照
printf '%s\n' "${TS}" > "${SNAP}/complete"

# 证据文件 / transcripts 增量镜像（cp -au 只复制新增或更新的文件）
mkdir -p state/data
if [ -d "${APP_DATA_DIR}" ]; then
  cp -au "${APP_DATA_DIR}/." state/data/ 2>/dev/null || true
fi
# 清理旧格式的单文件快照（历史遗留）
rm -f ./snap-*.sql.gz 2>/dev/null || true
# 只保留最新 KEEP 份数据库快照
for d in $(ls -1d db/snap-* 2>/dev/null | sort | head -n -${KEEP}); do
  rm -rf "${d}"
done

git add -A
if git diff --cached --quiet; then
  echo "无变化，跳过推送"
  exit 0
fi
if git rev-parse HEAD >/dev/null 2>&1; then
  git commit --amend -m "backup ${TS}" --quiet
else
  git commit -m "backup ${TS}" --quiet
fi

pushed=0
for attempt in 1 2 3; do
  if timeout 300 git push --force origin "HEAD:${BRANCH}" >/dev/null 2>&1; then
    pushed=1
    break
  fi
  sleep $(( attempt * 3 ))
done
if [ "${pushed}" = 1 ]; then
  echo "[$(date +%T)] ✓ 备份已推送 ${TS}"
else
  echo "::warning::备份推送失败（3 次）—— 本轮数据未持久化到 backup 仓库"
  exit 1
fi
