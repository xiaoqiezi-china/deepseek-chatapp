import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export type RunLanguage = 'python' | 'js' | 'cmd'

type RuntimeInfo = {
  available: boolean
  version?: string
  command?: string
  args?: string[]
  error?: string
}

const CODE_LIMIT = 200 * 1024
const RUN_DIR_PREFIX = 'deepseek-ce-run-'
const RUN_DIR_MAX_AGE = 24 * 60 * 60 * 1000

const isWindows = process.platform === 'win32'

const runTextCommand = (command: string, args: string[], timeout = 5_000) =>
  new Promise<{ text: string; ok: boolean }>((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn> | undefined
    const finish = (text: string, ok: boolean) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      resolve({ text, ok })
    }
    const timer = setTimeout(() => {
      child?.kill()
      finish('', false)
    }, timeout)
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      finish('', false)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', () => finish('', false))
    child.on('close', (code) => finish(`${stdout}\n${stderr}`, code === 0))
  })

const parsePythonPaths = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => {
      const colon = line.indexOf(':\\')
      return colon > 0 ? line.slice(colon - 1).trim() : ''
    })
    .filter(Boolean)

const pythonCandidates = async (): Promise<Array<{ command: string; args: string[] }>> => {
  if (!isWindows) {
    return [
      { command: 'python3', args: [] },
      { command: 'python', args: [] },
    ]
  }

  const candidates: Array<{ command: string; args: string[] }> = []
  // py 启动器知道不在 PATH 里的 Python 安装位置；直接路径避免 WindowsApps alias 问题。
  for (const flag of ['-0p', '--list-paths']) {
    const result = await runTextCommand('py', [flag])
    if (!result.ok) {
      continue
    }
    for (const path of parsePythonPaths(result.text)) {
      candidates.push({ command: path, args: [] })
    }
    if (candidates.length > 0) {
      break
    }
  }

  candidates.push(
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] },
    { command: 'python3', args: [] }
  )
  return candidates
}

const detectPython = async (): Promise<RuntimeInfo> => {
  for (const candidate of await pythonCandidates()) {
    const result = await runTextCommand(candidate.command, [...candidate.args, '--version'])
    const version = result.text.match(/Python\s+(\d+(?:\.\d+)*)/i)?.[1]
    if (result.ok && version) {
      return {
        available: true,
        version: `Python ${version}`,
        command: candidate.command,
        args: candidate.args,
      }
    }
  }
  return { available: false, error: 'Python runtime not found' }
}

const detectNode = async (): Promise<RuntimeInfo> => {
  const result = await runTextCommand('node', ['--version'])
  const version = result.text.match(/v?(\d+(?:\.\d+)*)/)?.[1]
  if (result.ok && version) {
    return { available: true, version: `Node.js ${version}`, command: 'node', args: [] }
  }
  return { available: false, error: 'Node.js runtime not found' }
}

const detectCmd = async (): Promise<RuntimeInfo> => {
  if (!isWindows) {
    return { available: false, error: 'cmd is only available on Windows' }
  }
  return { available: true, version: 'Windows cmd', command: 'cmd.exe', args: [] }
}

export const checkRuntime = async (language: RunLanguage): Promise<RuntimeInfo> => {
  if (language === 'python') {
    return detectPython()
  }
  if (language === 'js') {
    return detectNode()
  }
  return detectCmd()
}

const quoteArg = (value: string): string =>
  /^[A-Za-z0-9_./:\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`

const commandLineFor = (
  language: RunLanguage,
  runtime: RuntimeInfo,
  filename: string
): string => {
  if (language === 'cmd') {
    return `call ${quoteArg(filename)}`
  }
  const program = runtime.command
  if (!program) {
    throw new Error('Runtime command is missing')
  }
  return [quoteArg(program), ...(runtime.args ?? []).map(quoteArg), quoteArg(filename)].join(' ')
}

const writeLauncher = async (
  language: RunLanguage,
  runtime: RuntimeInfo,
  directory: string,
  filename: string
): Promise<string> => {
  const commandLine = commandLineFor(language, runtime, filename)
  const launcher = isWindows ? path.join(directory, 'run.cmd') : path.join(directory, 'run.sh')
  if (isWindows) {
    const lines = [
      '@echo off',
      'chcp 65001 >nul',
      `title DeepSeek CE - ${language}`,
      'cd /d "%~dp0"',
      ...(language === 'python'
        ? [
            'if not defined PYTHONIOENCODING set PYTHONIOENCODING=utf-8',
            'if not defined PYTHONUNBUFFERED set PYTHONUNBUFFERED=1',
          ]
        : []),
      commandLine,
      'set "DEEPSEEK_CE_EXIT=%ERRORLEVEL%"',
      'echo.',
      'echo [DeepSeek CE] Process exited with code %DEEPSEEK_CE_EXIT%.',
    ]
    await fsp.writeFile(launcher, `${lines.join('\r\n')}\r\n`, 'utf8')
  } else {
    const lines = [
      '#!/bin/bash',
      'cd "$(dirname "$0")" || exit 1',
      ...(language === 'python'
        ? [
            'export PYTHONIOENCODING="${PYTHONIOENCODING:-utf-8}"',
            'export PYTHONUNBUFFERED="${PYTHONUNBUFFERED:-1}"',
          ]
        : []),
      commandLine,
      'code=$?',
      'echo',
      'echo "[DeepSeek CE] Process exited with code $code."',
      'exec "${SHELL:-/bin/bash}"',
    ]
    await fsp.writeFile(launcher, `${lines.join('\n')}\n`, 'utf8')
    await fsp.chmod(launcher, 0o755)
  }
  return launcher
}

const waitForSpawn = (file: string, args: string[], cwd: string) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: isWindows,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })

const openConsole = async (directory: string): Promise<void> => {
  if (isWindows) {
    // 由 PowerShell 的 Start-Process 负责创建新控制台。
    // 不拼 `cmd /c start` 命令串，避免 Node 对内部引号转义后 cmd 解析失败。
    await new Promise<void>((resolve, reject) => {
      const powershell = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      )
      const child = spawn(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          "Start-Process -FilePath $env:DEEPSEEK_CE_COMSPEC -ArgumentList '/k','run.cmd' -WorkingDirectory $env:DEEPSEEK_CE_RUN_DIR -WindowStyle Normal",
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            DEEPSEEK_CE_RUN_DIR: directory,
            DEEPSEEK_CE_COMSPEC: path.join(
              process.env.SystemRoot || 'C:\\Windows',
              'System32',
              'cmd.exe'
            ),
          },
          stdio: 'ignore',
          windowsHide: true,
        }
      )
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) {
          resolve()
          return
        }
        reject(new Error(`控制台启动失败，退出码 ${code ?? -1}`))
      })
    })
    return
  }

  const script = path.join(directory, 'run.sh')
  if (process.platform === 'darwin') {
    await waitForSpawn('open', ['-a', 'Terminal', script], directory)
    return
  }

  const terminals: Array<{ file: string; args: string[] }> = [
    { file: 'x-terminal-emulator', args: ['-e', 'bash', script] },
    { file: 'gnome-terminal', args: ['--', 'bash', script] },
    { file: 'konsole', args: ['-e', 'bash', script] },
    { file: 'xterm', args: ['-e', 'bash', script] },
  ]
  let lastError: unknown = null
  for (const terminal of terminals) {
    try {
      await waitForSpawn(terminal.file, terminal.args, directory)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('No terminal emulator found')
}

const cleanupOldRuns = async (): Promise<void> => {
  const entries = await fsp.readdir(os.tmpdir(), { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(RUN_DIR_PREFIX))
      .map(async (entry) => {
        const target = path.join(os.tmpdir(), entry.name)
        const stat = await fsp.stat(target).catch(() => null)
        if (!stat || Date.now() - stat.mtimeMs < RUN_DIR_MAX_AGE) {
          return
        }
        await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined)
      })
  )
}

export const runCode = async (
  language: RunLanguage,
  code: string
): Promise<Record<string, unknown>> => {
  if (code.length > CODE_LIMIT) {
    return { ok: false, error: 'CODE_TOO_LARGE', message: 'Code is too large' }
  }
  const runtime = await checkRuntime(language)
  if (!runtime.available) {
    return { ok: false, error: 'RUNTIME_NOT_FOUND', message: runtime.error ?? 'Runtime not found' }
  }

  await cleanupOldRuns()
  const extension = language === 'python' ? '.py' : language === 'js' ? '.js' : '.cmd'
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), RUN_DIR_PREFIX))
  const filename = `main${extension}`
  const file = path.join(dir, filename)
  try {
    await fsp.writeFile(file, language === 'cmd' ? code.replace(/\r?\n/g, '\r\n') : code, 'utf8')
    await writeLauncher(language, runtime, dir, filename)
    await openConsole(dir)
    return { ok: true, language, mode: 'console', consolePath: dir }
  } catch (error) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}
