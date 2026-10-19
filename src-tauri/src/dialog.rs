// 原生文件/目录选择对话框：IFileOpenDialog（FOS_PICKFOLDERS / FOS_FILEMUSTEXIST）。
// 对话框必须在 COM STA 线程打开，因此统一放到独立线程执行并 join 等待结果。
use std::ffi::c_void;
use std::path::PathBuf;

use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
  CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, CLSCTX_ALL,
  COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows::Win32::UI::Shell::{
  FileOpenDialog, IFileDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName,
  FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
  FILEOPENDIALOGOPTIONS,
};

/// 用户取消对话框时 COM 返回的 HRESULT：0x800704C7（ERROR_CANCELLED）
const HRESULT_CANCELLED: i32 = 0x8007_04C7u32 as i32;

pub enum DialogOutcome {
  Picked(PathBuf),
  Canceled,
  Failed(String),
}

/// 打开"选择文件夹"对话框。
pub fn pick_folder(owner: Option<HWND>, title: &str, initial_dir: Option<&str>) -> DialogOutcome {
  run_dialog(
    owner,
    title.to_string(),
    initial_dir.map(|dir| dir.to_string()),
    true,
    Vec::new(),
  )
}

/// 打开"选择文件"对话框（用于导入离线包）。filters 形如 [("离线包", "*.tgz;*.gz")]。
pub fn pick_file(
  owner: Option<HWND>,
  title: &str,
  initial_dir: Option<&str>,
  filters: Vec<(String, String)>,
) -> DialogOutcome {
  run_dialog(
    owner,
    title.to_string(),
    initial_dir.map(|dir| dir.to_string()),
    false,
    filters,
  )
}

fn run_dialog(
  owner: Option<HWND>,
  title: String,
  initial_dir: Option<String>,
  folder: bool,
  filters: Vec<(String, String)>,
) -> DialogOutcome {
  // HWND 含裸指针不能 Send，转成 isize 传给对话框线程。
  let owner_raw = owner.map(|window| window.0 as isize);
  std::thread::spawn(move || unsafe {
    let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    if init.is_err() {
      return DialogOutcome::Failed(format!("初始化 COM 失败：{}", init.message()));
    }
    let outcome = show_dialog(owner_raw, &title, initial_dir.as_deref(), folder, &filters);
    CoUninitialize();
    outcome
  })
  .join()
  .unwrap_or_else(|_| DialogOutcome::Failed("文件选择对话框线程异常退出".into()))
}

unsafe fn show_dialog(
  owner_raw: Option<isize>,
  title: &str,
  initial_dir: Option<&str>,
  folder: bool,
  filters: &[(String, String)],
) -> DialogOutcome {
  let dialog: IFileOpenDialog = match unsafe {
    CoCreateInstance(
      &FileOpenDialog,
      None::<&windows::core::IUnknown>,
      CLSCTX_ALL,
    )
  } {
    Ok(dialog) => dialog,
    Err(err) => return DialogOutcome::Failed(format!("创建系统文件对话框失败：{err}")),
  };
  let file_dialog: IFileDialog = match dialog.cast() {
    Ok(dialog) => dialog,
    Err(err) => return DialogOutcome::Failed(format!("获取文件对话框接口失败：{err}")),
  };

  // 组合选项：必须是文件系统路径；目录模式选择文件夹，文件模式要求文件存在。
  let mut options = match unsafe { file_dialog.GetOptions() } {
    Ok(options) => options,
    Err(err) => return DialogOutcome::Failed(format!("读取对话框选项失败：{err}")),
  };
  options = FILEOPENDIALOGOPTIONS(options.0 | FOS_FORCEFILESYSTEM.0 | FOS_PATHMUSTEXIST.0);
  if folder {
    options = FILEOPENDIALOGOPTIONS(options.0 | FOS_PICKFOLDERS.0);
  } else {
    options = FILEOPENDIALOGOPTIONS(options.0 | FOS_FILEMUSTEXIST.0);
  }
  let _ = unsafe { file_dialog.SetOptions(options) };

  let title_buffer = HSTRING::from(title);
  if !title.trim().is_empty() {
    let _ = unsafe { file_dialog.SetTitle(&title_buffer) };
  }

  if let Some(dir) = initial_dir {
    let dir_buffer = HSTRING::from(dir);
    if let Ok(item) = unsafe {
      SHCreateItemFromParsingName::<_, _, IShellItem>(&dir_buffer, None::<&IBindCtx>)
    } {
      let _ = unsafe { file_dialog.SetFolder(&item) };
    }
  }

  // 文件类型过滤器：HSTRING 需要比 COMDLG_FILTERSPEC 活得久。
  let mut filter_names: Vec<HSTRING> = Vec::new();
  let mut filter_specs: Vec<HSTRING> = Vec::new();
  let mut specs: Vec<COMDLG_FILTERSPEC> = Vec::new();
  if !folder {
    for (name, spec) in filters {
      filter_names.push(HSTRING::from(name.as_str()));
      filter_specs.push(HSTRING::from(spec.as_str()));
    }
    filter_names.push(HSTRING::from("所有文件"));
    filter_specs.push(HSTRING::from("*.*"));
    for (name, spec) in filter_names.iter().zip(filter_specs.iter()) {
      specs.push(COMDLG_FILTERSPEC {
        pszName: PCWSTR(name.as_ptr()),
        pszSpec: PCWSTR(spec.as_ptr()),
      });
    }
    let _ = unsafe { file_dialog.SetFileTypes(&specs) };
  }

  let owner = owner_raw.map(|raw| HWND(raw as *mut c_void));
  match unsafe { file_dialog.Show(owner) } {
    Ok(()) => {}
    Err(err) => {
      if err.code().0 == HRESULT_CANCELLED {
        return DialogOutcome::Canceled;
      }
      return DialogOutcome::Failed(format!("打开系统对话框失败：{err}"));
    }
  }

  let item = match unsafe { file_dialog.GetResult() } {
    Ok(item) => item,
    Err(err) => return DialogOutcome::Failed(format!("读取对话框选择结果失败：{err}")),
  };
  let name = match unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) } {
    Ok(name) => name,
    Err(err) => return DialogOutcome::Failed(format!("读取所选路径失败：{err}")),
  };
  let path = match unsafe { name.to_string() } {
    Ok(path) => path,
    Err(err) => {
      unsafe { CoTaskMemFree(Some(name.0 as *const c_void)) };
      return DialogOutcome::Failed(format!("转换所选路径失败：{err}"));
    }
  };
  unsafe { CoTaskMemFree(Some(name.0 as *const c_void)) };
  DialogOutcome::Picked(PathBuf::from(path))
}
