//! 垫片 JS 的嵌入与静态自检。
//!
//! `dist/bridge-shim.js` 是 contracts/bridge-api.md 的页面侧实现（48 方法），
//! 编进二进制后由 app 层作为 `initialization_script` 注入每个页面。

/// 垫片 JS 全文。
pub const BRIDGE_SHIM_JS: &str = include_str!("../dist/bridge-shim.js");

/// 垫片必须覆盖的桥方法/命名空间（与 bridge-api.md §2 对齐的完整性锚点）。
#[cfg(test)]
const REQUIRED_SURFACES: &[&str] = &[
    "appVersion",
    "windowControls.minimize",
    "windowControls.toggleMaximize",
    "windowControls.close",
    "windowControls.isMaximized",
    "windowControls.onMaximizeChange",
    "menu.action",
    "getInfo",
    "refreshBalance",
    "onNotificationJump",
    "wsl.getConfig",
    "wsl.saveConfig",
    "wsl.recheck",
    "restartService",
    "revertFiles",
    "openPath",
    "openExternal",
    "copyText",
    "getPathForFile",
    "imagePaste.save",
    "sponsorQr",
    "sponsorWindow",
    "floatWindow.open",
    "floatWindow.close",
    "pluginManager.list",
    "pluginManager.setEnabled",
    "pluginManager.uninstall",
    "pluginManager.restore",
    "pluginManager.checkUpdates",
    "pluginManager.update",
    "diagBackup.runDiagnostics",
    "diagBackup.exportBackup",
    "diagBackup.previewRestore",
    "diagBackup.restore",
    "diagBackup.exportDiagnostics",
    "diagBackup.validatePlugins",
    "diagBackup.removeBundle",
    "diagBackup.analyzeOrder",
    "diagBackup.applyOrder",
    "petWindow.open",
    "petWindow.toggle",
    "petWindow.isOpen",
    "petWindow.close",
    "petWindow.moveTo",
    "petWindow.setAutoOpen",
    "recovery.getState",
    "recovery.reload",
    "recovery.restart",
    "recovery.openLogs",
];

/// 垫片源码是否包含某方法名的定义（形如 `name: function` / `name,`）。
#[cfg(test)]
fn defines(surface: &str) -> bool {
    if let Some((ns, method)) = surface.split_once('.') {
        // 命名空间块存在 + 块内方法定义存在（简化为全文出现 `method:`，容差可接受：
        // REQUIRED_SURFACES 是锚点不是解析器）。
        BRIDGE_SHIM_JS.contains(ns)
            && BRIDGE_SHIM_JS.contains(&format!("{method}:"))
    } else {
        BRIDGE_SHIM_JS.contains(&format!("{surface}:")) || BRIDGE_SHIM_JS.contains(&format!("{surface},"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_nonempty_and_idempotent_guard() {
        assert!(BRIDGE_SHIM_JS.len() > 4000, "垫片意外地短——疑似被截断");
        assert!(BRIDGE_SHIM_JS.contains("if (window.dshDesktop) return;"), "必须幂等");
        assert!(BRIDGE_SHIM_JS.contains("'use strict'"));
    }

    #[test]
    fn all_48_surfaces_present() {
        let missing: Vec<&str> = REQUIRED_SURFACES.iter().copied().filter(|s| !defines(s)).collect();
        assert!(missing.is_empty(), "垫片缺失契约方法: {missing:?}");
        assert_eq!(REQUIRED_SURFACES.len(), 49, "契约方法计数（48+recovery.openLogs）");
    }

    #[test]
    fn cut_feature_guard_present() {
        assert!(BRIDGE_SHIM_JS.contains("check-agent-update"), "裁撤的内核更新菜单项需保留方法位");
        assert!(BRIDGE_SHIM_JS.contains("E_CUT_FEATURE"));
    }

    #[test]
    fn event_names_align_contract() {
        for ev in ["window-maximized", "notification-jump", "balance-changed", "pet-state"] {
            assert!(BRIDGE_SHIM_JS.contains(ev), "事件 {ev} 缺失");
        }
        for js_ev in ["dsh-balance-changed", "dsh-pet-state"] {
            assert!(BRIDGE_SHIM_JS.contains(js_ev), "页面 CustomEvent {js_ev} 缺失");
        }
    }

    #[test]
    fn upstream_channels_align_bridge_crate() {
        // 垫片 invoke 的 command 名必须全部在 bridge::commands 表内（未注册的会运行时失败）。
        let mut invoked: Vec<&str> = Vec::new();
        let mut rest = BRIDGE_SHIM_JS;
        while let Some(pos) = rest.find("call('") {
            rest = &rest[pos + 6..];
            if let Some(end) = rest.find('\'') {
                invoked.push(&rest[..end]);
                rest = &rest[end..];
            } else {
                break;
            }
        }
        // send() 族的四个 fire-and-forget。
        let mut rest = BRIDGE_SHIM_JS;
        while let Some(pos) = rest.find("send('") {
            rest = &rest[pos + 6..];
            if let Some(end) = rest.find('\'') {
                invoked.push(&rest[..end]);
                rest = &rest[end..];
            } else {
                break;
            }
        }
        assert!(!invoked.is_empty(), "未提取到任何 invoke");
        for cmd in invoked {
            assert!(
                crate::commands::CHANNELS.iter().any(|c| c.tauri == cmd && !c.cut),
                "垫片调用的 command {cmd} 不在映射表（或已被裁撤）"
            );
        }
    }
}

#[cfg(test)]
mod dialog_polyfill_tests {
    use super::BRIDGE_SHIM_JS;

    /// WebView2 不弹原生 dialog（用户实测 bug 的次因）：垫片必须 polyfill。
    #[test]
    fn native_dialog_polyfill_present() {
        assert!(BRIDGE_SHIM_JS.contains("window.confirm = function () { return true; }"), "confirm 必须放行（删除确认不再恒取消）");
        assert!(BRIDGE_SHIM_JS.contains("window.alert = function (msg)"), "alert 转桥上报（消息不丢）");
        assert!(BRIDGE_SHIM_JS.contains("window.prompt = function () { return null; }"), "prompt 防御性兜底");
        assert!(BRIDGE_SHIM_JS.contains("__dshDialogPolyfilled"), "幂等守卫");
    }
}
