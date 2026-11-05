#!/usr/bin/env node
/**
 * dsh-workbuddy-guard —— 命令行工具。
 *
 * 定时**只有一条**：bundle 自己（`index.js` 的 `selfSchedule`）每 3 分钟派生一次
 * `scripts/watch.mjs`。这里没有 install/uninstall，因为不需要再挂第二个定时器
 * —— DSH 没在跑的时候，也没有任何请求会被发出去，那时检查没有意义。
 *
 * 本文件只提供手动操作与排查：
 *   dsh-workbuddy-guard status            # 守卫状态
 *   dsh-workbuddy-guard where             # 解析出的各条路径
 *   dsh-workbuddy-guard check [args...]   # 立刻跑一次（参数透传给 watch.mjs）
 *
 * 透传的常用参数：
 *   --dry-run              演练，不落盘
 *   --check                只检查，不改 profile
 *   --enable               恢复被停用的插件
 *   --clear-watermark      只清界面水印
 *   --no-upgrade           跳过自动升级
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const WATCH = join(PKG_ROOT, 'scripts', 'watch.mjs')

const HOME = process.env.HOME || process.env.USERPROFILE || homedir()
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const STATE_DIR = join(DSH_HOME, 'workbuddy-update-watch')
const PROFILE = process.env.DSH_PROFILE || 'web'

const ARGV = process.argv.slice(2)
const cmd = ARGV[0] ?? 'status'

const say = (msg) => process.stdout.write(`${msg}\n`)
const warn = (msg) => process.stderr.write(`dsh-workbuddy-guard: ${msg}\n`)

/** 跑一次检查脚本，返回解析后的 JSON（解析失败则给原始输出）。 */
function runWatch(extra = []) {
  const res = spawnSync(process.execPath, [WATCH, ...extra], { encoding: 'utf8', timeout: 300_000 })
  const line = (res.stdout ?? '').trim().split('\n').filter(Boolean).pop()
  try {
    return { ok: res.status === 0, value: JSON.parse(line) }
  } catch {
    return { ok: res.status === 0, raw: line, stderr: (res.stderr ?? '').trim() }
  }
}

function cmdStatus() {
  if (!existsSync(WATCH)) {
    warn(`check script missing: ${WATCH}`)
    process.exit(1)
  }
  const r = runWatch(['--status'])
  if (!r.value) {
    warn(r.raw ?? r.stderr ?? '(no output)')
    process.exit(1)
  }
  const v = r.value
  if (v.targetInstalled === false) {
    say(`guard pkg   (not installed)`)
    say(`status      SKIPPED — dsh-connect-workbuddy 未安装，守卫不做任何事`)
    say(`evidence    ${v.targetEvidence}`)
    say(`state dir   ${STATE_DIR}`)
    process.exit(0)
  }
  say(`baseline    ${v.baselineVersion ?? '(none — 下一轮自动落基线)'}`
    + `${v.baselinePlatform ? `  [${v.baselinePlatform}]` : ''}`
    + `${v.baselineSource ? `  (${v.baselineSource})` : ''}${v.baselineAt ? `  @ ${v.baselineAt}` : ''}`)
  const j = v.lastJudge
  if (j) {
    say(`last judge  interface ${j.interfaceVersion ?? '?'} / filename ${j.linkVersion ?? '?'}`
      + `  → ${j.judgedVersion ?? '不做判定'}${j.versionGap ? '  (两路不一致，取高者)' : ''}`)
  }
  say(`endpoint    ${v.upstreamUrl ?? '(default)'}  [${v.platform ?? '?'}]`)
  say(`guard pkg   ${v.pluginInstalled ?? '(not installed)'}`)
  say(`plugin on   ${v.bundleSelected === true ? 'yes' : v.bundleSelected === false ? 'NO (disabled)' : 'unknown'}`)
  say(`watermark   ${v.watermark ? v.watermark.title : 'none'}`)
  say(`checks      ${v.checks ?? 0}`)
  say(`last check  ${v.lastCheckAt ?? '(never)'}`)
  say(`state dir   ${STATE_DIR}`)
  if (v.pendingStop !== null && v.pendingStop !== undefined) say(`pending stop #${v.pendingStop}（插件尚未处理）`)
  if (v.disabled) say(`disabled at ${v.disabled.at}  ${v.disabled.from} → ${v.disabled.to}`)
}

function cmdWhere() {
  say(JSON.stringify({
    packageRoot: PKG_ROOT,
    watch: WATCH,
    node: process.execPath,
    home: HOME,
    dshHome: DSH_HOME,
    stateDir: STATE_DIR,
    profile: PROFILE,
    platform: process.platform,
    arch: process.arch,
    scheduler: 'bundle-internal (index.js selfSchedule)',
  }, null, 2))
}

switch (cmd) {
  case 'status':
    cmdStatus()
    break
  case 'where':
    cmdWhere()
    break
  case 'check': {
    const r = runWatch(ARGV.slice(1))
    if (r.value) say(JSON.stringify(r.value))
    else {
      if (r.raw) say(r.raw)
      if (r.stderr) warn(r.stderr)
    }
    process.exit(r.ok ? 0 : 1)
    break
  }
  case 'help':
  case '--help':
  case '-h': {
    const header = readFileSync(new URL(import.meta.url), 'utf8')
    say(header.split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?/, '').trimEnd())
    break
  }
  default:
    warn(`unknown command ${cmd}; use: status | where | check`)
    process.exit(2)
}
