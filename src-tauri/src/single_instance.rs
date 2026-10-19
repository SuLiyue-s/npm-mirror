// 单实例：CreateMutexW 命名互斥体；第二个实例「等待-接管」旧实例（重启场景）或激活旧窗口后退出。
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use windows::core::HSTRING;
use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
use windows::Win32::System::Threading::CreateMutexW;

/// 互斥体句柄以 isize 保存，进程存活期间一直持有（进程退出由系统释放）。
static MUTEX_HANDLE: OnceLock<isize> = OnceLock::new();

/// 拿到互斥体（可继续启动）的最长等待时间。
pub const TAKE_OVER_MAX_WAIT: Duration = Duration::from_secs(15);
/// 等待期间尝试 acquire 的间隔。
const TAKE_OVER_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// 等待期间尝试唤醒旧实例窗口的间隔。
const ACTIVATE_INTERVAL: Duration = Duration::from_millis(1500);
/// 成功唤醒旧窗口后的宽限期：旧实例可能正在退出（窗口还在、进程即将结束），
/// 需要继续轮询互斥体，避免新实例误判「旧实例健康」而退出。
const ACTIVATE_GRACE_PERIOD: Duration = Duration::from_millis(2800);

pub enum InstanceCheck {
  /// 当前进程是第一个实例
  First,
  /// 已经有一个实例在运行
  AlreadyRunning,
}

/// 「等待-接管」结果：重启时旧实例可能正在退出，稍等即可拿到互斥体继续启动。
#[derive(Clone, Debug, Default)]
pub struct TakeOver {
  /// 是否成功拿到互斥体（true=可以继续正常启动）
  pub acquired: bool,
  /// 等待期间是否成功唤醒过旧实例
  pub activated: bool,
  /// 等待超时（旧实例一直占用互斥体）
  pub timed_out: bool,
  /// 实际等待毫秒数
  pub waited_ms: u64,
  /// 尝试唤醒旧实例的次数
  pub activation_attempts: u32,
  /// 接管方式：grace=旧实例退出后宽限期内接管；activated=旧实例健康、本实例退出；
  /// timeout=超时后退出；takeover=旧实例已退出、直接接管
  pub mode: Option<&'static str>,
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

/// 发现已有实例后的「等待-接管」策略：
///
/// 1. 每 250ms 重试 acquire 互斥体——旧实例如果是重启/退出中，很快会释放；
/// 2. 每约 1.5s 尝试唤醒旧实例窗口——旧实例健康时用户能看到窗口；
/// 3. 唤醒成功后进入 ~2.8s 宽限期：旧实例可能只是「窗口还在、进程正在退出」，
///    宽限期内若拿到互斥体则接管启动（mode=grace），否则确认旧实例健康、本实例退出（mode=activated）；
/// 4. 最长等待 [`TAKE_OVER_MAX_WAIT`]：超时仍被占用则最后再唤醒一次并退出；
/// 5. 期间一旦拿到互斥体立即返回 acquired=true（mode=takeover 或 grace）。
pub fn wait_and_take_over() -> TakeOver {
  let started = Instant::now();
  let mut result = TakeOver::default();
  let mut next_activate = Instant::now();
  let mut grace_until: Option<Instant> = None;

  loop {
    // 先尝试接管（启动竞态里旧实例可能已经退出）
    if let InstanceCheck::First = acquire() {
      result.acquired = true;
      result.mode = Some(if result.activated { "grace" } else { "takeover" });
      result.waited_ms = started.elapsed().as_millis() as u64;
      if result.activated {
        crate::logging::info(format!(
          "单实例：宽限期内旧实例已释放互斥体，接管启动（takeoverMode=grace，等待 {}ms）",
          result.waited_ms
        ));
      } else {
        crate::logging::info(format!(
          "单实例：旧实例已退出，接管互斥体继续启动（takeoverMode=takeover，等待 {}ms，唤醒尝试 {} 次）",
          result.waited_ms, result.activation_attempts
        ));
      }
      return result;
    }

    let now = Instant::now();

    // 宽限期：已成功唤醒旧窗口，但旧实例可能正在退出，继续轮询互斥体
    if let Some(until) = grace_until {
      if now >= until {
        // 宽限期结束仍未拿到互斥体：旧实例确认健康，最后再唤醒一次后退出
        result.activation_attempts += 1;
        result.activated = activate_existing();
        result.mode = Some("activated");
        result.waited_ms = started.elapsed().as_millis() as u64;
        crate::logging::info(format!(
          "单实例：宽限期结束旧实例仍占用互斥体，确认旧实例健康，本实例退出（takeoverMode=activated，等待 {}ms，唤醒 {} 次）",
          result.waited_ms, result.activation_attempts
        ));
        return result;
      }
      std::thread::sleep(TAKE_OVER_POLL_INTERVAL);
      continue;
    }

    // 正常阶段：定时唤醒旧实例窗口
    if now >= next_activate {
      result.activation_attempts += 1;
      result.activated = activate_existing();
      crate::logging::info(format!(
        "单实例：已有实例占用互斥体，尝试唤醒旧实例窗口（第 {} 次，成功={}）",
        result.activation_attempts, result.activated
      ));
      if result.activated {
        // 不立即退出：进入宽限期继续尝试接管（旧实例可能正在退出）
        grace_until = Some(now + ACTIVATE_GRACE_PERIOD);
        crate::logging::info(format!(
          "单实例：唤醒成功，进入 {}ms 宽限期等待旧实例退出（若旧实例存活则本实例随后退出）",
          ACTIVATE_GRACE_PERIOD.as_millis()
        ));
      } else {
        next_activate = now + ACTIVATE_INTERVAL;
      }
    }

    if started.elapsed() >= TAKE_OVER_MAX_WAIT {
      result.timed_out = true;
      result.activation_attempts += 1;
      result.activated = activate_existing();
      result.mode = Some("timeout");
      result.waited_ms = started.elapsed().as_millis() as u64;
      crate::logging::warn(format!(
        "单实例：等待旧实例释放互斥体超时（{}ms），最后尝试唤醒旧窗口（成功={}）",
        result.waited_ms, result.activated
      ));
      return result;
    }

    std::thread::sleep(TAKE_OVER_POLL_INTERVAL);
  }
}
