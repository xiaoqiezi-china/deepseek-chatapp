use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const CODE_LIMIT: usize = 200 * 1024;
const RUN_DIR_PREFIX: &str = "deepseek-ce-run-";
const RUN_DIR_MAX_AGE: u64 = 24 * 60 * 60;

struct RuntimeInfo {
  available: bool,
  version: Option<String>,
  command: Option<String>,
  args: Vec<String>,
  error: Option<String>,
}

impl RuntimeInfo {
  fn unavailable(error: &str) -> Self {
    Self {
      available: false,
      version: None,
      command: None,
      args: Vec::new(),
      error: Some(error.to_string()),
    }
  }

  fn status_json(&self) -> Value {
    json!({
      "available": self.available,
      "version": self.version,
      "error": self.error,
    })
  }
}

#[cfg(windows)]
fn configure_command(command: &mut Command) {
  use std::os::windows::process::CommandExt;
  // CREATE_NO_WINDOW：环境探测不弹黑框。
  command.creation_flags(0x08000000);
}

#[cfg(not(windows))]
fn configure_command(_: &mut Command) {}

fn command_text(command: &str, args: &[&str]) -> Option<String> {
  let mut child = Command::new(command);
  child.args(args);
  configure_command(&mut child);
  let output = child.output().ok()?;
  if !output.status.success() {
    return None;
  }
  Some(format!(
    "{}{}",
    String::from_utf8_lossy(&output.stdout),
    String::from_utf8_lossy(&output.stderr)
  ))
}

fn python_version(text: &str) -> Option<String> {
  let marker = text.find("Python ")?;
  let version = text[marker + "Python ".len()..]
    .split_whitespace()
    .next()?;
  if version.chars().next()?.is_ascii_digit() {
    Some(format!("Python {version}"))
  } else {
    None
  }
}

fn node_version(text: &str) -> Option<String> {
  let start = text.find(|c: char| c.is_ascii_digit())?;
  let version = text[start..].split_whitespace().next()?;
  if version.chars().next()?.is_ascii_digit() {
    Some(format!("Node.js {}", version.trim_start_matches('v')))
  } else {
    None
  }
}

fn detect_runtime(language: &str) -> RuntimeInfo {
  if language == "python" {
    let candidates: Vec<(&str, Vec<&str>)> = if cfg!(windows) {
      vec![
        ("py", vec!["-3"]),
        ("python", vec![]),
        ("python3", vec![]),
      ]
    } else {
      vec![("python3", vec![]), ("python", vec![])]
    };
    for (command, args) in candidates {
      let mut version_args = args.clone();
      version_args.push("--version");
      if let Some(text) = command_text(command, &version_args) {
        if let Some(version) = python_version(&text) {
          return RuntimeInfo {
            available: true,
            version: Some(version),
            command: Some(command.to_string()),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            error: None,
          };
        }
      }
    }
    return RuntimeInfo::unavailable("Python runtime not found");
  }

  if language == "js" {
    if let Some(text) = command_text("node", &["--version"]) {
      if let Some(version) = node_version(&text) {
        return RuntimeInfo {
          available: true,
          version: Some(version),
          command: Some("node".to_string()),
          args: Vec::new(),
          error: None,
        };
      }
    }
    return RuntimeInfo::unavailable("Node.js runtime not found");
  }

  if language == "cmd" {
    if cfg!(windows) {
      return RuntimeInfo {
        available: true,
        version: Some("Windows cmd".to_string()),
        command: Some("cmd.exe".to_string()),
        args: Vec::new(),
        error: None,
      };
    }
    return RuntimeInfo::unavailable("cmd is only available on Windows");
  }

  RuntimeInfo::unavailable("Unsupported language")
}

#[tauri::command]
pub async fn check_runtime(language: String) -> Result<Value, String> {
  let info = tauri::async_runtime::spawn_blocking(move || detect_runtime(&language))
    .await
    .map_err(|error| error.to_string())?;
  Ok(info.status_json())
}

fn shell_quote(value: &str) -> String {
  if value
    .chars()
    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '\\' | ':' | '-'))
  {
    value.to_string()
  } else {
    format!("\"{}\"", value.replace('"', "\"\""))
  }
}

fn command_line(language: &str, runtime: &RuntimeInfo, filename: &str) -> Result<String, String> {
  if language == "cmd" {
    return Ok(format!("call {}", shell_quote(filename)));
  }
  let program = runtime
    .command
    .as_deref()
    .ok_or_else(|| "运行环境命令缺失".to_string())?;
  let mut parts = vec![shell_quote(program)];
  parts.extend(runtime.args.iter().map(|arg| shell_quote(arg)));
  parts.push(shell_quote(filename));
  Ok(parts.join(" "))
}

#[cfg(windows)]
fn write_launcher(
  language: &str,
  runtime: &RuntimeInfo,
  directory: &Path,
  filename: &str,
) -> Result<(), String> {
  let command = command_line(language, runtime, filename)?;
  let mut lines = vec![
    "@echo off".to_string(),
    "chcp 65001 >nul".to_string(),
    format!("title DeepSeek CE - {language}"),
    "cd /d \"%~dp0\"".to_string(),
  ];
  if language == "python" {
    lines.push("if not defined PYTHONIOENCODING set PYTHONIOENCODING=utf-8".to_string());
    lines.push("if not defined PYTHONUNBUFFERED set PYTHONUNBUFFERED=1".to_string());
  }
  lines.push(command);
  lines.push("set \"DEEPSEEK_CE_EXIT=%ERRORLEVEL%\"".to_string());
  lines.push("echo.".to_string());
  lines.push("echo [DeepSeek CE] Process exited with code %DEEPSEEK_CE_EXIT%.".to_string());
  fs::write(directory.join("run.cmd"), lines.join("\r\n"))
    .map_err(|error| format!("写入启动脚本失败: {error}"))
}

#[cfg(not(windows))]
fn write_launcher(
  language: &str,
  runtime: &RuntimeInfo,
  directory: &Path,
  filename: &str,
) -> Result<(), String> {
  use std::os::unix::fs::PermissionsExt;
  let command = command_line(language, runtime, filename)?;
  let mut lines = vec![
    "#!/bin/bash".to_string(),
    "cd \"$(dirname \"$0\")\" || exit 1".to_string(),
  ];
  if language == "python" {
    lines.push("export PYTHONIOENCODING=\"${PYTHONIOENCODING:-utf-8}\"".to_string());
    lines.push("export PYTHONUNBUFFERED=\"${PYTHONUNBUFFERED:-1}\"".to_string());
  }
  lines.push(command);
  lines.push("code=$?".to_string());
  lines.push("echo".to_string());
  lines.push("echo \"[DeepSeek CE] Process exited with code $code.\"".to_string());
  lines.push("exec \"${SHELL:-/bin/bash}\"".to_string());
  let path = directory.join("run.sh");
  fs::write(&path, lines.join("\n")).map_err(|error| format!("写入启动脚本失败: {error}"))?;
  fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
    .map_err(|error| format!("设置启动脚本权限失败: {error}"))
}

#[cfg(windows)]
fn open_console(directory: &Path) -> Result<(), String> {
  use std::os::windows::process::CommandExt;
  let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
  let mut command = Command::new(comspec);
  command.args(["/d", "/s", "/k", "run.cmd"]).current_dir(directory);
  // CREATE_NEW_CONSOLE：打开一个可见控制台，stdio 保持连接到新控制台。
  command.creation_flags(0x00000010);
  command
    .spawn()
    .map(|_| ())
    .map_err(|error| format!("无法打开控制台: {error}"))
}

#[cfg(target_os = "macos")]
fn open_console(directory: &Path) -> Result<(), String> {
  let script = directory.join("run.sh");
  Command::new("open")
    .arg("-a")
    .arg("Terminal")
    .arg(script)
    .spawn()
    .map(|_| ())
    .map_err(|error| format!("无法打开终端: {error}"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_console(directory: &Path) -> Result<(), String> {
  let script = directory.join("run.sh");
  let terminals: Vec<(&str, Vec<String>)> = vec![
    ("x-terminal-emulator", vec!["-e".into(), "bash".into(), script.to_string_lossy().into_owned()]),
    ("gnome-terminal", vec!["--".into(), "bash".into(), script.to_string_lossy().into_owned()]),
    ("konsole", vec!["-e".into(), "bash".into(), script.to_string_lossy().into_owned()]),
    ("xterm", vec!["-e".into(), "bash".into(), script.to_string_lossy().into_owned()]),
  ];
  let mut last_error = "未找到可用终端".to_string();
  for (terminal, args) in terminals {
    match Command::new(terminal).args(args).spawn() {
      Ok(_) => return Ok(()),
      Err(error) => last_error = format!("无法打开 {terminal}: {error}"),
    }
  }
  Err(last_error)
}

fn cleanup_old_runs() {
  let Ok(entries) = fs::read_dir(std::env::temp_dir()) else {
    return;
  };
  for entry in entries.flatten() {
    let name = entry.file_name();
    if !name.to_string_lossy().starts_with(RUN_DIR_PREFIX) {
      continue;
    }
    let path = entry.path();
    let old = fs::metadata(&path)
      .and_then(|metadata| metadata.modified())
      .ok()
      .and_then(|modified| modified.elapsed().ok())
      .map(|elapsed| elapsed.as_secs() > RUN_DIR_MAX_AGE)
      .unwrap_or(false);
    if old {
      let _ = fs::remove_dir_all(path);
    }
  }
}

fn run_blocking(language: &str, code: &str) -> Result<Value, String> {
  if code.len() > CODE_LIMIT {
    return Ok(json!({
      "ok": false,
      "error": "CODE_TOO_LARGE",
      "message": "Code is too large",
    }));
  }

  let runtime = detect_runtime(language);
  if !runtime.available {
    return Ok(json!({
      "ok": false,
      "error": "RUNTIME_NOT_FOUND",
      "message": runtime.error,
    }));
  }

  cleanup_old_runs();
  let extension = if language == "python" {
    ".py"
  } else if language == "js" {
    ".js"
  } else {
    ".cmd"
  };
  let filename = format!("main{extension}");
  let stamp = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_nanos())
    .unwrap_or(0);
  let directory: PathBuf = std::env::temp_dir().join(format!(
    "deepseek-ce-run-{}-{stamp}",
    std::process::id()
  ));
  fs::create_dir_all(&directory).map_err(|error| format!("创建临时目录失败: {error}"))?;

  let result = (|| {
    let script = if language == "cmd" {
      code.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
      code.to_string()
    };
    fs::write(directory.join(&filename), script)
      .map_err(|error| format!("写入临时文件失败: {error}"))?;
    write_launcher(language, &runtime, &directory, &filename)?;
    open_console(&directory)
  })();

  if result.is_err() {
    let _ = fs::remove_dir_all(&directory);
  }
  result?;

  Ok(json!({
    "ok": true,
    "language": language,
    "mode": "console",
    "consolePath": directory.to_string_lossy(),
  }))
}

#[tauri::command]
pub async fn run_code(language: String, code: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || run_blocking(&language, &code))
    .await
    .map_err(|error| error.to_string())?
}
