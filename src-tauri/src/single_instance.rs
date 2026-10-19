// 单实例：CreateMutexW 命名互斥体；第二个实例激活已有窗口后直接退出。
use std::sync::OnceLock;

use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
use windows::Win32::System::Threading::CreateMutexW;

/// 互斥体句柄以 isize 保存，进程存活期间一直持有（进程退出由系统释放）。
static MUTEX_HANDLE: OnceLock<isize> = OnceLock::new();

pub enum InstanceCheck {
  /// 当前进程是第一个实例
  First,
  /// 已经有一个实例在运行
  AlreadyRunning,
}

pub fn acquire() -> InstanceCheck {
  unsafe {
    let name = HSTRING::from("Local\\LiYueNpmMirrorDesktop");
    match CreateMutexW(None, true, &name) {
      Ok(handle) => {
        if GetLastError() == ERROR_ALREADY_EXISTS {
          let _ = CloseHandle(handle);
          InstanceCheck::AlreadyRunning
        } else {
          let _ = MUTEX_HANDLE.set(handle.0 as isize);
          InstanceCheck::First
        }
      }
      Err(err) => {
        // 创建互斥体失败时不阻止程序启动（例如极端权限环境），退化为允许多开。
        crate::logging::warn(format!("创建单实例互斥体失败（不阻止启动）：{err}"));
        InstanceCheck::First
      }
    }
  }
}

/// 唤醒已运行的实例窗口。返回是否成功找到并激活。
pub fn activate_existing() -> bool {
  crate::winutil::activate_existing_instance(&crate::paths::exe_path())
}
