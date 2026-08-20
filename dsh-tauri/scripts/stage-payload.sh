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

echo "[stage] 完成。体积统计："
du -sm "$DST" "$DST/node_modules" "$DST/vendor" "$DST/assets" 2>/dev/null
