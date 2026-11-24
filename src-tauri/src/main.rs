// release 构建以 Windows 子系统运行，不弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

mod code_runner;

/// 进程启动时刻，用于测量到首帧的耗时。
static START: OnceLock<Instant> = OnceLock::new();

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

/// 摘要索引的读改写必须串行；会话正文各自独立写入，不占用这把锁。
static SUMMARIES_LOCK: Mutex<()> = Mutex::new(());
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);
static INIT_CHECKED: OnceLock<()> = OnceLock::new();

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
  let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("data.json");
  // 唯一临时文件：并发保存不会共用同一个 .tmp，避免写坏已落盘的文件。
  let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
  let tmp = path.with_file_name(format!(".{name}.tmp-{}-{seq}", std::process::id()));
  let result = (|| -> Result<(), String> {
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| e.to_string())
  })();
  if result.is_err() {
    let _ = fs::remove_file(&tmp);
  }
  result
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
    "pinned": s.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false),
    "fileIds": file_ids(s),
  })
}

fn read_summaries_file(dir: &Path) -> Option<Vec<Value>> {
  read_json(&dir.join("summaries.json")).and_then(|v| v.as_array().cloned())
}

fn session_ids(dir: &Path) -> Vec<String> {
  let mut ids = Vec::new();
  if let Ok(entries) = fs::read_dir(dir.join("sessions")) {
    for entry in entries.flatten() {
      let path = entry.path();
      if path.extension().and_then(|s| s.to_str()) != Some("json") {
        continue;
      }
      if let Some(id) = path.file_stem().and_then(|s| s.to_str()) {
        ids.push(id.to_string());
      }
    }
  }
  ids
}

fn summaries_consistent(stored: &[Value], ids: &[String]) -> bool {
  let mut stored_ids = Vec::new();
  for summary in stored {
    match summary.get("id").and_then(|v| v.as_str()) {
      Some(id) => stored_ids.push(id.to_string()),
      None => return false,
    }
  }
  stored_ids.sort();
  let mut disk_ids = ids.to_vec();
  disk_ids.sort();
  stored_ids == disk_ids
}

fn rebuild_summaries_unlocked(dir: &Path) -> Vec<Value> {
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

fn rebuild_summaries(dir: &Path) -> Vec<Value> {
  let _guard = SUMMARIES_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  rebuild_summaries_unlocked(dir)
}

fn read_summaries_unlocked(dir: &Path) -> Vec<Value> {
  match read_summaries_file(dir) {
    Some(value) => value,
    // 索引损坏时按会话文件重建，不能把空数组当成真实状态。
    None => rebuild_summaries_unlocked(dir),
  }
}

fn read_summaries(dir: &Path) -> Vec<Value> {
  let _guard = SUMMARIES_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  read_summaries_unlocked(dir)
}

fn update_summaries<F>(dir: &Path, update: F) -> Result<(), String>
where
  F: FnOnce(&mut Vec<Value>) -> Result<(), String>,
{
  let _guard = SUMMARIES_LOCK
    .lock()
    .map_err(|_| "summaries lock poisoned".to_string())?;
  let mut summaries = read_summaries_unlocked(dir);
  update(&mut summaries)?;
  write_json(&dir.join("summaries.json"), &Value::Array(summaries))
}

/// 仅当索引与会话文件不一致时才重建；正常情况下只读目录名和索引 ID。
fn ensure_summaries(dir: &Path) {
  let _guard = SUMMARIES_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let ids = session_ids(dir);
  match read_summaries_file(dir) {
    Some(stored) if summaries_consistent(&stored, &ids) => {}
    _ => {
      let _ = rebuild_summaries_unlocked(dir);
    }
  }
}

fn init(dir: &Path) {
  for sub in ["sessions", "files", "staging/sessions", "staging/files"] {
    let _ = fs::create_dir_all(dir.join(sub));
  }
  INIT_CHECKED.get_or_init(|| ensure_summaries(dir));
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
      "id": s.get("id"), "title": s.get("title"), "createdAt": s.get("createdAt"), "updatedAt": s.get("updatedAt"),
      "pinned": s.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false)
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
      update_summaries(&dir, |sums| {
        sums.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id));
        sums.push(summary_of(&session));
        Ok(())
      })?;
      return Ok(resp(200, json!({"ok": true})));
    }
    if method == "DELETE" {
      let _ = fs::remove_file(&file);
      update_summaries(&dir, |sums| {
        sums.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id));
        Ok(())
      })?;
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
      update_summaries(&dir, |sums| {
        for s in sums {
          if s.get("id").and_then(|v| v.as_str()) == Some(id) {
            s["title"] = title.clone();
          }
        }
        Ok(())
      })?;
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
      update_summaries(&dir, |sums| {
        sums.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id));
        sums.push(summary_of(&session));
        Ok(())
      })?;
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
      // 前端把 Blob 转成 base64 再经 IPC 传过来，这里必须解码后再落盘。
      let bytes = match body.as_deref() {
        Some(text) => base64_decode(text)?,
        None => Vec::new(),
      };
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
    let bytes = match body.as_deref() {
      Some(text) => base64_decode(text)?,
      None => Vec::new(),
    };
    fs::write(dir.join("staging/files").join(id), bytes).map_err(|e| e.to_string())?;
    // commit 会把整个暂存目录换位到 files/，媒体类型跟着原件一起搬运。
    write_json(
      &dir.join("staging/files").join(format!("{}.meta.json", id)),
      &json!({"contentType": content_type.unwrap_or_else(|| "application/octet-stream".into())}),
    )?;
    return Ok(resp(200, json!({"ok": true})));
  }
  if path == "/staging/file-types" && method == "POST" {
    // 图片 MIME 由原件字节推断，导入时回填到暂存会话，三端数据保持一致。
    let types = parse_body();
    if let Ok(entries) = fs::read_dir(dir.join("staging/sessions")) {
      for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
          continue;
        }
        let mut session = match read_json(&path) {
          Some(value) => value,
          None => continue,
        };
        let mut changed = false;
        if let Some(messages) = session.get_mut("messages").and_then(|m| m.as_array_mut()) {
          for message in messages.iter_mut() {
            if message.get("role").and_then(|v| v.as_str()) != Some("user") {
              continue;
            }
            if let Some(files) = message.get_mut("files").and_then(|f| f.as_array_mut()) {
              for file in files.iter_mut() {
                let id = file.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let mime = types.get(&id).and_then(|v| v.as_str()).unwrap_or("").to_string();
                if file.get("mimeType").and_then(|v| v.as_str()).unwrap_or("") != mime {
                  file["mimeType"] = json!(mime);
                  changed = true;
                }
              }
            }
          }
        }
        if changed {
          write_json(&path, &session)?;
        }
      }
    }
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
      "id": s.get("id"), "title": s.get("title"), "createdAt": s.get("createdAt"), "updatedAt": s.get("updatedAt"),
      "pinned": s.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false)
    })).collect();
    return Ok(resp(200, Value::Array(public)));
  }

  // 在资源管理器中打开数据目录
  if path == "/open-data-dir" && method == "POST" {
    let dir = data_dir(&app);
    let _ = fs::create_dir_all(&dir);
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    return Ok(resp(200, json!({"ok": true})));
  }

  // clear history
  if path == "/history/clear" && method == "POST" {
    let _ = fs::remove_dir_all(dir.join("sessions"));
    let _ = fs::remove_dir_all(dir.join("files"));
    let _ = fs::create_dir_all(dir.join("sessions"));
    let _ = fs::create_dir_all(dir.join("files"));
    let _guard = SUMMARIES_LOCK
      .lock()
      .map_err(|_| "summaries lock poisoned".to_string())?;
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

/// 读取系统代理，供 Tauri 的 HTTP 插件显式配置；reqwest 不会自动读取 Windows 的 IE 代理。
#[cfg(windows)]
fn read_reg_string(handle: windows_sys::Win32::System::Registry::HKEY, name: &str) -> Option<String> {
  use std::ffi::OsStr;
  use std::os::windows::ffi::OsStrExt;
  use windows_sys::Win32::System::Registry::{RegQueryValueExW, HKEY};

  let name: Vec<u16> = OsStr::new(name).encode_wide().chain(Some(0)).collect();
  let mut kind: u32 = 0;
  let mut size: u32 = 0;
  let handle: HKEY = handle;
  let rc = unsafe {
    RegQueryValueExW(
      handle,
      name.as_ptr(),
      std::ptr::null_mut(),
      &mut kind,
      std::ptr::null_mut(),
      &mut size,
    )
  };
  if rc != 0 || size == 0 {
    return None;
  }
  let mut buffer = vec![0u16; (size as usize) / 2 + 1];
  let mut read_size = size;
  let rc = unsafe {
    RegQueryValueExW(
      handle,
      name.as_ptr(),
      std::ptr::null_mut(),
      &mut kind,
      buffer.as_mut_ptr().cast::<u8>(),
      &mut read_size,
    )
  };
  if rc != 0 {
    return None;
  }
  let len = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
  Some(String::from_utf16_lossy(&buffer[..len]))
}

#[cfg(windows)]
fn read_reg_dword(handle: windows_sys::Win32::System::Registry::HKEY, name: &str) -> Option<u32> {
  use std::ffi::OsStr;
  use std::os::windows::ffi::OsStrExt;
  use windows_sys::Win32::System::Registry::{RegQueryValueExW, HKEY};

  let name: Vec<u16> = OsStr::new(name).encode_wide().chain(Some(0)).collect();
  let mut kind: u32 = 0;
  let mut value: u32 = 0;
  let mut size: u32 = 4;
  let handle: HKEY = handle;
  let rc = unsafe {
    RegQueryValueExW(
      handle,
      name.as_ptr(),
      std::ptr::null_mut(),
      &mut kind,
      (&mut value as *mut u32).cast::<u8>(),
      &mut size,
    )
  };
  if rc == 0 && kind == 4 {
    Some(value)
  } else {
    None
  }
}

#[cfg(windows)]
fn normalize_proxy(raw: &str) -> Option<String> {
  let mut https = None;
  let mut http = None;
  let mut plain = None;
  for part in raw.split(';') {
    let part = part.trim();
    if part.is_empty() {
      continue;
    }
    if let Some((scheme, address)) = part.split_once('=') {
      if scheme.eq_ignore_ascii_case("https") {
        https = Some(address.trim());
      } else if scheme.eq_ignore_ascii_case("http") {
        http = Some(address.trim());
      }
    } else {
      plain = Some(part);
    }
  }
  let address = https.or(http).or(plain)?.trim();
  if address.is_empty() {
    return None;
  }
  if address.contains("://") {
    Some(address.to_string())
  } else {
    Some(format!("http://{address}"))
  }
}

#[cfg(windows)]
fn system_proxy_value() -> Option<String> {
  use std::ffi::OsStr;
  use std::os::windows::ffi::OsStrExt;
  use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
  };

  let key_path = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
  let subkey: Vec<u16> = OsStr::new(key_path).encode_wide().chain(Some(0)).collect();
  let mut handle: HKEY = 0;
  if unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut handle) } != 0 {
    return None;
  }
  let enabled = read_reg_dword(handle, "ProxyEnable").unwrap_or(0);
  let server = read_reg_string(handle, "ProxyServer");
  unsafe { RegCloseKey(handle) };
  if enabled == 0 {
    return None;
  }
  server.and_then(|raw| normalize_proxy(&raw))
}

/// 返回 Windows 系统代理地址，未启用时返回 null。仅桌面端使用。
#[tauri::command]
fn system_proxy() -> Option<String> {
  #[cfg(windows)]
  {
    system_proxy_value()
  }
  #[cfg(not(windows))]
  {
    None
  }
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

/// 前端首帧渲染完成后回传耗时，写入应用数据目录的 startup.log 供排查。
#[tauri::command]
fn report_startup(app: tauri::AppHandle, nav_ms: f64) -> Result<(), String> {
  let elapsed = START.get().map(|start| start.elapsed().as_millis()).unwrap_or(0);
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  let line = format!("process={}ms page={}ms\n", elapsed, nav_ms);
  use std::io::Write;
  let mut file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(dir.join("startup.log"))
    .map_err(|e| e.to_string())?;
  file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}


/// 更新下载源：镜像优先，直连兜底。GitHub 直连在大陆网络经常被重置，
/// 先用代理镜像能显著提高首次下载成功率；直连仍保留给能直连 GitHub 的用户。
const UPDATE_SOURCES: [(&str, &str); 4] = [
  ("gh-proxy.com", "https://gh-proxy.com/"),
  ("ghproxy.net", "https://ghproxy.net/"),
  ("github", ""),
  ("ghfast.top", "https://ghfast.top/"),
];

/// Tauri updater 使用的目标平台标识；桌面端只发布 Windows x64。
const UPDATE_TARGET: &str = "windows-x86_64";

/// 安装进度：attempt 表示当前尝试的源，percent 为 None 时表示总大小未知。
#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data")]
enum UpdateEvent {
  #[serde(rename = "attempt")]
  Attempt { attempt: u32, total: u32, source: String },
  #[serde(rename = "progress")]
  Progress { percent: Option<u8> },
}

/// 记录更新过程，写入应用数据目录的 updater.log，便于用户反馈失败原因。
fn log_update(app: &tauri::AppHandle, line: &str) {
  let Ok(dir) = app.path().app_data_dir() else {
    return;
  };
  let _ = fs::create_dir_all(&dir);
  let seconds = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|elapsed| elapsed.as_secs())
    .unwrap_or(0);
  use std::io::Write;
  if let Ok(mut file) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(dir.join("updater.log"))
  {
    let _ = writeln!(file, "[{seconds}] {line}");
  }
}

/// 在本机临时提供一个 updater manifest。Tauri 的 `Update` 不能从项目代码直接构造，
/// 但 `UpdaterBuilder::endpoints` 可以在运行时覆盖 endpoint；因此把 Release 信息
/// 变成一份内存 manifest，再由本地 HTTP 服务提供给 updater 插件。
/// manifest 只监听 127.0.0.1，安装包本身仍走 https 且由插件校验签名。
struct ManifestServer {
  port: u16,
  stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
  handle: Option<std::thread::JoinHandle<()>>,
}

impl ManifestServer {
  fn start(base: Value, urls: Vec<String>) -> Result<Self, String> {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    let listener = TcpListener::bind(("127.0.0.1", 0))
      .map_err(|error| format!("本地更新服务启动失败: {error}"))?;
    listener
      .set_nonblocking(true)
      .map_err(|error| format!("本地更新服务配置失败: {error}"))?;
    let port = listener
      .local_addr()
      .map_err(|error| format!("本地更新服务地址读取失败: {error}"))?
      .port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_for_thread = stop.clone();

    let handle = thread::spawn(move || {
      while !stop_for_thread.load(Ordering::Relaxed) {
        match listener.accept() {
          Ok((mut stream, _)) => {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut request = [0u8; 1024];
            let read = stream.read(&mut request).unwrap_or(0);
            let request_text = String::from_utf8_lossy(&request[..read]);
            let path = request_text
              .lines()
              .next()
              .and_then(|line| line.split_whitespace().nth(1))
              .unwrap_or("");
            let index = path
              .strip_prefix("/manifest/")
              .and_then(|value| value.parse::<usize>().ok());
            let valid = index.map(|value| value < urls.len()).unwrap_or(false);
            let body = if let Some(index) = index.filter(|value| *value < urls.len()) {
              let mut manifest = base.clone();
              manifest["platforms"][UPDATE_TARGET]["url"] =
                Value::String(urls[index].clone());
              manifest.to_string()
            } else {
              json!({ "error": "not found" }).to_string()
            };
            let status = if valid { "200 OK" } else { "404 Not Found" };
            let response = format!(
              "HTTP/1.1 {status}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
              body.len(),
              body
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
          }
          Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            thread::sleep(Duration::from_millis(50));
          }
          Err(_) => break,
        }
      }
    });

    Ok(Self {
      port,
      stop,
      handle: Some(handle),
    })
  }
}

impl Drop for ManifestServer {
  fn drop(&mut self) {
    use std::sync::atomic::Ordering;

    self.stop.store(true, Ordering::Relaxed);
    if let Some(handle) = self.handle.take() {
      let _ = handle.join();
    }
  }
}

/// 下载并安装更新：安装包地址在各镜像间逐个回退，每个源都有独立超时，
/// 校验失败或连接中断时自动换下一个源，避免单个 GitHub 直链失败就整体失败。
#[tauri::command]
async fn install_update(
  app: tauri::AppHandle,
  version: String,
  notes: String,
  download_url: String,
  signature: String,
  published_at: String,
  on_progress: Channel<UpdateEvent>,
) -> Result<String, String> {
  let version = version.trim().trim_start_matches('v').to_string();
  let download_url = download_url.trim().to_string();
  let signature = signature.trim().to_string();
  if version.is_empty() {
    return Err("更新版本号为空".into());
  }
  if download_url.is_empty() {
    return Err("更新下载地址为空".into());
  }
  if signature.is_empty() {
    return Err("更新签名缺失".into());
  }

  // Tauri 的签名字段要求是 `.sig` 文件的 Base64 内容；Release 里的 `.sig`
  // 资产本身就是这串 Base64，不需要再次编码。
  let mut manifest = json!({
    "version": version,
    "notes": notes,
  });
  let mut platforms = serde_json::Map::new();
  platforms.insert(
    UPDATE_TARGET.to_string(),
    json!({
      "signature": signature,
      "url": download_url,
    }),
  );
  manifest["platforms"] = Value::Object(platforms);
  if !published_at.trim().is_empty() {
    manifest["pub_date"] = Value::String(published_at);
  }

  let mut candidates: Vec<(String, String)> = Vec::new();
  for (name, prefix) in UPDATE_SOURCES {
    let url = if prefix.is_empty() {
      download_url.clone()
    } else {
      format!("{prefix}{download_url}")
    };
    if !candidates.iter().any(|(_, existing)| existing == &url) {
      candidates.push((name.to_string(), url));
    }
  }
  let urls: Vec<String> = candidates.iter().map(|(_, url)| url.clone()).collect();
  let server = ManifestServer::start(manifest, urls)?;

  let total = candidates.len() as u32;
  let mut last_error = String::new();
  for (index, (source, _url)) in candidates.iter().enumerate() {
    let endpoint = format!("http://127.0.0.1:{}/manifest/{index}", server.port);
    let endpoint = endpoint
      .parse()
      .map_err(|error| format!("本地更新地址无效: {error}"))?;
    let _ = on_progress.send(UpdateEvent::Attempt {
      attempt: index as u32 + 1,
      total,
      source: source.clone(),
    });
    log_update(
      &app,
      &format!("attempt {}/{}: {}", index + 1, total, source),
    );

    let updater = app
      .updater_builder()
      .endpoints(vec![endpoint])
      .map_err(|error| format!("更新检查初始化失败: {error}"))?
      .timeout(if source == "github" {
        Duration::from_secs(30)
      } else {
        Duration::from_secs(300)
      })
      // 本地 manifest 和镜像下载都不走系统代理，避免代理把 127.0.0.1 也接管。
      .no_proxy()
      .build()
      .map_err(|error| format!("更新检查初始化失败: {error}"))?;
    let Some(mut update) = updater
      .check()
      .await
      .map_err(|error| format!("检查更新失败: {error}"))?
    else {
      log_update(&app, "check: already latest");
      continue;
    };
    log_update(
      &app,
      &format!("check: {} -> {}", update.current_version, update.version),
    );

    // 直连在大陆网络常被重置，给较短超时尽快回退到镜像；
    // 镜像本身较慢，留足下载时间。
    update.timeout = Some(if source == "github" {
      Duration::from_secs(30)
    } else {
      Duration::from_secs(300)
    });

    let channel = on_progress.clone();
    let mut downloaded: u64 = 0;
    let mut reported: i32 = -1;
    let result = update
      .download_and_install(
        |chunk, content_length| {
          downloaded += chunk as u64;
          let percent = content_length
            .filter(|total| *total > 0)
            .map(|total| (downloaded.saturating_mul(100) / total).min(100) as u8);
          let key = percent.map(i32::from).unwrap_or(-1);
          if key != reported {
            reported = key;
            let _ = channel.send(UpdateEvent::Progress { percent });
          }
        },
        || {},
      )
      .await;
    match result {
      Ok(()) => return Ok(source.clone()),
      Err(error) => {
        last_error = format!("{source}: {error}");
        log_update(&app, &format!("failed: {last_error}"));
      }
    }
  }

  if last_error.is_empty() {
    return Err("当前已是最新版本".into());
  }
  Err(format!("所有更新源均下载失败（{last_error}）"))
}

/// 启动阶段提升进程优先级，缩短 WebView2 初始化与首帧渲染时间。
#[cfg(windows)]
fn boost_startup_priority() {
  use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, SetPriorityClass, HIGH_PRIORITY_CLASS,
  };
  unsafe {
    SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
  }
}

#[cfg(not(windows))]
fn boost_startup_priority() {}

// ---- 命令行调用 ----

/// 附件体积上限，与上传限制保持一致。
const MAX_CLI_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// 待前端取走的命令行调用。第二个实例可能早于页面就绪到达，因此先入队再通知。
static CLI_QUEUE: Mutex<Vec<Value>> = Mutex::new(Vec::new());

/// 其他应用启动本应用时传入的参数。
#[derive(Debug, Default, PartialEq, Eq)]
struct CliOptions {
  text: Option<String>,
  files: Vec<String>,
  /// None 表示调用方没提这个开关，保持界面当前状态。
  search: Option<bool>,
  thinking: Option<bool>,
  send: bool,
  new: bool,
}

fn resolve_cli_path(value: &str, cwd: &Path) -> String {
  let path = Path::new(value);
  if path.is_absolute() {
    path.to_string_lossy().into_owned()
  } else {
    cwd.join(path).to_string_lossy().into_owned()
  }
}

/// 解析 `--text`、`--file`、`--search`/`--unsearch`、`--thinking`/`--unthinking`、
/// `--send`、`--new`，同时支持 `--opt value` 与 `--opt=value`。第一个参数是可执行文件路径。
/// 一个开关都没识别到时返回 None：普通启动（或开发模式附加的参数）不应改动界面状态；
/// 只带开关的调用（如 `--thinking`、`--send`）是有效调用，必须入队。
fn parse_cli_args(args: Vec<String>, cwd: &Path) -> Option<CliOptions> {
  let mut options = CliOptions::default();
  let mut recognized = false;
  let mut args = args.into_iter();
  let _ = args.next();
  while let Some(raw) = args.next() {
    let (flag, inline) = match raw.split_once('=') {
      Some((flag, value)) if flag.starts_with("--") => (flag.to_string(), Some(value.to_string())),
      _ => (raw, None),
    };
    let mut take_value = || inline.clone().or_else(|| args.next());
    match flag.as_str() {
      "--text" => {
        recognized = true;
        options.text = take_value();
      }
      "--file" => {
        recognized = true;
        if let Some(value) = take_value() {
          options.files.push(resolve_cli_path(&value, cwd));
        }
      }
      "--search" => {
        recognized = true;
        options.search = Some(true);
      }
      "--unsearch" | "--no-search" => {
        recognized = true;
        options.search = Some(false);
      }
      "--thinking" => {
        recognized = true;
        options.thinking = Some(true);
      }
      "--unthinking" | "--no-thinking" => {
        recognized = true;
        options.thinking = Some(false);
      }
      "--send" => {
        recognized = true;
        options.send = true;
      }
      "--new" => {
        recognized = true;
        options.new = true;
      }
      // 未识别的参数（如开发模式附加的参数）直接忽略
      _ => {}
    }
  }
  if recognized {
    Some(options)
  } else {
    None
  }
}

fn queue_cli_invocation(app: &tauri::AppHandle, options: CliOptions) {
  let payload = json!({
    "text": options.text,
    "files": options.files,
    "search": options.search,
    "thinking": options.thinking,
    "send": options.send,
    "new": options.new,
  });
  if let Ok(mut queue) = CLI_QUEUE.lock() {
    queue.push(payload);
  }
  // 事件只是唤醒信号，数据统一由 take_cli_invocations 取走，避免重复执行。
  let _ = app.emit("cli-invoke", ());
}

fn focus_main_window(app: &tauri::AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

/// 取走待处理的命令行调用；前端在页面就绪后调用一次，之后由事件唤醒。
#[tauri::command]
fn take_cli_invocations() -> Vec<Value> {
  CLI_QUEUE
    .lock()
    .map(|mut queue| std::mem::take(&mut *queue))
    .unwrap_or_default()
}

/// 读取 `--file` 指定的附件。路径由调用方给出，前端只按命令行传入的路径请求。
#[tauri::command]
fn read_cli_file(path: String) -> Result<Value, String> {
  let file = PathBuf::from(&path);
  let metadata = fs::metadata(&file).map_err(|error| format!("{path}: {error}"))?;
  if !metadata.is_file() {
    return Err(format!("{path}: not a file"));
  }
  if metadata.len() > MAX_CLI_FILE_BYTES {
    return Err(format!("{}: larger than {} bytes", path, MAX_CLI_FILE_BYTES));
  }
  let bytes = fs::read(&file).map_err(|error| format!("{path}: {error}"))?;
  let name = file
    .file_name()
    .and_then(|value| value.to_str())
    .unwrap_or("attachment")
    .to_string();
  Ok(json!({ "name": name, "base64": base64_encode(&bytes) }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  if !ensure_webview2() {
    std::process::exit(1);
  }
  tauri::Builder::default()
    // 单实例插件必须最先注册：第二个实例把参数交给已运行的窗口后自行退出。
    .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
      if let Some(options) = parse_cli_args(argv, Path::new(&cwd)) {
        queue_cli_invocation(app, options);
      }
      focus_main_window(app);
    }))
    .setup(|app| {
      let cwd = std::env::current_dir().unwrap_or_default();
      if let Some(options) = parse_cli_args(std::env::args().collect(), &cwd) {
        queue_cli_invocation(app.handle(), options);
      }
      Ok(())
    })
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_http::init())
    .invoke_handler(tauri::generate_handler![
      storage_request,
      report_startup,
      install_update,
      system_proxy,
      take_cli_invocations,
      read_cli_file,
      code_runner::check_runtime,
      code_runner::run_code
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn main() {
  START.get_or_init(Instant::now);
  boost_startup_priority();
  run();
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::io::{Read, Write};
  use std::net::TcpStream;

  fn fetch(port: u16, path: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    write!(
      stream,
      "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .expect("write");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read");
    response
  }

  #[test]
  fn cli_arguments_are_parsed_for_external_callers() {
    let cwd = std::path::Path::new("C:/work");
    let options = parse_cli_args(
      vec![
        "Deepseek CE.exe".to_string(),
        "--text".to_string(),
        "你好".to_string(),
        "--file".to_string(),
        "shot.png".to_string(),
        "--file=doc.pdf".to_string(),
        "--search".to_string(),
        "--send".to_string(),
        "--unknown".to_string(),
      ],
      cwd,
    )
    .expect("parsed options");
    assert_eq!(options.text.as_deref(), Some("你好"));
    assert_eq!(
      options.files,
      vec![
        cwd.join("shot.png").to_string_lossy().into_owned(),
        cwd.join("doc.pdf").to_string_lossy().into_owned(),
      ]
    );
    assert_eq!(options.search, Some(true));
    assert!(options.send && !options.new);
    assert_eq!(options.thinking, None);

    let absolute = if cfg!(windows) { "C:/tmp/a.txt" } else { "/tmp/a.txt" };
    let options = parse_cli_args(vec!["app".to_string(), "--file".to_string(), absolute.to_string()], cwd)
      .expect("file only");
    assert_eq!(options.files, vec![absolute.to_string()]);
    assert!(options.text.is_none());

    // 只带开关的调用是有效调用：--thinking / --search / --send 必须能单独生效
    let options = parse_cli_args(vec!["app".to_string(), "--thinking".to_string()], cwd)
      .expect("flag only");
    assert_eq!(options.thinking, Some(true));
    assert_eq!(options.search, None);
    assert!(!options.send && !options.new);
    assert!(options.text.is_none() && options.files.is_empty());

    // 关闭开关：--unsearch / --unthinking（--no-* 为等价写法），后出现的覆盖前面的
    let options = parse_cli_args(vec!["app".to_string(), "--unthinking".to_string()], cwd)
      .expect("unthinking");
    assert_eq!(options.thinking, Some(false));
    let options = parse_cli_args(vec!["app".to_string(), "--no-search".to_string()], cwd)
      .expect("no-search");
    assert_eq!(options.search, Some(false));
    let options = parse_cli_args(
      vec![
        "app".to_string(),
        "--search".to_string(),
        "--unsearch".to_string(),
      ],
      cwd,
    )
    .expect("last wins");
    assert_eq!(options.search, Some(false));
    let options = parse_cli_args(vec!["app".to_string(), "--send".to_string()], cwd).expect("send");
    assert!(options.send);
    let options = parse_cli_args(vec!["app".to_string(), "--new".to_string()], cwd).expect("new");
    assert!(options.new);

    // 没有任何可识别参数：普通启动，不改动界面状态
    assert!(parse_cli_args(vec!["app".to_string()], cwd).is_none());
    assert!(parse_cli_args(vec!["app".to_string(), "--no-watch".to_string()], cwd).is_none());
  }

  #[test]
  fn storage_index_recovers_and_updates_are_serialized() {
    let dir = std::env::temp_dir().join(format!(
      "dsh-storage-test-{}-{}",
      std::process::id(),
      TEMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("sessions")).expect("sessions dir");
    let summary_path = dir.join("summaries.json");

    // 30 个会话文件，索引先写成空数组；并发更新必须全部保留。
    for i in 0..30 {
      let id = format!("session-{i:02}");
      write_json(
        &dir.join("sessions").join(format!("{id}.json")),
        &json!({"id": id, "title": format!("会话 {i}"), "createdAt": i, "updatedAt": i, "messages": []}),
      )
      .expect("session");
    }
    write_json(&summary_path, &json!([])).expect("empty summaries");

    let handles: Vec<_> = (0..30)
      .map(|i| {
        let dir = dir.clone();
        std::thread::spawn(move || {
          let id = format!("session-{i:02}");
          update_summaries(&dir, |sums| {
            sums.retain(|s| s.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
            sums.push(json!({"id": id, "title": format!("会话 {i}"), "createdAt": i, "updatedAt": i, "fileIds": []}));
            Ok(())
          })
          .expect("update summaries");
        })
      })
      .collect();
    for handle in handles {
      handle.join().expect("join update");
    }
    let summaries = read_summaries(&dir);
    assert_eq!(summaries.len(), 30);
    assert_eq!(
      summaries.iter().filter(|s| s.get("id").and_then(|v| v.as_str()).is_some()).count(),
      30
    );

    // 索引只剩 5 条、索引损坏时，都应从会话文件自愈。
    write_json(&summary_path, &Value::Array(summaries[..5].to_vec())).expect("stale summaries");
    ensure_summaries(&dir);
    assert_eq!(read_summaries(&dir).len(), 30);
    fs::write(&summary_path, "{\"broken\":").expect("broken summaries");
    assert_eq!(read_summaries(&dir).len(), 30);

    // 半个会话 JSON 不能拖垮自愈。
    fs::write(dir.join("sessions").join("broken.json"), "{\"id\":\"broken\"").expect("broken session");
    ensure_summaries(&dir);
    assert_eq!(read_summaries(&dir).len(), 30);

    // 并发写同一个文件不能共用临时文件写坏结果。
    let race_path = dir.join("race.json");
    let race_handles: Vec<_> = (0..8)
      .map(|i| {
        let path = race_path.clone();
        std::thread::spawn(move || {
          write_json(&path, &json!({"thread": i, "text": "x".repeat(2000)})).expect("race write");
        })
      })
      .collect();
    for handle in race_handles {
      handle.join().expect("join race");
    }
    assert!(read_json(&race_path).is_some());

    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn manifest_server_switches_download_url() {
    let base = json!({
      "version": "1.1.4",
      "notes": "test",
      "platforms": {
        "windows-x86_64": {
          "signature": "c2ln",
          "url": "https://github.com/example/app.exe"
        }
      }
    });
    let urls = vec![
      "https://gh-proxy.com/https://github.com/example/app.exe".to_string(),
      "https://github.com/example/app.exe".to_string(),
    ];
    let server = ManifestServer::start(base, urls).expect("server");

    let first = fetch(server.port, "/manifest/0");
    assert!(first.starts_with("HTTP/1.1 200 OK"));
    assert!(first.contains("https://gh-proxy.com/https://github.com/example/app.exe"));

    let second = fetch(server.port, "/manifest/1");
    assert!(second.contains("\"url\":\"https://github.com/example/app.exe\""));

    let missing = fetch(server.port, "/manifest/9");
    assert!(missing.starts_with("HTTP/1.1 404 Not Found"));
  }
}
