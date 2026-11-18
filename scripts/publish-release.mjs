#!/usr/bin/env node
/**
 * 发布桌面端更新到 GitHub Releases。
 *
 * 用法：
 *   node scripts/publish-release.mjs <tag> [notes]
 *   例：node scripts/publish-release.mjs v0.1.1 "修复若干问题"
 *
 * 前置：
 *   1. 先执行 tauri build（需设置 TAURI_SIGNING_PRIVATE_KEY），产物位于
 *      src-tauri/target/release/bundle/nsis/
 *   2. 环境变量 GITHUB_TOKEN，或本机 git credential 中已保存 GitHub 凭据
 */
import { execFile } from 'node:child_process'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
const OWNER = 'xiaoqiezi-china'
const REPO = 'deepseek-chatapp'
const BUNDLE = 'src-tauri/target/release/bundle/nsis'

const tag = process.argv[2]
const notes = process.argv[3] ?? ''
if (!tag) {
  console.error('缺少 tag 参数，例如：node scripts/publish-release.mjs v0.1.1 "说明"')
  process.exit(1)
}
const version = tag.replace(/^v/, '')

async function getToken() {
  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN
  }
  const child = (await import('node:child_process')).spawn('git', ['credential', 'fill'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  let out = ''
  child.stdout.on('data', (chunk) => (out += chunk.toString()))
  child.stdin.write('protocol=https\nhost=github.com\n\n')
  child.stdin.end()
  const token = await new Promise((resolve) => {
    child.on('close', () => resolve(out.match(/password=(.+)/)?.[1]?.trim() ?? null))
  })
  if (!token) {
    throw new Error('未找到 GitHub 凭据，请设置 GITHUB_TOKEN')
  }
  return token
}

const token = await getToken()

const assets = (await readdir(BUNDLE)).filter((name) => name.endsWith('.exe') || name.endsWith('.sig'))
const exeName = assets.find((name) => name.endsWith('.exe'))
const sigName = exeName + '.sig'
if (!exeName || !assets.includes(sigName)) {
  throw new Error('未找到安装包或其签名，请先执行 tauri build')
}
const sig = (await readFile(`${BUNDLE}/${sigName}`, 'utf8')).trim()
const assetName = exeName.replace(/ /g, '-')
const downloadUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${assetName}`

const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: { 'windows-x86_64': { signature: sig, url: downloadUrl } },
}
await writeFile(`${BUNDLE}/latest.json`, JSON.stringify(latest, null, 2))

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'deepseek-ce',
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

let release = await api(`/releases/tags/${tag}`)
if (release.status === 404) {
  release = await api('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: `Deepseek CE ${tag}`, body: notes, draft: false }),
  })
}
if (!release.body?.id) {
  throw new Error('创建 release 失败：' + JSON.stringify(release.body))
}

const upload = async (filePath, name) => {
  const data = await readFile(filePath)
  const response = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.body.id}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'User-Agent': 'deepseek-ce',
      },
      body: data,
    }
  )
  return response.status
}

console.log('上传安装包:', await upload(`${BUNDLE}/${exeName}`, assetName))
console.log('上传签名:', await upload(`${BUNDLE}/${sigName}`, assetName + '.sig'))
console.log('上传 latest.json:', await upload(`${BUNDLE}/latest.json`, 'latest.json'))
console.log('\n完成：', `https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`)
