// 开机自启：写 HKCU\Software\Microsoft\Windows\CurrentVersion\Run。
// 值内容为 "<exe 绝对路径>" --autostart，--autostart 启动时窗口默认隐藏。
use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE};
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "LiYueNpmMirror";

fn run_key() -> Result<RegKey, String> {
  RegKey::predef(HKEY_CURRENT_USER)
    .open_subkey_with_flags(RUN_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)
    .map_err(|e| format!("打开注册表 Run 键失败：{e}"))
}

/// 期望写入的自启命令行（含引号，兼容带空格的路径）。
pub fn expected_command() -> String {
  format!("\"{}\" --autostart", crate::paths::exe_path().display())
}

/// 当前注册表中的自启命令（不存在返回 None）。
pub fn current_command() -> Option<String> {
  let key = run_key().ok()?;
  key.get_value::<String, _>(VALUE_NAME)
    .ok()
    .filter(|value| !value.trim().is_empty())
}

pub fn is_enabled() -> bool {
  current_command().is_some()
}

/// 开启/关闭开机自启，返回实际状态。
pub fn set_enabled(enabled: bool) -> Result<bool, String> {
  let key = run_key()?;
  if enabled {
    let command = expected_command();
    key
      .set_value(VALUE_NAME, &command)
      .map_err(|e| format!("写入注册表自启项失败：{e}"))?;
  } else if key.get_value::<String, _>(VALUE_NAME).is_ok() {
    key
      .delete_value(VALUE_NAME)
      .map_err(|e| format!("删除注册表自启项失败：{e}"))?;
  }
  Ok(is_enabled())
}

/// 自启项是否指向当前 exe（用于提示用户旧路径残留）。
pub fn matches_current_exe() -> bool {
  current_command()
    .map(|command| {
      let expected = expected_command();
      command.trim().eq_ignore_ascii_case(expected.trim())
    })
    .unwrap_or(false)
}
