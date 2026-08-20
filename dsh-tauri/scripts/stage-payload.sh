#!/usr/bin/env bash
# stage-payload.sh —— 打包前置：暂存运行时 payload 到 package-payload/dsh-desktop/
# ==========================================================================
# Tauri 安装包的内核资源（supervisor 的 app_dir）。从 dsh-desktop/ 源头按
# 「Electron extraResources + 生产依赖」口径组装，排除三类大件：
#   1. dist/            —— 旧构建产物（>2GB，与运行时无关）
#   2. node_modules 的 devDependencies（electron / electron-builder /
#      electron-winstaller）——Electron 运行时与打包器，Tauri 版不需要
#   3. vendor/node/node —— unix node 二进制（115MB，win-x64 包只带 node.exe）
#
# 产出布局（resources 映射 → <安装根>/resources/dsh-desktop/，
# 与 lib.rs find_repo_root 的 exe-walk resources/ 子布局回退一致）：
#   dsh-desktop/{package.json, main.js, scripts/, assets/,
#                vendor/node/node.exe, vendor/npm/, node_modules/<生产依赖>}
#
# 用法：bash dsh-tauri/scripts/stage-payload.sh   （在仓库任意位置均可）
# 幂等：重复执行全量镜像（robocopy /MIR），改动后重跑即可。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$REPO_ROOT/dsh-desktop"
DST="$REPO_ROOT/dsh-tauri/package-payload/dsh-desktop"

echo "[stage] 源: $SRC"
echo "[stage] 目标: $DST"

# 前置校验：缺任何一项，装出来的包必然起不来（fail-fast 优于装完才发现）。
for f in package.json vendor/node/node.exe \
         node_modules/@deepseek-ai/dsh/lib/bin.js \
         scripts/lib/companion-profile.js assets/plugins; do
  if [ ! -e "$SRC/$f" ]; then
    echo "[stage] 缺少运行时必需件: dsh-desktop/$f —— 先在 dsh-desktop/ npm install" >&2
    exit 1
  fi
done

mkdir -p "$DST/vendor/node" "$DST/node_modules"

# robocopy 退出码 0-7 全部是成功（1=有复制 2=有额外 3=1+2 …），≥8 才是失败。
# 注：Git Bash 下 flag 需写 //MIR 形式（MSYS 会把 /MIR 当路径转换）。
rc() { # rc <src> <dst> [额外参数...]
  local out
  set +e; robocopy "$1" "$2" "${@:3}" > /dev/null; out=$?; set -e
  if [ "$out" -ge 8 ]; then echo "[stage] robocopy 失败 ($out): $1" >&2; exit "$out"; fi
}

# ---- 根文件：全部根级 *.js + package.json（对齐 electron-builder files 白名单
#      形态；scripts/integration 等经 require('../../profile-manifest') 直引根级
#      脚本——缺一件 boot 链即断，实测曾漏 profile-manifest.js 导致安装包首启
#      全灭）。package-lock.json 不带（payload 不做 npm install）。----
rc "$SRC" "$DST" '*.js' package.json

# ---- scripts / assets：全量镜像 ----
rc "$SRC/scripts" "$DST/scripts" //MIR //R:2 //W:1
rc "$SRC/assets"  "$DST/assets"  //MIR //R:2 //W:1

# ---- vendor：node.exe（win）+ npm 全量（插件安装/更新链用到）----
cp -f "$SRC/vendor/node/node.exe" "$DST/vendor/node/node.exe"
rc "$SRC/vendor/npm" "$DST/vendor/npm" //MIR //R:2 //W:1

# ---- node_modules：生产依赖全量（排除 devDeps 三件；/XD 按目录名精确匹配，
#      electron-to-chromium 等兄弟名不受影响）----
rc "$SRC/node_modules" "$DST/node_modules" //MIR //R:2 //W:1 \
   //XD electron electron-builder electron-winstaller

# ---- rc7 客户端包 vendor（用户实测「插件全灭+侧边栏消失」的根因）----
# 机制：rc8 内核把 client-web 系溶入 minified dist（kernel 自身 OK），但伴随
# 插件 client.js 仍 require("@deepseek-ai/dsh-client-web-react" /
# "dsh-client-ui-primitives")——client-modules loader 找不到 module table 种子
# 时走 package factory 路径，需要真实包在 node_modules。Electron 0.4.1 正是
# 带着 rc7 残留包发版才正常（实测 dev 检出/payload 缺它们 → 全部插件加载
# 失败）。源：本机 0.4.1 构建产物 node_modules（与发版字节一致的已验证闭包），
# 补齐其中 payload 缺失的所有顶层包（闭包自维护，无需手工枚举传递依赖）。
VENDOR_SRC="$REPO_ROOT/dsh-desktop/dist/win-unpacked/resources/app/node_modules"
if [ -d "$VENDOR_SRC" ]; then
  vendored=0
  for d in "$VENDOR_SRC"/*/ "$VENDOR_SRC"/@*/*/; do
    [ -d "$d" ] || continue
    base="$(basename "$d")"
    parent="$(basename "$(dirname "$d")")"
    if [ "$parent" = node_modules ]; then rel="$base"; else rel="$parent/$base"; fi
    case "$rel" in .bin|*.json) continue ;; esac
    if [ ! -d "$DST/node_modules/$rel" ]; then
      # robocopy 成功码为 1-7（≠0），set -e 下裸调会被误杀——同 rc() 护栏。
      set +e
      robocopy "$d" "$DST/node_modules/$rel" //MIR //R:1 //W:1 > /dev/null
      rcv=$?
      set -e
      [ $rcv -lt 8 ] || { echo "[stage] vendor 失败($rcv): $rel" >&2; exit 1; }
      vendored=$((vendored+1))
    fi
  done
  echo "[stage] vendor rc7 客户端闭包：补 $vendored 个缺失包（源 = 0.4.1 构建产物）"
else
  echo "[stage] ⚠ 缺 0.4.1 构建产物（$VENDOR_SRC）——插件客户端包将缺失，页面插件会加载失败！" >&2
  echo "[stage]   请先在 dsh-desktop 构建过 0.4.1（或恢复 dist/win-unpacked）。" >&2
  exit 1
fi

echo "[stage] 完成。体积统计："
du -sm "$DST" "$DST/node_modules" "$DST/vendor" "$DST/assets" 2>/dev/null
