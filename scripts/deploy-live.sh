#!/bin/bash
# 上线（切到某个已推送的提交）与回退。**默认干跑**，必须显式 --apply 才动线上。
#
#   MIXR_LIVE_DIR=/path/to/live ./scripts/deploy-live.sh                       # 干跑:只报告将做什么
#   MIXR_LIVE_DIR=/path/to/live ./scripts/deploy-live.sh --apply <commit>      # 切到该提交
#   MIXR_LIVE_DIR=/path/to/live ./scripts/deploy-live.sh --rollback --apply    # 回退到上次上线前的提交
#
# ⚠ 这是**运维脚本**，不是安装路径。它假定线上目录是一个 git 克隆、服务由 launchd 托管，
#   并且切换会短暂中断本机出站。新安装请用 scripts/install-macos.sh，或直接 `node mixrouter.js`。
#   **本脚本不随源码包发布**（scripts/release-manifest.js 的 EXCLUDE），因为它只对
#   "一台由人长期维护的线上机器"有意义；默认值写死任何人的目录都会在别人的机器上指错。
#   线上目录因此**必须**由 MIXR_LIVE_DIR 显式给出；其余默认值都能安全推导或被覆盖。
#   MIXR_BRANCH（默认 main）/ MIXR_REF / MIXR_LAUNCHD_LABEL（默认 com.<当前用户>.mixrouter）/
#   MIXR_DEV_DIR（预检脚本所在仓库，默认本脚本所在仓库）。
#
# 为什么要有这个脚本，而不是手敲几条命令：
#   线上服务既供控制台，也是**本机 Claude Code 的出站通道**（~/.claude/settings.json 的
#   ANTHROPIC_BASE_URL 指向 127.0.0.1:8787）。新版起不来时，控制台和客户端会**同时**断，
#   而人在睡觉。所以这里把"先取证、再切、切完自检、自检失败自动回退"写成一条固定路径，
#   失败回退不需要人在场。
#
# 关键约束：
#   · 只动 $LIVE_DIR（代码 + public/）与其数据目录的**备份**；不碰 ~/.claude 等客户端配置。
#   · 代码与静态资源**同一次切换**：控制台每请求 readFileSync(public/index.html)，新版
#     index.html 引用 /styles/base.css 与 /js/app.js，只有新版 console.js 会服务它们。
#     先换 public 不换代码 = 控制台立刻白屏。
#   · 任何一步失败都停，不"继续试试"。回退失败则保留现场并明确报出来，不静默。
#   · 数据文件（providers/routes/slots/sessions.json）只**备份**，不迁移、不改写。
set -euo pipefail

LIVE_DIR="${MIXR_LIVE_DIR:-}"
BRANCH="${MIXR_BRANCH:-main}"
REF="${MIXR_REF:-origin/$BRANCH}"
HEALTH_TIMEOUT="${MIXR_HEALTH_TIMEOUT:-60}"
PROXY_PORT="${MIXR_PROXY_PORT:-8787}"
UI_PORT="${MIXR_UI_PORT:-8788}"
LABEL="${MIXR_LAUNCHD_LABEL:-com.$(id -un).mixrouter}"
RUN_DIR="$LIVE_DIR/.run"
STATE_FILE="$RUN_DIR/deploy-state.json"

APPLY=0; MODE="deploy"; TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --rollback) MODE="rollback" ;;
    -h|--help) awk '/^set -euo/{exit} {print}' "$0"; exit 0 ;;
    --*) echo "未知参数:$1" >&2; exit 2 ;;
    *) TARGET="$1" ;;
  esac
  shift
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()  { printf '失败:%s\n' "$*" >&2; exit 1; }
# 没有显式线上目录就什么都不做：猜一个目录的后果是"在别人的机器上把另一个仓库切走"。
if [ -z "$LIVE_DIR" ]; then
  printf '需要 MIXR_LIVE_DIR=<线上 git 克隆的绝对路径>，例如:\n' >&2
  printf '  MIXR_LIVE_DIR="$HOME/src/mixrouter" ./scripts/deploy-live.sh\n' >&2
  exit 2
fi
# 切过代码之后再失败,必须把树放回 OLD_COMMIT —— 否则"半切换"(新版代码/旧版资源或反之)
# 会让控制台白屏,而人不在场。checkout 本身失败也要报出来,不静默。
restore_and_die() {
  printf '失败:%s\n' "$1" >&2
  printf '正在把代码放回 %s ...\n' "$OLD_COMMIT" >&2
  git -C "$LIVE_DIR" checkout --quiet "$OLD_COMMIT" 2>/dev/null \
    && printf '已放回 %s(服务未重启,仍是旧进程;数据未动)\n' "$(git -C "$LIVE_DIR" rev-parse --short HEAD)" >&2 \
    || printf '警告:放回失败,现场保留在 %s,请人工核对\n' "$LIVE_DIR" >&2
  exit 1
}

[ -d "$LIVE_DIR/.git" ] || die "不是 git 仓库:$LIVE_DIR"

# ---------------------------------------------------------------- 只读取证
step "1/8 取证(只读)"
REMOTE="$(git -C "$LIVE_DIR" remote | head -1)"
[ -n "$REMOTE" ] || die "线上目录没有配置远端"
# **显式抓取目标分支**,不依赖仓库里配的 fetch refspec。线上目录的 refspec 被收窄成
# `+refs/heads/main:refs/remotes/origin/main`(只跟 main),照默认 `git fetch` 的话
# origin/refactor/* 这些 ref 永远不更新 —— 表面上 fetch 成功,实际拿到的还是旧引用,
# 于是"目标提交解析不了"或更糟:解析到一个旧提交还以为是最新的。
# 写成 src:dst 形式把该分支落到它自己的 remote-tracking ref,与 refspec 配置无关。
git -C "$LIVE_DIR" fetch --quiet "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" \
  || die "fetch 失败(网络?)"
OLD_COMMIT="$(git -C "$LIVE_DIR" rev-parse HEAD)"
if [ "$MODE" = "rollback" ]; then
  [ -f "$STATE_FILE" ] || die "没有 $STATE_FILE,不知道回退到哪里"
  NEW_COMMIT="$(python3 -c "import json;print(json.load(open('$STATE_FILE'))['previous_commit'])")"
  say "回退目标(取自 $STATE_FILE):$NEW_COMMIT"
elif [ -n "$TARGET" ]; then
  # --verify + ^{commit}:只接受一个能解析成提交对象的名字,解析不出就整条命令失败。
  # 不能写成 `rev-parse "$TARGET" || rev-parse "$REF"`——TARGET 为空时前一条会先吐一个空行
  # 再失败,命令替换把空行也captured进去,最后拿到 "\n<sha>" 这种带换行的值,后面 cat-file 必炸。
  NEW_COMMIT="$(git -C "$LIVE_DIR" rev-parse --verify --quiet "$TARGET^{commit}")" \
    || die "目标不是一个能解析的提交:$TARGET"
else
  NEW_COMMIT="$(git -C "$LIVE_DIR" rev-parse --verify --quiet "$REF^{commit}")" \
    || die "解析不了默认引用:$REF(是不是还没 fetch 到?)"
fi
say "线上目录 : $LIVE_DIR"
say "当前提交 : $OLD_COMMIT"
say "目标提交 : $NEW_COMMIT"
if git -C "$LIVE_DIR" cat-file -e "$NEW_COMMIT^{commit}" 2>/dev/null; then :; else die "目标提交不存在:$NEW_COMMIT"; fi

MODIFIED="$(git -C "$LIVE_DIR" status --porcelain --untracked-files=no)"
[ -z "$MODIFIED" ] || { say "$MODIFIED"; die "线上目录有**已跟踪文件**的本地改动,先人工处理(不自动丢弃)"; }
say "已跟踪文件:干净"

LIVE_PID="$(lsof -ti tcp:$PROXY_PORT 2>/dev/null | head -1 || true)"
say "代理端口 $PROXY_PORT 当前 pid: ${LIVE_PID:-无}"
say "控制台端口 $UI_PORT : $(lsof -ti tcp:$UI_PORT 2>/dev/null | head -1 || echo 无)"

# 上线前预检:新版代码吃**线上数据副本**,验能加载 + 控制台资源齐。
step "2/8 预检(新版代码 × 线上数据副本,临时端口)"
# 预检脚本默认从**本脚本所在仓库**取(开发副本),可用 MIXR_DEV_DIR 指到另一份源码;
# 两者都没有就直接跳过 —— 不拿别人的目录去猜。
DEV_DIR="${MIXR_DEV_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
if [ -f "$DEV_DIR/scripts/preflight-live-data.js" ]; then
  MIXR_LIVE_DIR="$LIVE_DIR" node "$DEV_DIR/scripts/preflight-live-data.js" || die "预检未通过,不上线"
else
  say "跳过预检:找不到 $DEV_DIR/scripts/preflight-live-data.js(MIXR_DEV_DIR 可指定)"
fi

if [ "$APPLY" -ne 1 ]; then
  step "干跑结束"
  say "以上为将执行的动作。真正上线加 --apply。"
  exit 0
fi

# ---------------------------------------------------------------- 备份
step "3/8 备份数据与现场"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="$LIVE_DIR/backups/deploy-$STAMP"
mkdir -p "$BACKUP_DIR"
for f in providers.json routes.json slots.json sessions.json; do
  [ -f "$LIVE_DIR/$f" ] && cp -p "$LIVE_DIR/$f" "$BACKUP_DIR/$f"
done
# 未跟踪文件(会被 checkout 拦住或被 clean 删掉的)先搬到备份区,不丢
git -C "$LIVE_DIR" status --porcelain --untracked-files=all | awk '$1=="??"{print $2}' > "$BACKUP_DIR/untracked.list" || true
if [ -s "$BACKUP_DIR/untracked.list" ]; then
  mkdir -p "$BACKUP_DIR/untracked"
  while IFS= read -r rel; do
    [ -e "$LIVE_DIR/$rel" ] || continue
    mkdir -p "$BACKUP_DIR/untracked/$(dirname "$rel")"
    cp -Rp "$LIVE_DIR/$rel" "$BACKUP_DIR/untracked/$rel" 2>/dev/null || true
  done < "$BACKUP_DIR/untracked.list"
  say "未跟踪文件已备份到 $BACKUP_DIR/untracked(共 $(wc -l < "$BACKUP_DIR/untracked.list" | tr -d ' ') 项)"
  # 备份后移除,否则 checkout 会被"untracked 会被覆盖"拦住
  while IFS= read -r rel; do
    [ -e "$LIVE_DIR/$rel" ] && rm -rf "$LIVE_DIR/$rel"
  done < "$BACKUP_DIR/untracked.list"
fi
mkdir -p "$RUN_DIR"
python3 - "$STATE_FILE" "$OLD_COMMIT" "$NEW_COMMIT" "$BACKUP_DIR" <<'PY'
import json,sys,time
path,old,new,bak=sys.argv[1:5]
json.dump({"previous_commit":old,"target_commit":new,"backup_dir":bak,"at":time.strftime("%Y-%m-%dT%H:%M:%S")},open(path,"w"),ensure_ascii=False,indent=2)
PY
say "数据已备份:$BACKUP_DIR"
say "上次提交已记:$STATE_FILE"

# ---------------------------------------------------------------- 切代码
step "4/8 切换代码 + 静态资源(同一次)"
# 优先切**分支**(而不是分离头),这样线上目录仍指着 refactor/console-api,以后
# `git status`/`git pull` 语义不变;分支路径任何一步不成立就退回切提交(照样能跑)。
SWITCHED=0
if [ "$MODE" != "rollback" ] && [ -z "$TARGET" ]; then
  if git -C "$LIVE_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    # 本地已有该分支:切过去再快进
    git -C "$LIVE_DIR" checkout --quiet "$BRANCH" 2>/dev/null \
      && git -C "$LIVE_DIR" merge --ff-only --quiet "$NEW_COMMIT" 2>/dev/null && SWITCHED=1
  else
    # 本地没有该分支:按刚抓到的 remote-tracking ref 建一个并跟踪它。
    # 这样线上目录留在**分支**上(而不是分离头),以后 git status / git pull 语义正常。
    git -C "$LIVE_DIR" checkout --quiet --track -b "$BRANCH" "$REMOTE/$BRANCH" 2>/dev/null && SWITCHED=1
  fi
fi
[ "$SWITCHED" -eq 1 ] || git -C "$LIVE_DIR" checkout --quiet "$NEW_COMMIT" || restore_and_die "checkout 失败"
say "已到 $(git -C "$LIVE_DIR" rev-parse --short HEAD) $(git -C "$LIVE_DIR" log -1 --format=%s) [$(git -C "$LIVE_DIR" rev-parse --abbrev-ref HEAD)]"
[ -f "$LIVE_DIR/public/js/app.js" ] || restore_and_die "public/js/app.js 不存在,静态资源没跟上"
[ -f "$LIVE_DIR/public/styles/base.css" ] || restore_and_die "public/styles/base.css 不存在"
say "public/ 已含 app.js 与 base.css"

# ---------------------------------------------------------------- 重启
restart_service() {
  # 只用 `kickstart -k`(与 mixctl start 用的是同一条),**不** bootout/bootstrap。
  # 理由:bootout 会把作业整个卸下,万一随后的 bootstrap 失败,服务就是"没装载、不会自愈、
  # 也没有东西再拉起它"的完全下线状态;而这里要的只是"重启",不是"重装"。
  # kickstart -k 全程让作业保持已装载,launchd 负责停旧起新 —— 失败模式温和得多。
  if launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null; then return 0; fi
  # 没有该 launchd 作业时退回 mixctl(它自己会挑 launchd 或直接起进程)
  say "kickstart 未生效,退回 mixctl restart"
  ( cd "$LIVE_DIR" && ./mixctl restart ) 2>/dev/null || true
}
healthy() { curl -fsS --max-time 5 "http://127.0.0.1:$UI_PORT/healthz" >/dev/null 2>&1; }
wait_healthy() {
  local t0=$SECONDS
  while [ $((SECONDS - t0)) -lt "$HEALTH_TIMEOUT" ]; do
    healthy && return 0
    sleep 1
  done
  return 1
}

step "5/8 重启(launchd)"
say "重启会**短暂中断**本机出站(Claude Code 也走这里)。"
restart_service
if wait_healthy; then
  say "健康端点已就绪"
else
  say "健康端点 ${HEALTH_TIMEOUT}s 内未就绪 —— 自动回退"
  step "6/8 回退到 $OLD_COMMIT"
  git -C "$LIVE_DIR" checkout --quiet "$OLD_COMMIT" || say "警告:回退 checkout 失败,现场保留"
  restart_service
  if wait_healthy; then
    say "已回退到 $(git -C "$LIVE_DIR" rev-parse --short HEAD),服务恢复。"
    say "线上未升级;备份在 $BACKUP_DIR"
    exit 1
  fi
  say "回退后仍不健康。已保留全部现场,未再改动。"
  say "  目录:$LIVE_DIR  备份:$BACKUP_DIR"
  say "  日志:$LIVE_DIR/logs/launchd.log"
  exit 2
fi

# ---------------------------------------------------------------- 自检
step "7/8 自检"
FAIL=0
chk() { if eval "$2" >/dev/null 2>&1; then say "  ok   $1"; else say "  失败 $1"; FAIL=1; fi; }
chk "healthz 200" "curl -fsS --max-time 5 http://127.0.0.1:$UI_PORT/healthz"
chk "/api/state 200 且是 JSON" "curl -fsS --max-time 8 http://127.0.0.1:$UI_PORT/api/state | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d[\"providers\"][\"claude\"]'"
chk "/styles/base.css 200" "curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:$UI_PORT/styles/base.css"
chk "/js/app.js 200" "curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:$UI_PORT/js/app.js"
chk "代理端口在听($PROXY_PORT)" "lsof -ti tcp:$PROXY_PORT"
REV="$(curl -fsS --max-time 8 http://127.0.0.1:$UI_PORT/api/state 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin).get("code_revision","")[:12])' 2>/dev/null || echo '?')"
say "  运行源码修订:$REV"

step "8/8 结果"
if [ "$FAIL" -eq 0 ]; then
  say "上线完成:$(git -C "$LIVE_DIR" rev-parse --short HEAD)"
  say "回退用:./scripts/deploy-live.sh --rollback --apply"
  exit 0
fi
say "自检有项失败 —— 自动回退"
git -C "$LIVE_DIR" checkout --quiet "$OLD_COMMIT" || say "警告:回退 checkout 失败"
restart_service
wait_healthy && say "已回退到 $(git -C "$LIVE_DIR" rev-parse --short HEAD),服务恢复。" || say "回退后仍不健康,现场保留:$BACKUP_DIR"
exit 1
