#!/usr/bin/env bash

set -uo pipefail
REPO="${1:-}"
if [ -z "${REPO}" ]; then echo "用法: bash deploy/set-secrets.sh <owner/repo>" >&2; exit 1; fi

ask() {
  local var="$1" prompt="$2" secret="${3:-0}" def="${4:-}" value
  value="${!var:-}"
  if [ -n "${value}" ]; then echo "${prompt} <- 环境变量 ${var}（已提供）"
  elif [ "${secret}" = "1" ]; then read -rsp "${prompt}: " value; echo
  else read -rp "${prompt}${def:+ [${def}]}: " value; fi
  [ -z "${value}" ] && value="${def}"
  printf '%s' "${value}"
}
set_var() {
  local name="$1" value="$2"
  [ -z "${value}" ] && { echo "跳过 ${name}（空）"; return; }
  gh variable set "${name}" --body "${value}" --repo "${REPO}" >/dev/null 2>&1 \
    && echo "✓ variable ${name}" || echo "✗ variable ${name} 写入失败（检查 gh 账号权限）" >&2
}
set_secret() {
  local name="$1" value="$2"
  [ -z "${value}" ] && { echo "跳过 ${name}（空）"; return; }
  gh secret set "${name}" --body "${value}" --repo "${REPO}" >/dev/null 2>&1 \
    && echo "✓ secret   ${name}" || echo "✗ secret   ${name} 写入失败（检查 gh 账号权限）" >&2
}

echo "== Variables（普通配置）=="
REPO_SRC=$(ask REPO_SRC_IN '源码 owner/repo' 0 '')
REF_SRC=$(ask REF_SRC_IN '源码分支/ref' 0 'main')
SRV_ADDR=$(ask SRV_ADDR_IN 'frps 公网 IP' 0 '')
OOB_HOST=$(ask OOB_HOST_IN '回连主机(可空=跟随 frps IP)' 0 '')
CMD_PKG=$(ask CMD_PKG_IN 'Go 入口包路径' 0 '')
ADMIN_USER=$(ask ADMIN_USER_IN '管理员用户名' 0 '')

echo
echo "== Secrets（敏感：端口 + 口令，输入不回显）=="
BIND=$(ask BIND_IN 'frps bindPort' 1)
TOKEN=$(ask TOKEN_IN 'frps auth.token' 1)
REMOTE=$(ask REMOTE_IN '公网 Web 端口' 1)
LOCAL=$(ask LOCAL_IN 'runner 本地 Web 端口' 1)
ALIAS=$(ask ALIAS_IN 'Web 别名端口(逗号分隔,可空)' 1)
OOB=$(ask OOB_IN 'OOB 回连端口(逗号分隔,不需要填 none)' 1)
PW=$(ask PW_IN '管理员初始口令(可空=跳过自动起监听器)' 1)

echo
echo "== 写入 ${REPO} =="
set_var APP_REPO "${REPO_SRC}"
set_var APP_REF "${REF_SRC}"
set_var FRP_SERVER_ADDR "${SRV_ADDR}"
set_var APP_CMD_PKG "${CMD_PKG}"
set_var APP_ADMIN_USER "${ADMIN_USER}"
[ -n "${OOB_HOST}" ] && set_var OOB_PUBLIC_HOST "${OOB_HOST}"

set_secret FRP_BIND_PORT "${BIND}"
set_secret FRP_TOKEN "${TOKEN}"
set_secret FRP_REMOTE_PORT "${REMOTE}"
set_secret APP_LOCAL_PORT "${LOCAL}"
[ -n "${ALIAS}" ] && set_secret WEB_ALIAS_PORTS "${ALIAS}"
set_secret OOB_PORTS "${OOB}"
[ -n "${PW}" ] && set_secret APP_INIT_PASSWORD "${PW}"

echo
echo "完成。核对：gh variable list -R ${REPO} / gh secret list -R ${REPO}（secret 只列名字，不显示值）。"
