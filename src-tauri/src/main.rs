// release 构建以 Windows 子系统运行，不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn data_dir(app: &tauri::AppHandle) -> PathBuf {
  app.path().app_data_dir().expect("app data dir").join("data")
}

fn safe_id(id: &str) -> Result<&str, String> {
  if id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
    Ok(id)
  } else {
    Err("invalid id".into())
  }
}

fn read_json(path: &Path) -> Option<Value> {
  let text = fs::read_to_string(path).ok()?;
  serde_json::from_str(&text).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
  if let Some(parent) = path.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
  let tmp = path.with_extension("tmp");
  fs::write(&tmp, serde_json::to_string_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
  fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn file_ids(session: &Value) -> Vec<String> {
  let mut ids = Vec::new();
  if let Some(messages) = session.get("messages").and_then(|v| v.as_array()) {
    for m in messages {
      if m.get("role").and_then(|v| v.as_str()) == Some("user") {
        if let Some(files) = m.get("files").and_then(|v| v.as_array()) {
          for f in files {
            if let Some(id) = f.get("id").and_then(|v| v.as_str()) {
              let id = id.to_string();
              if !ids.contains(&id) { ids.push(id); }
            }
          }
        }
      }
    }
  }
  ids
}

fn summary_of(s: &Value) -> Value {
  json!({
    "id": s.get("id").cloned().unwrap_or(Value::Null),
    "title": s.get("title").cloned().unwrap_or(json!("")),
    "createdAt": s.get("createdAt").cloned().unwrap_or(json!(0)),
    "updatedAt": s.get("updatedAt").cloned().unwrap_or(json!(0)),
    "fileIds": file_ids(s),
  })
}

fn read_summaries(dir: &Path) -> Vec<Value> {
  read_json(&dir.join("summaries.json"))
    .and_then(|v| v.as_array().cloned())
    .unwrap_or_default()
}

fn rebuild_summaries(dir: &Path) -> Vec<Value> {
  let mut out = Vec::new();
  if let Ok(entries) = fs::read_dir(dir.join("sessions")) {
    for e in entries.flatten() {
      let path = e.path();
      if path.extension().and_then(|s| s.to_str()) != Some("json") { continue; }
      if let Some(session) = read_json(&path) { out.push(summary_of(&session)); }
    }
  }
  let _ = write_json(&dir.join("summaries.json"), &Value::Array(out.clone()));
  out
}

fn init(dir: &Path) {
  for sub in ["sessions", "files", "staging/sessions", "staging/files"] {
    let _ = fs::create_dir_all(dir.join(sub));
  }
  if !dir.join("summaries.json").exists() { rebuild_summaries(dir); }
}

fn resp(status: u16, body: Value) -> Value {
  json!({ "status": status, "body": body })
}

/// 前端注入的存储请求入口，语义与 server /api 一致。
#[tauri::command]
fn storage_request(app: tauri::AppHandle, method: String, path: String, body: Option<String>, content_type: Option<String>) -> Result<Value, String> {
  let dir = data_dir(&app);
  init(&dir);
  let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
  let parse_body = || -> Value { body.as_deref().and_then(|b| serde_json::from_str(b).ok()).unwrap_or(Value::Null) };

  // settings
  if path == "/settings" {
    if method == "GET" { return Ok(resp(200, read_json(&dir.join("settings.json")).unwrap_or(json!({})))); }
    if method == "PUT" { write_json(&dir.join("settings.json"), &parse_body())?; return Ok(resp(200, json!({"ok": true}))); }
  }

  // sessions
  if path == "/sessions" && method == "GET" {
    let summaries = read_summaries(&dir);
    let public: Vec<Value> = summaries.iter().map(|s| json!({
      "id": s.get("id"), "title": s.get("title"), "createdAt": s.get("createdAt"), "updatedAt": s.get("updatedAt")
    })).collect();
    return Ok(resp(200, Value::Array(public)));
  }
  if parts.first() == Some(&"sessions") && parts.len() == 2 {
    let id = safe_id(parts[1])?;
    let file = dir.join("sessions").join(format!("{}.json", id));
    if method == "GET" {
      return Ok(match read_json(&file) { Some(v) => resp(200, v), None => resp(404, json!({"error": "not found"})) });
    }
    if method == "PUT" {
      let session = parse_body();
      write_json(&file, &session)?;
      let mut sums = read_summaries(&dir);
      sums.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id));
      sums.push(summary_of(&session));
      write_json(&dir.join("summaries.json"), &Value::Array(sums))?;
      return Ok(resp(200, json!({"ok": true})));
    }
    if method == "DELETE" {
      let _ = fs::remove_file(&file);
      let mut sums = read_summaries(&dir);
      sums.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id));
      write_json(&dir.join("summaries.json"), &Value::Array(sums))?;
      return Ok(resp(200, json!({"ok": true})));
    }
  }
  if parts.first() == Some(&"sessions") && parts.len() == 3 && parts[2] == "title" && method == "PATCH" {
    let id = safe_id(parts[1])?;
    let file = dir.join("sessions").join(format!("{}.json", id));
    if let Some(mut session) = read_json(&file) {
      let title = parse_body().get("title").cloned().unwrap_or(json!(""));
      session["title"] = title.clone();
      write_json(&file, &session)?;
      let mut sums = read_summaries(&dir);
      for s in &mut sums { if s.get("id").and_then(|v| v.as_str()) == Some(id) { s["title"] = title.clone(); } }
      write_json(&dir.join("summaries.json"), &Value::Array(sums))?;
    }
    return Ok(resp(200, json!({"ok": true})));
  }

  // session with files (base64)
  if path == "/session-with-files" && method == "POST" {
    let payload = parse_body();
    if let Some(files) = payload.get("files").and_then(|v| v.as_array()) {
      for f in files {
        if let (Some(id), Some(b64)) = (f.get("id").and_then(|v| v.as_str()), f.get("base64").and_then(|v| v.as_str())) {
          let id = safe_id(id)?;
          let bytes = base64_decode(b64)?;
          fs::write(dir.join("files").join(id), bytes).map_err(|e| e.to_string())?;
          let meta = json!({"contentType": f.get("contentType").and_then(|v| v.as_str()).unwrap_or("application/octet-stream")});
          write_json(&dir.join("files").join(format!("{}.meta.json", id)), &meta)?;
        }
      }
    }
    if let Some(session) = payload.get("session") {
      let sid = session.get("id").and_then(|v| v.as_str()).unwrap_or("");
      let id = safe_id(sid)?;
      write_json(&dir.join("sessions").join(format!("{}.json", id)), session)?;
      let mut sums = read_summaries(&dir);
      sums.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id));
      sums.push(summary_of(session));
      write_json(&dir.join("summaries.json"), &Value::Array(sums))?;
    }
    return Ok(resp(200, json!({"ok": true})));
  }

  // files
  if parts.first() == Some(&"files") && parts.len() == 2 {
    let id = safe_id(parts[1])?;
    let file = dir.join("files").join(id);
    if method == "GET" {
      return Ok(match fs::read(&file) {
        Ok(bytes) => {
          let meta = read_json(&dir.join("files").join(format!("{}.meta.json", id)));
          let ct = meta.and_then(|m| m.get("contentType").and_then(|v| v.as_str()).map(|s| s.to_string())).unwrap_or_else(|| "application/octet-stream".into());
          resp(200, json!({"base64": base64_encode(&bytes), "contentType": ct}))
        }
        Err(_) => resp(404, json!({"error": "not found"})),
      });
    }
    if method == "PUT" {
      let bytes = body.as_deref().map(|b| b.as_bytes().to_vec()).unwrap_or_default();
      fs::write(&file, bytes).map_err(|e| e.to_string())?;
      write_json(&dir.join("files").join(format!("{}.meta.json", id)), &json!({"contentType": content_type.unwrap_or_else(|| "application/octet-stream".into())}))?;
      return Ok(resp(200, json!({"ok": true})));
    }
  }

  // staging
  if path == "/staging/clear" && method == "POST" {
    for sub in ["staging/sessions", "staging/files"] {
      let p = dir.join(sub);
      let _ = fs::remove_dir_all(&p);
      let _ = fs::create_dir_all(&p);
    }
    return Ok(resp(200, json!({"ok": true})));
  }
  if parts.first() == Some(&"staging") && parts.get(1) == Some(&"sessions") && parts.len() == 3 && method == "PUT" {
    let id = safe_id(parts[2])?;
    write_json(&dir.join("staging/sessions").join(format!("{}.json", id)), &parse_body())?;
    return Ok(resp(200, json!({"ok": true})));
  }
  if parts.first() == Some(&"staging") && parts.get(1) == Some(&"files") && parts.len() == 3 && method == "PUT" {
    let id = safe_id(parts[2])?;
    let bytes = body.as_deref().map(|b| b.as_bytes().to_vec()).unwrap_or_default();
    fs::write(dir.join("staging/files").join(id), bytes).map_err(|e| e.to_string())?;
    return Ok(resp(200, json!({"ok": true})));
  }
  if path == "/staging/file-types" && method == "POST" {
    // 图片 MIME 回填：暂不修改会话 JSON（导入的图片内容本身已带类型，界面展示不受影响）
    return Ok(resp(200, json!({"ok": true})));
  }
  if path == "/staging/commit" && method == "POST" {
    let live = dir.join("sessions");
    let staged = dir.join("staging/sessions");
    let _ = fs::remove_dir_all(&live);
    let _ = fs::rename(&staged, &live);
    let _ = fs::create_dir_all(&staged);
    let files_live = dir.join("files");
    let files_staged = dir.join("staging/files");
    let _ = fs::remove_dir_all(&files_live);
    let _ = fs::rename(&files_staged, &files_live);
    let _ = fs::create_dir_all(&files_staged);
    let summaries = rebuild_summaries(&dir);
    let public: Vec<Value> = summaries.iter().map(|s| json!({
      "id": s.get("id"), "title": s.get("title"), "createdAt": s.get("createdAt"), "updatedAt": s.get("updatedAt")
    })).collect();
    return Ok(resp(200, Value::Array(public)));
  }

  // clear history
  if path == "/history/clear" && method == "POST" {
    let _ = fs::remove_dir_all(dir.join("sessions"));
    let _ = fs::remove_dir_all(dir.join("files"));
    let _ = fs::create_dir_all(dir.join("sessions"));
    let _ = fs::create_dir_all(dir.join("files"));
    write_json(&dir.join("summaries.json"), &json!([]))?;
    return Ok(resp(200, json!({"ok": true})));
  }

  Ok(resp(404, json!({"error": "unknown endpoint", "path": path})))
}

fn base64_encode(data: &[u8]) -> String {
  const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
  for chunk in data.chunks(3) {
    let b0 = chunk[0] as u32;
    let b1 = *chunk.get(1).unwrap_or(&0) as u32;
    let b2 = *chunk.get(2).unwrap_or(&0) as u32;
    let n = (b0 << 16) | (b1 << 8) | b2;
    out.push(TABLE[((n >> 18) & 63) as usize] as char);
    out.push(TABLE[((n >> 12) & 63) as usize] as char);
    out.push(if chunk.len() > 1 { TABLE[((n >> 6) & 63) as usize] as char } else { '=' });
    out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
  }
  out
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
  fn val(c: u8) -> Option<u8> {
    match c {
      b'A'..=b'Z' => Some(c - b'A'),
      b'a'..=b'z' => Some(c - b'a' + 26),
      b'0'..=b'9' => Some(c - b'0' + 52),
      b'+' => Some(62),
      b'/' => Some(63),
      _ => None,
    }
  }
  let bytes: Vec<u8> = s.bytes().filter(|b| *b != b'=').collect();
  let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
  for chunk in bytes.chunks(4) {
    if chunk.len() < 2 { break; }
    let mut n: u32 = 0;
    for b in chunk { n = (n << 6) | val(*b).ok_or("invalid base64")? as u32; }
    let shift = (4 - chunk.len()) * 2;
    out.push((n >> (16 - shift)) as u8);
    if chunk.len() > 2 { out.push((n >> (8 - shift)) as u8); }
    if chunk.len() > 3 { out.push((n >> shift) as u8); }
  }
  Ok(out)
}


/// WebView2 运行时官网下载地址。
const WEBVIEW2_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// 读取注册表判断 WebView2 运行时是否已安装且版本有效。
/// 与 Edge 自身的检测逻辑一致：任一处 Client 键下的 pv 值存在即视为可用。
#[cfg(windows)]
fn webview2_available() -> bool {
  use std::ffi::OsStr;
  use std::os::windows::ffi::OsStrExt;
  use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
    KEY_READ,
  };

  // WebView2 可能按机器、按用户或 32/64 位分别注册。
  const KEYS: [(&str, HKEY); 4] = [
    (
      r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
      HKEY_LOCAL_MACHINE,
    ),
    (
      r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
      HKEY_LOCAL_MACHINE,
    ),
    (
      r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
      HKEY_CURRENT_USER,
    ),
    (
      r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
      HKEY_CURRENT_USER,
    ),
  ];

  let wide = |s: &str| -> Vec<u16> { OsStr::new(s).encode_wide().chain(Some(0)).collect() };

  for (key_path, root) in KEYS {
    let subkey = wide(key_path);
    let mut handle: HKEY = 0;
    if unsafe { RegOpenKeyExW(root, subkey.as_ptr(), 0, KEY_READ, &mut handle) } != 0 {
      continue;
    }
    let value_name = wide("pv");
    let mut kind: u32 = 0;
    let mut size: u32 = 0;
    // 先查长度
    let rc = unsafe {
      RegQueryValueExW(
        handle,
        value_name.as_ptr(),
        std::ptr::null_mut(),
        &mut kind,
        std::ptr::null_mut(),
        &mut size,
      )
    };
    let found = rc == 0 && size > 0;
    unsafe { RegCloseKey(handle) };
    if found {
      return true;
    }
  }
  false
}

#[cfg(not(windows))]
fn webview2_available() -> bool {
  true
}

/// 弹出阻断式提示并引导安装 WebView2，返回是否继续启动。
#[cfg(windows)]
fn ensure_webview2() -> bool {
  use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, MB_ICONERROR, MB_YESNO, IDYES,
  };

  if webview2_available() {
    return true;
  }

  let text = "本程序基于 WebView2 支持库启动。\n\n当前系统 WebView2 运行时缺失或损坏，程序无法显示界面。\n\n点击「是」打开官方下载页面，安装完成后重新运行本程序。";
  let caption = "缺少 WebView2 运行时";

  let to_wide = |s: &str| -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
  };

  let result = unsafe {
    MessageBoxW(
      0,
      to_wide(text).as_ptr(),
      to_wide(caption).as_ptr(),
      MB_YESNO | MB_ICONERROR,
    )
  };

  if result == IDYES {
    // 用默认浏览器打开官网；失败也不阻塞退出。
    let _ = std::process::Command::new("cmd")
      .args(["/C", "start", "", WEBVIEW2_URL])
      .spawn();
  }
  false
}

#[cfg(not(windows))]
fn ensure_webview2() -> bool {
  true
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  if !ensure_webview2() {
    std::process::exit(1);
  }
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![storage_request])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn main() { run(); }
