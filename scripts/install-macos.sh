#!/bin/bash
# install-macos.sh — mixrouter 的安装 / 升级入口(仅 macOS;只用系统自带工具 + 已装好的 node)。
#
# ⚠ 脚本开发完成**不等于**已获得在线运行授权。
#   本脚本只做两件事:①把源码装进一个**不可变的发布目录**;②把"目标路径 / 服务配置差异 /
#   备份位置"在写盘之前先摆出来给人看。它**不会**:
#     · 不执行 launchctl bootstrap / bootout / kickstart,不启动、不重启、不停止任何服务;
#     · 不写入 ~/Library/LaunchAgents(现有的 LaunchAgent 一个字节都不碰);
#     · 不改任何客户端配置(~/.claude/settings.json、~/.codex/config.toml);
#     · 不碰运行数据目录里的 providers.json / routes.json / slots.json / sessions.json / logs / backups;
#     · 不设 current 之外的文件系统状态;切换服务是**别人在授权之后**的事。
#   建议的服务配置会以文件形式落在发布目录的 launchd/ 下,并打印与现有 plist 的差异 ——
#   落地它、以及重新 bootstrap,都要另有一次明确授权。
#
# 用法:
#   scripts/install-macos.sh [选项]
#
#   --dry-run        干跑(默认行为):只显示计划,不写任何文件
#   --apply          真正写入发布目录与数据目录骨架
#   --yes            非交互确认。--apply 时必需(stdin 不是终端时不能靠在屏幕上等一个回答)
#   --prefix DIR     安装根,默认 $HOME/.local/share/mixrouter(其下 releases/ data/ backups/)
#   --release NAME   发布目录名,默认 <package.json 版本>-<源码修订前 8 位>
#   --source DIR     源码来源,默认本脚本所在仓库
#   --port N         代理端口,默认 8787;--ui-port N 控制台端口,默认 8788
#   -h | --help      显示本帮助
#
# 三条硬失败(都以非 0 退出码结束,并打印人话原因):
#   · node 缺失或主版本低于 package.json engines 要求(默认 >= 18)
#   · 发布目录 / 数据目录 / 备份目录的最邻近已存在祖先不可写
#   · 代理端口或控制台端口已被占用
#
# 幂等:重复运行**不覆盖**任何已存在的内容。发布目录已存在且与源码一致 → 跳过;不一致 →
# 报错拒绝覆盖(升级请换一个 --release 名,或先人工确认旧目录可以删除)。
# 运行数据目录里的配置文件一律只创建目录骨架,已存在的文件不动、不读、不备份。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DEFAULT="$(cd "$SCRIPT_DIR/.." && pwd)"

DRY_RUN=1
CONFIRMED=0
PREFIX=""
RELEASE_NAME=""
SOURCE="$SOURCE_DEFAULT"
PROXY_PORT=""
UI_PORT=""

# 用法正文就写在**下面这一段**里(不是头注释):头注释很长,而 --help 要能在终端里一眼读完。
usage() {
  cat <<'USAGE'
用法: scripts/install-macos.sh [选项]

  --dry-run        干跑(默认行为):只显示计划,不写任何文件
  --apply          真正写入发布目录与数据目录骨架
  --yes            非交互确认。--apply 时必需(stdin 不是终端时不能靠在屏幕上等一个回答)
  --prefix DIR     安装根,默认 $HOME/.local/share/mixrouter(其下 releases/ data/ backups/)
  --release NAME   发布目录名,默认 <package.json 版本>-<源码修订前 8 位>
  --source DIR     源码来源,默认本脚本所在仓库
  --port N         代理端口,默认 8787;--ui-port N 控制台端口,默认 8788
  -h | --help      显示本帮助

本脚本不执行任何服务管理命令(不装载、不卸载、不重启、不重新拉起服务),不写入
~/Library/LaunchAgents,也不改 ~/.claude/settings.json / ~/.codex/config.toml。
它只把源码装进一个不可变的发布目录,并先把「目标目录 /
服务配置差异 / 备份位置」摆出来给人看。落地服务配置与切换服务是授权之后的另一件事。
⚠ 脚本开发完成不等于已获得在线运行授权。
USAGE
}

die() { printf '× %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

# ---------------------------------------------------------------- 参数
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --apply) DRY_RUN=0 ;;
    --yes|-y) CONFIRMED=1 ;;
    --prefix) [ "$#" -ge 2 ] || die "--prefix 缺少目录"; PREFIX="$2"; shift ;;
    --release) [ "$#" -ge 2 ] || die "--release 缺少名字"; RELEASE_NAME="$2"; shift ;;
    --source) [ "$#" -ge 2 ] || die "--source 缺少目录"; SOURCE="$2"; shift ;;
    --port) [ "$#" -ge 2 ] || die "--port 缺少端口号"; PROXY_PORT="$2"; shift ;;
    --ui-port) [ "$#" -ge 2 ] || die "--ui-port 缺少端口号"; UI_PORT="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    # 帮助与用法错误**先于任何检查**:用法都看不到就报"找不到 node",是拿环境问题
    # 盖住真正要说的那句话。
    *) usage >&2; die "无法识别的参数:$1" ;;
  esac
  shift
done

# 端口:先做纯词法校验,再交给 node 归一到整数。默认值取自 lib/paths.js 的 DEFAULT_PORTS。
for pair in "代理端口:${PROXY_PORT}" "控制台端口:${UI_PORT}"; do
  label="${pair%%:*}"; value="${pair#*:}"
  [ -z "$value" ] && continue
  case "$value" in *[!0-9]*) die "${label}必须是数字,实得:${value}" ;; esac
done

SOURCE="$(cd "$SOURCE" && pwd)" # 相对路径先归一到绝对;目录不存在时 cd 会失败,正是我们要的
[ -f "$SOURCE/package.json" ] || die "$SOURCE 里没有 package.json,不是 mixrouter 源码目录"

# ---------------------------------------------------------------- node 定位与版本
# node:与 scripts/launchd-run.sh、app/MixrouterApp.swift 同一套路子 —— PATH 优先,
# 再兜底 nvm 目录。**不问登录 shell**:那会读用户的 rc 文件,找到哪一份 node 取决于
# 用户的 shell 配置,不但结果不可预测,还让"PATH 里没有 node"这个失败条件测不出来。
# 不写死任何个人绝对路径 —— 全部经 $HOME / PATH 推导。
find_node() {
  local candidate latest
  candidate="$(command -v node 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  latest=""
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$candidate" ] && latest="$candidate"
  done
  [ -n "$latest" ] && { printf '%s' "$latest"; return 0; }
  return 1
}

step "检查运行环境"
NODE="$(find_node || true)"
[ -n "${NODE:-}" ] || die "找不到 node(检查 PATH,或 \$HOME/.nvm/versions/node/*/bin/)。mixrouter 需要 Node >= 18"

REQUIRED_MAJOR="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*">=[[:space:]]*\([0-9][0-9]*\)".*/\1/p' "$SOURCE/package.json")"
REQUIRED_MAJOR="${REQUIRED_MAJOR%%$'\n'*}"
[ -n "$REQUIRED_MAJOR" ] || REQUIRED_MAJOR=18

NODE_VERSION="$("$NODE" --version 2>/dev/null || true)"
[ -n "$NODE_VERSION" ] || die "无法读取 node 版本($NODE --version 没有输出)。换一个 node 再试"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
case "$NODE_MAJOR" in ''|*[!0-9]*) die "无法解析 node 版本:$NODE_VERSION" ;; esac
if [ "$NODE_MAJOR" -lt "$REQUIRED_MAJOR" ]; then
  # ⚠ 这里必须写 ${REQUIRED_MAJOR} 而不是 $REQUIRED_MAJOR:变量名后面紧跟一个中文字符时,
  # bash 3.2(macOS 自带的 /bin/bash)会把那个字符的第一个字节当成变量名的一部分,
  # 于是 `$REQUIRED_MAJOR。` 变成读取一个叫 REQUIRED_MAJOR\xe3 的变量 —— set -u 下当场报
  # "unbound variable",而且报出来的名字里那个乱码看得出是哪一步。本仓另有同类教训。
  die "node 版本不合要求:当前 ${NODE_VERSION}(${NODE}),package.json 要求 >= ${REQUIRED_MAJOR}。请先升级 node(如 nvm install ${REQUIRED_MAJOR}),再重跑本脚本"
fi
note "node $NODE_VERSION($NODE),要求 >= $REQUIRED_MAJOR — 通过"

# ---------------------------------------------------------------- 路径计划(唯一来源 lib/paths.js)
# 路径一律从模块取,不在 shell 里再拼一遍 —— 那正是本次要消灭的"各自拼接"。
plan_lines() {
  "$NODE" -e '
    const paths = require(process.argv[1]);
    const num = v => (v === "" ? undefined : Number(v));
    const plan = paths.installPlan({
      root: process.argv[2], home: process.argv[3],
      prefix: process.argv[4] || undefined,
      releaseName: process.argv[5] || undefined,
      ports: { proxy: num(process.argv[6]), ui: num(process.argv[7]) },
    });
    for (const [key, value] of Object.entries(plan)) {
      console.log(`${key}=${Array.isArray(value) ? value.join(":") : value}`);
    }
  ' "$SOURCE/lib/paths.js" "$SOURCE" "$HOME" "$PREFIX" "$RELEASE_NAME" \
    "${PROXY_PORT:-}" "${UI_PORT:-}" || return 1
}

# 发布目录名默认 <版本>-<源码修订前 8 位>。源码修订取 lib/runtime-code.js 的同一份哈希 ——
# "装进去的那份字节"与"服务启动时报的 code_revision"因此是同一个函数算出来的。
default_release_name() {
  "$NODE" -e '
    const path = require("path"), fs = require("fs");
    const { codeRevision } = require(process.argv[1]);
    const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const rev = codeRevision(process.argv[3]).slice(0, 8) || "norev";
    process.stdout.write(`${pkg.version}-${rev}`);
  ' "$SOURCE/lib/runtime-code.js" "$SOURCE/package.json" "$SOURCE"
}

if [ -z "$RELEASE_NAME" ]; then
  RELEASE_NAME="$(default_release_name)" || die "算不出发布目录名(读不到 package.json 或 lib/runtime-code.js)"
fi

PLAN="$(plan_lines)" || die "无法解析路径计划(lib/paths.js 出错)"
get() { printf '%s\n' "$PLAN" | sed -n "s/^$1=//p"; }

DEV_ROOT="$(get devRoot)"
INSTALL_ROOT="$(get installRoot)"
RELEASE_ROOT="$(get releaseRoot)"
CURRENT_LINK="$(get currentRelease)"
RELEASE_DIR="$(get releaseDir)"
DATA_DIR="$(get dataDir)"
LOG_DIR="$(get logDir)"
BACKUP_ROOT="$(get backupRoot)"
LAUNCH_AGENT_DIR="$(get launchAgentDir)"
CLAUDE_SETTINGS="$(get claudeSettings)"
CODEX_CONFIG="$(get codexConfig)"
PORT_PROXY="$(get proxyPort)"
PORT_UI="$(get uiPort)"
RELEASE_ITEMS="$(get releaseItems)"
FORBIDDEN="$(get forbiddenInRelease)"

for required in DEV_ROOT INSTALL_ROOT RELEASE_ROOT CURRENT_LINK RELEASE_DIR DATA_DIR LOG_DIR BACKUP_ROOT PORT_PROXY PORT_UI RELEASE_ITEMS FORBIDDEN; do
  eval "value=\${$required:-}"
  [ -n "$value" ] || die "路径计划缺少 $required"
done

# ---------------------------------------------------------------- 可写性(最邻近已存在祖先)
# 不为了"测一下能不能写"而先把目录建出来 —— 干跑绝不许留下任何痕迹。
nearest_existing() {
  local dir="$1"
  while [ ! -e "$dir" ]; do dir="$(dirname "$dir")"; done
  printf '%s' "$dir"
}
require_writable() {
  local label="$1" target="$2" ancestor
  ancestor="$(nearest_existing "$target")"
  [ -w "$ancestor" ] || die "目标目录不可写:${label} ${target}(最近的已存在祖先 ${ancestor} 不可写)。换一处 --prefix,或修好权限再重跑"
}

step "检查目标目录可写性"
require_writable "发布目录" "$RELEASE_ROOT"
require_writable "数据目录" "$DATA_DIR"
require_writable "备份目录" "$BACKUP_ROOT"
note "发布目录 / 数据目录 / 备份目录的可写性 — 通过"

# ---------------------------------------------------------------- 端口占用
port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  if command -v nc >/dev/null 2>&1; then
    if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then return 0; fi
    return 1
  fi
  # 兜底:借 node 试一下能不能绑上。退出码 0 = 绑不上(被占),1 = 绑得上(空闲)。
  if "$NODE" -e '
    const net = require("net");
    const server = net.createServer();
    server.once("error", () => process.exit(0));
    server.listen(Number(process.argv[1]), "127.0.0.1", () => server.close(() => process.exit(1)));
  ' "$port" >/dev/null 2>&1; then return 0; fi
  return 1
}

step "检查端口"
for pair in "代理端口:${PORT_PROXY}" "控制台端口:${PORT_UI}"; do
  label="${pair%%:*}"; port="${pair#*:}"
  if port_in_use "$port"; then
    die "${label} ${port} 已被占用。先确认占用它的进程(如 lsof -nP -iTCP:${port} -sTCP:LISTEN);若是现役 mixrouter,请在授权的空闲窗口里停掉它再重跑本脚本"
  fi
done
note "代理 ${PORT_PROXY} / 控制台 ${PORT_UI} 都空闲 — 通过"

# ---------------------------------------------------------------- 建议的服务配置
# 生成到一个临时文件里(不进发布目录、不进 ~/Library/LaunchAgents),只用来打印差异。
NEW_PLIST="$(mktemp "${TMPDIR:-/tmp}/mixr-install-plist.XXXXXX")"
PROPOSED_RELEASE_DIR="$RELEASE_DIR"
cleanup() { rm -f "$NEW_PLIST"; }
trap cleanup EXIT

write_plist() {
  cat > "$NEW_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.$(id -un).mixrouter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>$PROPOSED_RELEASE_DIR/scripts/launchd-run.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROPOSED_RELEASE_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- 数据目录固定在安装根下,不跟着代码目录走:升级换的是 releases/ 下的目录,数据不动。 -->
    <key>MIXR_DATA_DIR</key>
    <string>$DATA_DIR</string>
    <key>PATH</key>
    <string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/launchd.log</string>
</dict>
</plist>
PLIST
}

find_installed_plist() {
  local file
  for file in "$LAUNCH_AGENT_DIR"/*.mixrouter.plist; do
    if [ -e "$file" ]; then printf '%s' "$file"; return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- 幂等:已存在的发布目录
# 目标路径必须按**解析后**的真实路径判断:使用安装根下的 current 链接时,它可能指向别处。
# 覆盖安装时 rsync 还要求目标不存在,所以判据与写入用同一个变量,不能一个用链接名、一个用真实名。
if [ -L "$RELEASE_DIR" ]; then RESOLVED_DIR="$(cd "$RELEASE_DIR" && pwd -P)"; else RESOLVED_DIR="$RELEASE_DIR"; fi
DECISION="install"
if [ -e "$RESOLVED_DIR" ]; then
  DECISION="compare"
fi

# 逐项比对源码与已存在的发布目录。只比白名单里的条目 —— 发布目录里还躺着上次生成的
# launchd/ 与 RELEASE.json,它们不在源码里,不属于"源码内容"。
compare_release() {
  local item differs=0
  local old_ifs="$IFS"
  IFS=':'
  for item in $RELEASE_ITEMS; do
    if [ ! -e "$SOURCE/$item" ]; then continue; fi
    IFS="$old_ifs"
    if [ ! -e "$RESOLVED_DIR/$item" ]; then differs=1; note "源码有而发布目录缺:$item"; IFS=':'; continue; fi
    if ! diff -r "$SOURCE/$item" "$RESOLVED_DIR/$item" >/dev/null 2>&1; then
      differs=1; note "内容不同:$item"
    fi
    IFS=':'
  done
  IFS="$old_ifs"
  return "$differs"
}

# ---------------------------------------------------------------- 先显示,再执行
CONFIG_SKIPS=""
for target in "$DATA_DIR/providers.json" "$DATA_DIR/routes.json" "$DATA_DIR/slots.json" "$DATA_DIR/sessions.json"; do
  if [ -e "$target" ]; then CONFIG_SKIPS="$CONFIG_SKIPS$target$'\n'"; fi
done

printf '\n===== 安装计划 =====\n'
printf '%-18s %s\n' "开发副本(来源)" "$DEV_ROOT"
printf '%-18s %s\n' "安装根" "$INSTALL_ROOT"
printf '%-18s %s\n' "发布目录" "$RELEASE_DIR"
if [ -L "$CURRENT_LINK" ]; then
  printf '%-18s %s → %s\n' "current" "$CURRENT_LINK" "$(readlink "$CURRENT_LINK")"
else
  printf '%-18s %s(尚未建立)\n' "current" "$CURRENT_LINK"
fi
printf '%-18s %s\n' "运行数据目录" "$DATA_DIR"
printf '%-18s %s\n' "日志目录" "$LOG_DIR"
printf '%-18s %s\n' "备份位置" "$BACKUP_ROOT"
printf '%-18s %s\n' "端口" "代理 ${PORT_PROXY} / 控制台 ${PORT_UI}"
printf '%-18s %s\n' "发布内容" "按白名单复制 $(printf '%s' "$RELEASE_ITEMS" | tr ':' ' ')"
printf '%-18s %s\n' "发布物禁止项" "出现即失败:$(printf '%s' "$FORBIDDEN" | tr ':' ' ')"
printf '\n写入范围(仅此四处):\n'
note "① $RELEASE_DIR(代码 + launchd/ 下的建议服务配置 + RELEASE.json)"
note "② $DATA_DIR 与 $LOG_DIR(只建目录,已存在的文件一律不动)"
note "③ $BACKUP_ROOT(只建目录)"
note "④ $CURRENT_LINK 符号链接(指向新发布目录;不重启、不影响正在运行的服务)"
printf '\n本脚本不写入:\n'
note "客户端配置: $CLAUDE_SETTINGS"
note "            $CODEX_CONFIG"
note "LaunchAgent: $LAUNCH_AGENT_DIR(只读出来做差异对比,不写入)"
if [ -n "$CONFIG_SKIPS" ]; then
  printf '\n已存在、本次跳过(不覆盖)的配置文件:\n'
  printf '%s' "$CONFIG_SKIPS" | while IFS= read -r line; do [ -n "$line" ] && note "$line"; done
fi

step "服务配置差异(建议内容 vs 现状)"
write_plist
INSTALLED_PLIST="$(find_installed_plist || true)"
if [ -n "${INSTALLED_PLIST:-}" ]; then
  note "现状:$INSTALLED_PLIST"
  if diff -u "$INSTALLED_PLIST" "$NEW_PLIST" >/dev/null 2>&1; then
    note "与建议内容一致,无差异"
  else
    diff -u "$INSTALLED_PLIST" "$NEW_PLIST" || true
  fi
  note "以上差异只作展示。本脚本不会把它写进 $LAUNCH_AGENT_DIR,也不会 reload 任何服务"
else
  note "$LAUNCH_AGENT_DIR 下没有 *.mixrouter.plist,建议内容如下(仅展示,未落地):"
  sed 's/^/    /' "$NEW_PLIST"
fi

if [ "$DECISION" = "compare" ]; then
  step "发布目录已存在:核对内容"
  note "$RELEASE_DIR"
  if compare_release; then
    note "与源码一致 —— 跳过复制,不覆盖任何已有内容"
  else
    die "$RELEASE_DIR 已存在且内容与源码不同,拒绝覆盖。升级请换一个 --release 名(例如 --release ${RELEASE_NAME}-2),或在确认旧目录无用后人工删除它再重跑"
  fi
fi

# ---------------------------------------------------------------- 干跑到此为止
if [ "$DRY_RUN" -eq 1 ]; then
  step "干跑结束"
  note "上面是计划,没有写入任何文件。确认无误后加 --apply 执行。"
  exit 0
fi

# ---------------------------------------------------------------- 执行前的确认
# 非交互(stdin 不是终端)时**不能**在屏幕上等一个回答:没有 --yes 就明确失败,
# 不能因为读不到输入而静默继续,也不能挂住等 stdin。
if [ "$CONFIRMED" -ne 1 ]; then
  if [ ! -t 0 ]; then
    die "非交互环境下 --apply 需要同时给 --yes(没有终端可以确认)。已中止,未写入任何文件"
  fi
  printf '\n把上面的计划落地?[y/N] '
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes|YES) ;;
    *) die "已取消,未写入任何文件" ;;
  esac
fi

# ---------------------------------------------------------------- 执行:发布目录
step "写入发布目录"
if [ "$DECISION" = "install" ]; then
  mkdir -p "$RELEASE_ROOT"
  STAGE="$RELEASE_ROOT/.staging-${RELEASE_NAME}-$$"
  mkdir -p "$STAGE"
  # 半路失败不留半个发布目录:先写暂存名,整份就绪后再改名为最终名。这与 providers.json
  # 的落盘纪律一致(整份换新或原样不动,不产生"写了一半"的状态)。
  # 这里**没有 rm -rf**:暂存目录名带 pid,本次进程不可能已经存在它;真要清理也只清这一个是
  # 自己建的。发布目录是不可变的,任何"清空后重写"的写法都与这个前提冲突。
  trap 'rm -rf "$STAGE"; cleanup' EXIT
  IFS_SAVE="$IFS"; IFS=':'
  for item in $RELEASE_ITEMS; do
    if [ -e "$SOURCE/$item" ]; then rsync -a --relative "$SOURCE/./$item" "$STAGE/"; note "复制 $item"; fi
  done
  IFS="$IFS_SAVE"
  # 发布物自检:这些名字一个都不许出现(含明文 key 或本机运行状态)。
  # 判据是**清单**而不是"复制过程没带过来" —— 将来有人往白名单里加错一项,这里会当场拦住。
  IFS_SAVE="$IFS"; IFS=':'
  for banned in $FORBIDDEN; do
    IFS="$IFS_SAVE"
    [ -e "$STAGE/$banned" ] && die "发布物里出现了禁止项 $banned —— 拒绝安装(它要么含明文 key,要么是本机运行状态)"
    IFS=':'
  done
  IFS="$IFS_SAVE"

  "$NODE" -e '
    const fs = require("fs");
    const { codeRevision } = require(process.argv[1]);
    const pkg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const manifest = {
      version: pkg.version,
      code_revision: codeRevision(process.argv[3]),
      release: process.argv[4],
      installed_at: new Date().toISOString(),
      source: process.argv[3],
      data_dir: process.argv[5],
      items: process.argv[6].split(":"),
    };
    fs.writeFileSync(process.argv[7], JSON.stringify(manifest, null, 2) + "\n");
  ' "$SOURCE/lib/runtime-code.js" "$SOURCE/package.json" "$SOURCE" "$RELEASE_NAME" \
    "$DATA_DIR" "$RELEASE_ITEMS" "$STAGE/RELEASE.json" || die "写入 RELEASE.json 失败"

  mkdir -p "$STAGE/launchd"
  cp "$NEW_PLIST" "$STAGE/launchd/com.$(id -un).mixrouter.plist"
  note "服务配置(建议,未落地):launchd/com.$(id -un).mixrouter.plist"
  # 这里**不**预先建 logs/ 与 .run/:它们既在发布物的禁止清单里,也确实属于运行状态。
  # launchd-run.sh 与 mixctl 各自会在需要时 mkdir(launchd-run.sh:13、mixctl 的 start 分支)。

  if [ -e "$RESOLVED_DIR" ]; then
    # DECISION=install 却走到这里,只可能是符号链接解析到了别处(内容一致的普通目录在上面已跳过)。
    # 往链接指向的目录里改名,等于改写一份不属于本次安装的发布目录 —— 拒绝。
    die "$RELEASE_DIR 解析为 $RESOLVED_DIR,与本次要装的发布目录不是同一个路径,拒绝改写"
  fi
  mv "$STAGE" "$RESOLVED_DIR"
  trap cleanup EXIT
  RELEASE_DIR="$RESOLVED_DIR"
  note "发布目录就绪:$RELEASE_DIR"
else
  RELEASE_DIR="$RESOLVED_DIR"
  note "发布目录已存在且内容一致,跳过复制(未覆盖任何文件)"
fi

# ---------------------------------------------------------------- 执行:数据骨架与 current
step "建立数据目录骨架(只建目录)"
mkdir -p "$DATA_DIR" "$LOG_DIR" "$BACKUP_ROOT"
chmod 700 "$DATA_DIR" "$LOG_DIR" "$BACKUP_ROOT" 2>/dev/null || true
note "$DATA_DIR"
note "$LOG_DIR"
note "$BACKUP_ROOT"
note "已存在的配置文件一个都没动、没读、没备份"

step "更新 current 符号链接"
PREVIOUS_TARGET=""
if [ -L "$CURRENT_LINK" ]; then PREVIOUS_TARGET="$(readlink "$CURRENT_LINK" || true)"; fi
ALIVE_PID=""
if [ -f "$RELEASE_DIR/.run/mixrouter.pid" ]; then
  candidate_pid="$(cat "$RELEASE_DIR/.run/mixrouter.pid" 2>/dev/null || true)"
  case "${candidate_pid:-}" in ''|*[!0-9]*) ;; *) kill -0 "$candidate_pid" 2>/dev/null && ALIVE_PID="$candidate_pid" ;; esac
fi
mkdir -p "$(dirname "$CURRENT_LINK")"
ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"
note "$CURRENT_LINK → $RELEASE_DIR"
if [ -n "$PREVIOUS_TARGET" ]; then
  note "回退方式:ln -sfn $PREVIOUS_TARGET $CURRENT_LINK(上一版记录于此,仅作提示)"
fi
if [ -n "$ALIVE_PID" ]; then
  note "⚠ 检测到有进程(pid $ALIVE_PID)正从该发布目录运行。本次只换了文件与链接,没有重启、没有停止任何服务"
fi

step "完成"
note "文件已就位。**服务没有被启动、重启或停止**;LaunchAgent 未被改动。"
note "要真正切到新版本,需在授权后的空闲窗口里另行处理(由人工重新装载服务配置)。"
