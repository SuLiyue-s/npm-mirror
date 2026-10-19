// Windows 原生工具：消息框、ShellExecute、进程探活/结束、窗口查找与激活、路径比较。
use std::path::{Path, PathBuf};

use windows::core::{HSTRING, PWSTR};
pub use windows::Win32::Foundation::HWND;
use windows::Win32::Foundation::{CloseHandle, LPARAM};
use windows::Win32::System::Threading::{
  GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
  PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
  EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, MessageBoxW, SetForegroundWindow,
  ShowWindow, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MESSAGEBOX_STYLE, SW_RESTORE, SW_SHOW,
  SW_SHOWNORMAL,
};

/// 创建进程时隐藏控制台窗口的标志（CREATE_NO_WINDOW）
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// STILL_ACTIVE 退出码
const STILL_ACTIVE_CODE: u32 = 259;

pub fn message_box(text: impl AsRef<str>, title: impl AsRef<str>, error: bool) {
  let text = HSTRING::from(text.as_ref());
  let title = HSTRING::from(title.as_ref());
  let style = if error {
    MESSAGEBOX_STYLE(MB_OK.0 | MB_ICONERROR.0 | MB_SETFOREGROUND.0)
  } else {
    MESSAGEBOX_STYLE(MB_OK.0 | MB_SETFOREGROUND.0)
  };
  unsafe {
    // 有主窗口时挂到主窗口上，消息框居中于窗口而不是屏幕
    MessageBoxW(current_process_main_window(), &text, &title, style);
  }
}

/// 用系统默认程序打开 URL / 文件 / 目录（ShellExecuteW "open"）。
pub fn open_path(target: &str) -> bool {
  let verb = HSTRING::from("open");
  let file = HSTRING::from(target);
  let empty = HSTRING::new();
  unsafe {
    let result = ShellExecuteW(None, &verb, &file, &empty, &empty, SW_SHOWNORMAL);
    result.0 as isize > 32
  }
}

/// 进程是否仍在运行（打开进程 + 读取退出码）。
pub fn process_alive(pid: u32) -> bool {
  if pid == 0 {
    return false;
  }
  unsafe {
    match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
      Ok(handle) => {
        let mut code = 0u32;
        let read = GetExitCodeProcess(handle, &mut code);
        let _ = CloseHandle(handle);
        read.is_ok() && code == STILL_ACTIVE_CODE
      }
      Err(_) => false,
    }
  }
}

/// 取得某个进程的可执行文件完整路径。
pub fn process_exe_path(pid: u32) -> Option<PathBuf> {
  if pid == 0 {
    return None;
  }
  unsafe {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buffer = [0u16; 2048];
    let mut size = buffer.len() as u32;
    let result = QueryFullProcessImageNameW(
      handle,
      PROCESS_NAME_WIN32,
      PWSTR(buffer.as_mut_ptr()),
      &mut size,
    );
    let _ = CloseHandle(handle);
    if result.is_err() || size == 0 || size as usize > buffer.len() {
      return None;
    }
    Some(PathBuf::from(String::from_utf16_lossy(
      &buffer[..size as usize],
    )))
  }
}

pub fn same_path(a: &Path, b: &Path) -> bool {
  let left = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
  let right = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
  left
    .to_string_lossy()
    .eq_ignore_ascii_case(&right.to_string_lossy())
}

/// 结束进程树（优先 taskkill /T /F，保证 node 的孙进程也一起退出）。
pub fn kill_process_tree(pid: u32) {
  use std::os::windows::process::CommandExt;
  if pid == 0 {
    return;
  }
  let _ = std::process::Command::new("taskkill")
    .args(["/PID", &pid.to_string(), "/T", "/F"])
    .creation_flags(CREATE_NO_WINDOW)
    .output();
}

struct WindowSearch {
  target_pid: u32,
  visible: Option<HWND>,
  hidden: Option<HWND>,
}

unsafe extern "system" fn enum_windows_proc(window: HWND, lparam: LPARAM) -> windows::core::BOOL {
  let search = unsafe { &mut *(lparam.0 as *mut WindowSearch) };
  let mut pid = 0u32;
  unsafe {
    GetWindowThreadProcessId(window, Some(&mut pid));
  }
  if pid != search.target_pid {
    return true.into();
  }
  if unsafe { GetWindowTextLengthW(window) } <= 0 {
    return true.into();
  }
  if unsafe { windows::Win32::UI::WindowsAndMessaging::IsWindowVisible(window) }.as_bool() {
    if search.visible.is_none() {
      search.visible = Some(window);
    }
    return false.into(); // 找到可见主窗口即可停止枚举
  }
  if search.hidden.is_none() {
    search.hidden = Some(window);
  }
  true.into()
}

/// 查找指定进程的顶层窗口（优先可见窗口；隐藏窗口用于把已隐藏的主窗口重新显示）。
fn find_process_main_window(pid: u32) -> Option<HWND> {
  if pid == 0 {
    return None;
  }
  let mut search = WindowSearch {
    target_pid: pid,
    visible: None,
    hidden: None,
  };
  unsafe {
    let _ = EnumWindows(
      Some(enum_windows_proc),
      LPARAM(&mut search as *mut WindowSearch as isize),
    );
  }
  search.visible.or(search.hidden)
}

/// 当前进程的主窗口（用于消息框归属窗口等可选场景）。
pub fn current_process_main_window() -> Option<HWND> {
  find_process_main_window(std::process::id())
}

/// 把窗口显示出来并置前。
pub fn activate_window(window: HWND) {
  unsafe {
    let _ = ShowWindow(window, SW_RESTORE);
    let _ = ShowWindow(window, SW_SHOW);
    let _ = SetForegroundWindow(window);
  }
}

/// 激活已运行的同一程序实例（按可执行文件路径匹配进程）。返回是否找到。
pub fn activate_existing_instance(target_exe: &Path) -> bool {
  let current_pid = std::process::id();
  let mut reader = ProcessReader {
    target_exe,
    current_pid,
    found: None,
  };
  unsafe {
    let _ = EnumWindows(
      Some(enum_windows_for_exe),
      LPARAM(&mut reader as *mut ProcessReader as isize),
    );
  }
  if let Some(window) = reader.found {
    activate_window(window);
    true
  } else {
    false
  }
}

struct ProcessReader<'a> {
  target_exe: &'a Path,
  current_pid: u32,
  found: Option<HWND>,
}

unsafe extern "system" fn enum_windows_for_exe(window: HWND, lparam: LPARAM) -> windows::core::BOOL {
  let reader = unsafe { &mut *(lparam.0 as *mut ProcessReader) };
  let mut pid = 0u32;
  unsafe {
    GetWindowThreadProcessId(window, Some(&mut pid));
  }
  if pid == 0 || pid == reader.current_pid {
    return true.into();
  }
  if unsafe { GetWindowTextLengthW(window) } <= 0 {
    return true.into();
  }
  match process_exe_path(pid) {
    Some(exe) if same_path(&exe, reader.target_exe) => {
      reader.found = Some(window);
      false.into()
    }
    _ => true.into(),
  }
}
