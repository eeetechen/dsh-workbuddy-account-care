#!/usr/bin/env node
/**
 * WorkBuddy 版本守卫 (WorkBuddy Update Watch)
 * ---------------------------------------------------------------------------
 * 每 3 分钟检查一次「本机 WorkBuddy 桌面端」有没有被更新，一旦发现更新就
 * 在 DSH profile 里停用 bundle `dsh-connect-workbuddy`，并弹一条桌面通知。
 *
 * 为什么是「本机」而不是只看上游：
 *   dsh-connect-workbuddy 依赖的是本机 WorkBuddy 客户端的私有接口与凭据文件。
 *   上游发布了新版本、而本机没升级时，插件仍然是好的；真正会让它失效的时刻是
 *   **本机的安装变了**（.deb 被升级、app 自更新、重装）。所以「本机指纹变化」
 *   是唯一的停用触发器；上游有新版本只记录、只播报，不动配置。
 *   想让上游一发版就停用，加 --disable-on-upstream 或设
 *   WORKBUDDY_WATCH_DISABLE_ON_UPSTREAM=1。
 *
 * 本机指纹（全部只读，不需要 root）：
 *   - dpkg 里的 workbuddy 版本号                 (5.6.2)
 *   - app.asar 的 package.json version           (5.6.2)
 *   - 内置插件的 build id                        (5.6.2-wb.40046327.gc7b525f3…)
 *   - cli/product.json 的 commit                 (c7b525f38b84…)
 *   注意 /opt/WorkBuddy/version 里是 **Electron** 版本（37.10.3-24），
 *   不是 WorkBuddy 自身版本，只作展示，不参与判定。
 *
 * 停用方式：把 dsh-connect-workbuddy 从
 *   ~/.dsh/profiles/<profile>/package.json 的 dsh.profile.bundles 里摘掉，
 *   dependencies 保留（重新装回来只需加回一行）。写之前先备份到状态目录。
 *
 * 同时维护插件自身版本：
 *   - 读 npm 上的 dsh-connect-workbuddy@latest，与已安装的比
 *   - 有新版就 `dsh plugin --profile <p> add dsh-connect-workbuddy@<latest>`
 *   - 升级后在界面挂「插件已升级，重启生效」水印
 *
 * 界面联动：写 `guard.json`（指令文件），由已安装的 bundle
 * `dsh-workbuddy-guard` 读取：
 *   - `watermark`     → 浏览器半在 shell.overlay 里画水印
 *   - `stopSessions`  → Host 半软结束「正在跑且在用 workbuddy」的会话
 * 停用 bundle 这件事**只由本脚本做**，插件不做——本插件加载失败时脚本照样
 * 能停用它，这是安全网不依赖被守卫对象的唯一办法。
 *
 * 用法：
 *   node workbuddy-update-watch.mjs                 # 检查；需要时停用 + 通知
 *   node workbuddy-update-watch.mjs --check         # 只检查，绝不动 profile
 *   node workbuddy-update-watch.mjs --dry-run       # 只报告「本来会做什么」
 *   node workbuddy-update-watch.mjs --status        # 打印当前状态，不联网
 *   node workbuddy-update-watch.mjs --ack           # 把待播报事件标记为已播报
 *   node workbuddy-update-watch.mjs --simulate-local 9.9.9.999   # 测试用
 *   node workbuddy-update-watch.mjs --simulate-plugin 9.9.9      # 测试用
 *   node workbuddy-update-watch.mjs --clear-watermark            # 手动清水印
 *   附加：--no-notify  --no-upgrade  --state-dir <dir>  --profile <name>  --profile-dir <dir>
 *
 * 输出：一行 JSON（便于定时任务/agent 解析），细节都写进 watch.log。
 * 退出码：0 正常（含「无更新」）；1 运行出错（网络错误不算错，只降级）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync,
  readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const SCHEMA = 1
const BUNDLE = 'dsh-connect-workbuddy'
/**
 * 软结束指令发给会话的那句话。
 *
 * 与 index.js 的 DEFAULT_STOP_TEXT 保持一致：脚本总是写值，插件只是兜底，
 * 两处文案必须一样，否则「脚本写的」和「插件默认的」会在不同路径上出现分叉。
 */
const STOP_TEXT = '暂停执行，等待重启 agent 工具。本机 provider 已更新，本条消息由监控插件自动发送，收到后暂停你的所有任务'
const HOME = process.env.HOME || process.env.USERPROFILE || homedir()
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const STATE_DIR = join(DSH_HOME, 'workbuddy-update-watch')
const DEFAULT_PROFILE = process.env.DSH_PROFILE || 'web'

/**
 * 本机 WorkBuddy 的安装根目录，按平台猜。
 *
 * Linux 用的是 deb 装到 /opt；macOS 是 .app 包（里面的版本信息在
 * Contents/Resources 下，所以这里指向 Contents）；Windows 走 electron-builder
 * 的默认安装位置。全部可用 WORKBUDDY_APP_DIR 覆盖。
 *
 * 注意：这个「猜」只影响**能不能读到版本**，读不到时会降级成
 * `unknown` 并照常写日志，不会误停用任何东西。
 */
function guessAppDir() {
  if (process.env.WORKBUDDY_APP_DIR) return process.env.WORKBUDDY_APP_DIR
  if (process.platform === 'darwin') return '/Applications/WorkBuddy.app/Contents'
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    return local ? join(local, 'Programs', 'WorkBuddy', 'resources') : 'C:\\Program Files\\WorkBuddy\\resources'
  }
  return '/opt/WorkBuddy'
}
const APP_DIR = guessAppDir()

/**
 * 上游版本接口的 platform 标识。
 *
 * 这是 WorkBuddy 官网下载页自己用的那套名字（见它的 download-*.js：
 * `workbuddy-linux-x64-deb` / `workbuddy-darwin-arm64` /
 * `workbuddy-win32-x64-user` …）。猜错时接口返回 404，脚本按「读不到上游」
 * 降级，仍然能靠本机指纹工作。
 */
function guessUpstreamPlatform() {
  if (process.env.WORKBUDDY_WATCH_PLATFORM) return process.env.WORKBUDDY_WATCH_PLATFORM
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') return `workbuddy-darwin-${arch}`
  if (process.platform === 'win32') return `workbuddy-win32-${arch}-user`
  return `workbuddy-linux-${arch}-deb`
}
const UPSTREAM_URL = process.env.WORKBUDDY_WATCH_UPSTREAM
  || `https://www.workbuddy.cn/v2/update?platform=${guessUpstreamPlatform()}`

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}

const MODE_CHECK = flag('--check')            // 只检查，不动 profile
const DRY_RUN = flag('--dry-run')             // 打印动作，不落盘
const NO_NOTIFY = flag('--no-notify')
const NO_UPGRADE = flag('--no-upgrade')       // 不自动升级插件
const ASTATUS = flag('--status')
const ACK = flag('--ack')
const ENABLE = flag('--enable')               // 把 bundle 重新加回（撤销停用）
const DISABLE_NOW = flag('--disable')         // 立刻停用（供插件在用户确认后调用）
const CLEAR_WATERMARK = flag('--clear-watermark')
const SIMULATE_LOCAL = opt('--simulate-local', null)
const SIMULATE_PLUGIN = opt('--simulate-plugin', null)
const PROFILE = opt('--profile', DEFAULT_PROFILE)
const PROFILE_DIR = opt('--profile-dir', join(DSH_HOME, 'profiles', PROFILE))
const STATE = opt('--state-dir', STATE_DIR)
const DISABLE_ON_UPSTREAM = flag('--disable-on-upstream')
  || process.env.WORKBUDDY_WATCH_DISABLE_ON_UPSTREAM === '1'

const STATE_FILE = join(STATE, 'state.json')
const CONFIG_FILE = join(STATE, 'config.json')
const LOG_FILE = join(STATE, 'watch.log')
/** 给 dsh-workbuddy-guard 的指令文件。 */
const GUARD_FILE = join(STATE, 'guard.json')
/** 互斥锁：systemd 定时器与 DSH 内的自动任务可能同一时刻触发。 */
const LOCK_FILE = join(STATE, 'run.lock')
const LOCK_STALE_MS = 5 * 60 * 1000
const NPM_LATEST_URL = `https://registry.npmjs.org/${BUNDLE}/latest`

/**
 * 抢一个以进程存活为判据的锁。
 *
 * 两个执行器（systemd timer 每 3 分钟、DSH 内 schedule 每 3 分钟）撞在一起时，
 * 第二个必须安静退出：并发地读-改-写同一个 profile / 同一个 state.json 会把
 * 两边都写成半成品。锁记录 pid 与启动时间，发现持有者已经不在就抢占。
 */
function acquireLock() {
  try {
    mkdirSync(STATE, { recursive: true })
    const now = Date.now()
    if (existsSync(LOCK_FILE)) {
      const held = readJson(LOCK_FILE, null)
      const age = now - Number(held?.at ?? 0)
      let alive = false
      if (held?.pid && age < LOCK_STALE_MS) {
        try { process.kill(held.pid, 0); alive = true } catch { alive = false }
      }
      if (alive) return { ok: false, holder: held }
      log('warn', `清理过期/僵尸锁（pid ${held?.pid ?? '?'}，age ${Math.round(age / 1000)}s）`)
      rmSync(LOCK_FILE, { force: true })
    }
    writeFileSync(LOCK_FILE, `${JSON.stringify({ pid: process.pid, at: now, argv: argv.slice(0, 4) })}\n`, { mode: 0o600 })
    return { ok: true }
  } catch (error) {
    // 抢不到锁不是失败：宁可跳过这一轮，也不要两条路径同时写文件
    return { ok: false, error: String(error?.message || error) }
  }
}

function releaseLock() {
  try {
    const held = readJson(LOCK_FILE, null)
    if (held?.pid === process.pid) rmSync(LOCK_FILE, { force: true })
  } catch { /* 释放失败留给 stale 清理 */ }
}

/**
 * 生效配置：默认值 ← config.json ← 环境变量/命令行。
 *
 * config.json（不需要就删掉，删掉即回到默认）：
 *   {
 *     "disableOn": "local"      // "local" | "upstream" | "either" | "never"
 *   }
 *
 *   local    —— 只有本机 WorkBuddy 真的升级了才停用（默认，最符合「插件可能被
 *               上游接口变更搞坏」这件事的真实时机）
 *   upstream —— 上游一发新版本就停用（更保守，宁早勿晚）
 *   either   —— 上面任一发生即停用
 *   never    —— 只记录/通知，永不自动改动 profile
 *
 * 环境变量 WORKBUDDY_WATCH_DISABLE_ON_UPSTREAM=1 等价于 disableOn: "either"。
 */
function effectiveConfig() {
  const defaults = { disableOn: 'local', autoDisable: false }
  const fromFile = readJson(CONFIG_FILE, {})
  const disableOn = DISABLE_ON_UPSTREAM
    ? 'either'
    : String(fromFile.disableOn ?? defaults.disableOn)
  const valid = new Set(['local', 'upstream', 'either', 'never'])
  return {
    disableOn: valid.has(disableOn) ? disableOn : defaults.disableOn,
    /**
     * 检测到之后要不要**立刻**停用。
     *
     * 默认 false：检测到只弹提示，由用户在界面上选「软结束 / 硬结束」。
     * 置 true 就回到旧行为（自动停用），留给需要无人值守的场景。
     */
    autoDisable: fromFile.autoDisable === true,
    configFile: CONFIG_FILE,
    configFileExists: existsSync(CONFIG_FILE),
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString()

function log(level, message) {
  const line = `${nowIso()} [${level}] ${message}\n`
  try {
    mkdirSync(STATE, { recursive: true })
    // 每 3 分钟一行，一天 480 行；超过 512KB 就留最后 2000 行重新开始
    try {
      if (statSync(LOG_FILE).size > 512 * 1024) {
        const kept = readFileSync(LOG_FILE, 'utf8').split('\n').slice(-2000).join('\n')
        writeFileSync(LOG_FILE, `${kept}\n`, { mode: 0o600 })
      }
    } catch { /* 日志不存在就算了 */ }
    appendFileSync(LOG_FILE, line, { mode: 0o600 })
  } catch { /* 写日志失败不能拖垮主流程 */ }
  if (process.env.WORKBUDDY_WATCH_VERBOSE === '1') process.stderr.write(line)
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/** 逐段数字比较：a>b 返回 1，相等 0，a<b 返回 -1。非数字段按字符串比较。 */
function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/)
  const pb = String(b).split(/[.-]/)
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i += 1) {
    const x = pa[i] ?? '0'
    const y = pb[i] ?? '0'
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx > ny ? 1 : -1
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

// ---------------------------------------------------------------------------
// 本机 WorkBuddy 指纹
// ---------------------------------------------------------------------------

/** dpkg 记录的版本号（5.6.2）。没装 deb 时返回 null。 */
function readDpkgVersion() {
  try {
    const out = execFileSync('dpkg-query', ['-W', '-f=${Version}', 'workbuddy'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim()
    return out || null
  } catch { return null }
}

/** /opt/WorkBuddy/version —— 这是 Electron 的版本，只做展示。 */
function readElectronVersion() {
  try { return readFileSync(join(APP_DIR, 'version'), 'utf8').trim() || null } catch { return null }
}

/**
 * app.asar 的数据区起点与大小。
 * asar 布局（实测本机这份 317MB 的文件）：
 *   [0..3]   u32 = 4
 *   [4..7]   u32 headerSize   —— 数据区起点 = 8 + headerSize
 *   [8..11]  u32 strLen
 *   [12..15] u32 jsonLen      —— JSON 头从偏移 16 开始，长 jsonLen
 * 注意不能 readFileSync 整个文件（300MB+），一律按需 seek。
 */
function readAsarPackage(asarPath) {
  const head = Buffer.alloc(16)
  const fd = openSync(asarPath, 'r')
  try {
    readSync(fd, head, 0, 16, 0)
    const headerSize = head.readUInt32LE(4)
    const jsonLen = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonLen)
    readSync(fd, json, 0, jsonLen, 16)
    const header = JSON.parse(json.toString('utf8'))
    const entry = header?.files?.['package.json']
    if (!entry) return { version: null, productName: null }
    const buf = Buffer.alloc(Number(entry.size))
    readSync(fd, buf, 0, buf.length, 8 + headerSize + Number(entry.offset))
    const pkg = JSON.parse(buf.toString('utf8'))
    return { version: pkg.version ?? null, productName: pkg.productName ?? null }
  } catch {
    return { version: null, productName: null }
  } finally {
    closeSync(fd)
  }
}

function asarSize(asarPath) {
  try { return statSync(asarPath).size } catch { return null }
}

/**
 * 内置插件清单里的 build id：版本形如
 *   5.6.2-wb.40046327.gc7b525f3.hbf00e3f3d64d
 * 与上游 /v2/update 的 productVersion「5.6.2.40046327」完全同构，
 * 所以是最可靠的「同一构建」判据。
 */
function readBuiltinBuild() {
  const base = join(APP_DIR, 'resources', 'app.asar.unpacked', 'resources', 'plugins', 'workbuddy-builtin')
  const modes = ['plan', 'quick', 'ask', 'expert', 'craft']
  for (const mode of modes) {
    const file = join(base, 'interactionmode', mode, '.workbuddy-plugin', 'plugin.json')
    try {
      const version = String(JSON.parse(readFileSync(file, 'utf8')).version || '')
      const m = version.match(/(\d+\.\d+\.\d+)-wb\.(\d+)/)
      if (m) return { version: `${m[1]}.${m[2]}`, raw: version }
    } catch { /* 试下一个 */ }
  }
  // 兜底：整个 builtin 目录下随便找一个 plugin.json
  return { version: null, raw: null }
}

/** cli/product.json 的 commit，与上游下载文件名里的 hash 前 8 位同源。 */
function readBuildCommit() {
  try {
    const product = JSON.parse(readFileSync(
      join(APP_DIR, 'resources', 'app.asar.unpacked', 'cli', 'product.json'), 'utf8',
    ))
    const commit = typeof product.commit === 'string' ? product.commit : null
    return { commit, commitShort: commit ? commit.slice(0, 8) : null, buildDate: product.date ?? null }
  } catch { return { commit: null, commitShort: null, buildDate: null } }
}

function readLocal() {
  const dpkgVersion = readDpkgVersion()
  const electronVersion = readElectronVersion()
  const asarPath = join(APP_DIR, 'resources', 'app.asar')
  const asar = readAsarPackage(asarPath)
  const asarBytes = asarSize(asarPath)
  const builtin = readBuiltinBuild()
  const build = readBuildCommit()

  // 判定用的版本：优先「与上游同构」的 build id，其次 app.asar 的 version，最后 dpkg
  const version = builtin.version || asar.version || dpkgVersion || electronVersion || 'unknown'
  const display = builtin.version
    ? `${builtin.version}`
    : `${version}${dpkgVersion ? ` (deb ${dpkgVersion})` : ''}`

  const fingerprint = createHash('sha256').update(JSON.stringify([
    dpkgVersion, asar.version, asarBytes, builtin.version, build.commit,
  ])).digest('hex').slice(0, 32)

  return {
    installed: existsSync(asarPath),
    version,
    display,
    dpkgVersion,
    electronVersion,
    asarVersion: asar.version,
    asarSize: asarBytes,
    builtinVersionRaw: builtin.raw,
    commit: build.commit,
    commitShort: build.commitShort,
    buildDate: build.buildDate,
    fingerprint,
  }
}

// ---------------------------------------------------------------------------
// 上游最新版本
// ---------------------------------------------------------------------------
async function readUpstream() {
  try {
    const res = await fetch(UPSTREAM_URL, {
      headers: { 'user-agent': 'dsh-workbuddy-update-watch/1.0' },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    const version = String(body.productVersion || body.version || '')
    if (!version) return { ok: false, error: 'no version field' }
    return {
      ok: true,
      version,
      url: body.url ?? null,
      sha256: body.sha256hash || null,
      publishedAt: body.timestamp ? new Date(body.timestamp * 1000).toISOString() : null,
    }
  } catch (error) {
    return { ok: false, error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error) }
  }
}

/** 事件去重键：同类事件在值没变时只播报一次。 */
function eventKey(event) {
  return `${event.kind}|${event.from}|${event.to}`
}

// ---------------------------------------------------------------------------
// 停用 / 恢复 bundle
// ---------------------------------------------------------------------------
function profileManifestPath() { return join(PROFILE_DIR, 'package.json') }

/**
 * 把 BUNDLE 从 dsh.profile.bundles 里摘掉。
 * 幂等：已经不在里面就返回 changed:false。写前备份、写后回读校验。
 */
function disableBundle({ dryRun }) {
  const manifestPath = profileManifestPath()
  if (!existsSync(manifestPath)) {
    return { changed: false, reason: 'profile-manifest-missing', path: manifestPath }
  }
  const before = readFileSync(manifestPath, 'utf8')
  let manifest
  try { manifest = JSON.parse(before) } catch (error) {
    return { changed: false, reason: `manifest-unparsable: ${error.message}`, path: manifestPath }
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return { changed: false, reason: 'no-bundle-list', path: manifestPath }
  if (!bundles.includes(BUNDLE)) return { changed: false, reason: 'already-disabled', path: manifestPath }

  const next = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: bundles.filter((n) => n !== BUNDLE) } } }
  const after = `${JSON.stringify(next, null, 2)}\n`

  if (dryRun) {
    return { changed: false, wouldChange: true, reason: 'dry-run', path: manifestPath, from: bundles, to: next.dsh.profile.bundles }
  }

  // 备份（保留原始权限 600）
  const backup = join(STATE, `package.json.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(STATE, { recursive: true })
  copyFileSync(manifestPath, backup)

  const tmp = `${manifestPath}.tmp-${process.pid}`
  writeFileSync(tmp, after, { mode: 0o600 })
  renameSync(tmp, manifestPath)

  // 回读校验：真的摘掉了、dependencies 还在
  const check = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const ok = !check?.dsh?.profile?.bundles?.includes(BUNDLE)
    && check?.dependencies?.[BUNDLE] !== undefined
  if (!ok) {
    writeFileSync(manifestPath, before, { mode: 0o600 })
    return { changed: false, reason: 'verify-failed-rolled-back', path: manifestPath, backup }
  }
  return {
    changed: true,
    path: manifestPath,
    from: bundles,
    to: check.dsh.profile.bundles,
    backup,
    keptDependency: check.dependencies[BUNDLE],
    restartRequired: 'HMR 开着通常立即卸载该 bundle；若卡片/模型选择器里仍在，重启 DSH 即可',
  }
}

/**
 * 把 BUNDLE 重新加回 dsh.profile.bundles（幂等）。
 * 依赖必须还在；不在了就明确报错，让用户重新 `dsh plugin add`。
 */
function enableBundle({ dryRun }) {
  const manifestPath = profileManifestPath()
  if (!existsSync(manifestPath)) {
    return { changed: false, reason: 'profile-manifest-missing', path: manifestPath }
  }
  const before = readFileSync(manifestPath, 'utf8')
  let manifest
  try { manifest = JSON.parse(before) } catch (error) {
    return { changed: false, reason: `manifest-unparsable: ${error.message}`, path: manifestPath }
  }
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return { changed: false, reason: 'no-bundle-list', path: manifestPath }
  if (bundles.includes(BUNDLE)) return { changed: false, reason: 'already-enabled', path: manifestPath }
  if (manifest?.dependencies?.[BUNDLE] === undefined) {
    return {
      changed: false,
      reason: 'dependency-missing',
      path: manifestPath,
      hint: `先安装：dsh plugin --profile ${PROFILE} add ${BUNDLE}`,
    }
  }
  if (dryRun) {
    return { changed: false, wouldChange: true, reason: 'dry-run', path: manifestPath, to: [...bundles, BUNDLE] }
  }
  const next = {
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: [...bundles, BUNDLE] } },
  }
  const backup = join(STATE, `package.json.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  mkdirSync(STATE, { recursive: true })
  copyFileSync(manifestPath, backup)
  const tmp = `${manifestPath}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, manifestPath)
  return { changed: true, path: manifestPath, to: next.dsh.profile.bundles, backup, restartRequired: true }
}

// ---------------------------------------------------------------------------
// 插件自身：已安装版本 / npm 最新版 / 自动升级
// ---------------------------------------------------------------------------

/** 从 profile 已安装的包读出 dsh-connect-workbuddy 的版本。 */
/**
 * 本机到底有没有装 `dsh-connect-workbuddy`。
 *
 * 这是整套守卫的前置条件：**没装就什么都不做** —— 不停用、不升级、不挂水印、
 * 不软结束会话，连基线都不写。理由很直接：这个守卫存在的唯一目的是替一个
 * 正在被使用的危险插件踩刹车；刹车片装在一辆不存在的车上没有意义，而且
 * 「自动升级 dsh-connect-workbuddy」在没有装它的时候会变成**凭空安装**，
 * 那是另一种越权。
 *
 * 「装了」的判据是**磁盘上有这个包**（node_modules/<pkg>/package.json），
 * 不是「bundle 被选中」：守卫自己会把它停用（从 bundles 里摘掉），那时它
 * 仍然是「已安装、只是停用」，必须继续认得它，否则第二次检查就再也不会
 * 恢复判断了。
 */
function isGuardTargetInstalled() {
  const pkgPath = join(PROFILE_DIR, 'node_modules', BUNDLE, 'package.json')
  const pkg = readJson(pkgPath, null)
  if (pkg?.version) {
    return { installed: true, evidence: `node_modules/${BUNDLE}@${pkg.version}`, version: pkg.version }
  }
  // 包目录不在，但依赖声明还在：装了一半 / 被 remove 过 —— 当作没装
  const manifest = readJson(profileManifestPath(), {})
  const declared = manifest?.dependencies?.[BUNDLE]
  return {
    installed: false,
    evidence: declared ? `dependency declared (${declared}) but package missing on disk` : 'not declared and not on disk',
    declared: declared ?? null,
  }
}

function readInstalledPlugin() {
  const manifestPath = join(PROFILE_DIR, 'node_modules', BUNDLE, 'package.json')
  const pkg = readJson(manifestPath, null)
  if (pkg?.version) return { version: pkg.version, path: manifestPath }
  // 包不在但依赖声明还在：说明被 remove 过，报声明里的范围
  const manifest = readJson(profileManifestPath(), {})
  const declared = manifest?.dependencies?.[BUNDLE]
  return { version: null, declared: declared ?? null, path: manifestPath }
}

/** npm 上的 latest。失败返回 ok:false，不抛。 */
async function readPluginLatest() {
  try {
    const res = await fetch(NPM_LATEST_URL, {
      headers: { accept: 'application/json', 'user-agent': 'dsh-workbuddy-update-watch/1.1' },
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    const version = String(body?.version || '')
    if (!version) return { ok: false, error: 'no version field' }
    return { ok: true, version, tarball: body?.dist?.tarball ?? null, publishedAt: null }
  } catch (error) {
    return { ok: false, error: error?.name === 'TimeoutError' ? 'timeout' : String(error?.message || error) }
  }
}

/**
 * 用 dsh CLI 升级插件。
 *
 * 走 `dsh plugin --profile <p> add <pkg>@<ver>` 而不是自己跑 pnpm：这条命令就是
 * profile 的包管理器入口，它在装完之后会做 reconcile（把新 bundle 补回
 * dsh.profile.bundles），手写 pnpm 会漏掉那一步。
 *
 * **不动 bundles 列表**：升级不等于启用。如果它已经被停用，升级完仍然是停用，
 * 否则「升级」会顺手把刚刚停用的东西又打开。
 *
 * 两个已知的 pnpm 环境陷阱，都重试一次：
 *   - ERR_PNPM_UNEXPECTED_STORE：node_modules 与当前 pnpm 认定的 store 不在
 *     一起（把 profile 搬过机器、或 DSH_HOME 换了位置）。这时按 profile 里
 *     记录的 store 重指一次。
 *   - 安装成功后版本号没变：minimumReleaseAge / 缓存导致的滞后，重读一次。
 */
/**
 * profile 的 node_modules 实际链接自哪个 pnpm store。
 *
 * pnpm 把这件事记在 `node_modules/.modules.yaml` 的 `storeDir`。升级时读到它
 * 就能避免 `ERR_PNPM_UNEXPECTED_STORE` —— 那个错误来自「pnpm 现在认定的 store
 * 与 node_modules 的来源不一致」，而 pnpm 自己写下的事实比它重新推断的更可靠。
 */
function detectPnpmStore() {
  const file = join(PROFILE_DIR, 'node_modules', '.modules.yaml')
  try {
    // 该文件是「带引号的 JSON 风格 YAML」，行形如：
    //   "storeDir": "/home/eaton/.local/share/pnpm/store/v10",
    // 不要给正则加行尾锚点：结尾还有引号与逗号。
    const text = readFileSync(file, 'utf8')
    const line = text.split('\n').find((l) => l.includes('storeDir'))
    if (!line) return null
    const m = line.match(/"?storeDir"?\s*:\s*"?([^",\r\n]+)/)
    return m ? m[1].trim() : null
  } catch { return null }
}

function upgradePlugin(targetVersion, { dryRun }) {
  const spec = `${BUNDLE}@${targetVersion}`
  const command = `dsh plugin --profile ${PROFILE} add ${spec}`
  if (dryRun) return { upgraded: false, wouldUpgrade: true, spec, command }

  const run = () => execFileSync('dsh', ['plugin', '--profile', PROFILE, 'add', spec], {
    encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME },
  })

  let lastError = null
  let storePin = null
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const out = run()
      const after = readInstalledPlugin()
      if (after.version === targetVersion) {
        log('warn', `插件升级 ${spec} → 已安装 ${after.version}`)
        return { upgraded: true, spec, installed: after.version, command, storePin, output: out.slice(-2000) }
      }
      lastError = `命令成功但版本仍是 ${after.version ?? '未知'}`
      log('warn', `插件升级：${lastError}`)
      break
    } catch (error) {
      lastError = String(error?.message || error)
      const logPath = String(error?.stderr || '').match(/diagnostics: (\S+)/)?.[1]
      let detail = ''
      try { detail = logPath ? readFileSync(logPath, 'utf8') : '' } catch { /* 没日志 */ }
      const storeIssue = /ERR_PNPM_UNEXPECTED_STORE/.test(detail)
      log('warn', `插件升级第 ${attempt} 次失败${storeIssue ? '（pnpm store 错配）' : ''}: ${lastError}`)
      if (!storeIssue || attempt === 2) break
      // 把 pnpm 自己记录的 store 写进 profile 的 .npmrc，再试一次
      storePin = detectPnpmStore()
      if (storePin === null) {
        log('warn', '读不到 .modules.yaml 的 storeDir，无法自动修复 store 错配')
        break
      }
      try {
        const npmrc = join(PROFILE_DIR, '.npmrc')
        const existing = existsSync(npmrc) ? readFileSync(npmrc, 'utf8') : ''
        if (!/^store-dir=/m.test(existing)) {
          writeFileSync(npmrc, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}store-dir=${storePin}\n`, { mode: 0o600 })
          log('warn', `已把 store-dir=${storePin} 写入 profile 的 .npmrc，重试`)
        }
      } catch (writeError) {
        log('warn', `写 .npmrc 失败: ${String(writeError?.message || writeError)}`)
        break
      }
    }
  }
  return { upgraded: false, spec, command, storePin, error: lastError }
}

// ---------------------------------------------------------------------------
// 指令文件（与 dsh-workbuddy-guard 的契约）
// ---------------------------------------------------------------------------

function readGuardFile() {
  return readJson(GUARD_FILE, { schema: 1, revision: 0, watermark: null, stopSessions: null })
}

/**
 * 更新水印。会抬升 revision，插件据此只重推一次。
 * `watermark = null` 表示清除。
 */
function updateWatermark(watermark) {
  const previous = readGuardFile()
  const next = {
    ...previous,
    schema: 1,
    revision: (Number(previous.revision) || 0) + 1,
    watermark: watermark === null ? null : { ...watermark, at: nowIso() },
  }
  writeJsonAtomic(GUARD_FILE, next)
  return next.revision
}

/**
 * 下发一次「软结束会话」指令。
 *
 * 一次更新只该出现一条这样的指令：反复下发会让每条在用 workbuddy 的会话
 * 每 3 分钟被插一条消息。所以指令的 identity 是「本机版本变化」这件事本身，
 * 同一个 from→to 只发一次。
 */
function issueStopSessions(reason, text, from, to) {
  const previous = readGuardFile()
  const next = {
    ...previous,
    schema: 1,
    revision: (Number(previous.revision) || 0) + 1,
    stopSessions: {
      revision: (Number(previous.revision) || 0) + 1,
      reason,
      text,
      from,
      to,
      issuedAt: nowIso(),
    },
  }
  writeJsonAtomic(GUARD_FILE, next)
  return next.revision
}

// ---------------------------------------------------------------------------
// 通知
// ---------------------------------------------------------------------------
/**
 * 桌面通知。三个平台三套命令，找不到就安静降级 ——
 * 通知只是「顺手的提醒」，失败绝不能影响停用与写指令。
 */
function notify(title, body) {
  if (NO_NOTIFY) return false
  try {
    if (process.platform === 'darwin') {
      execFileSync('/usr/bin/osascript', [
        '-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`,
      ], { stdio: 'ignore', timeout: 5000 })
      return true
    }
    if (process.platform === 'win32') {
      // PowerShell 的 BurntToast 不保证存在，用最朴素的 balloon 方案会弹注册表，
      // 这里只写事件日志，交给 guard.json 的水印去呈现
      log('info', `通知（Windows 无原生通道，已跳过）: ${title} — ${body.replace(/\n/g, ' / ')}`)
      return false
    }
    const notifySend = ['/usr/bin/notify-send', '/usr/local/bin/notify-send'].find((p) => existsSync(p))
    if (notifySend === undefined) return false
    execFileSync(notifySend, ['-a', 'WorkBuddy 版本守卫', '-u', 'critical', '-t', '0', title, body], {
      stdio: 'ignore', timeout: 5000,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
    })
    return true
  } catch (error) {
    log('warn', `桌面通知失败: ${error?.message || error}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  mkdirSync(STATE, { recursive: true })
  const state = readJson(STATE_FILE, { schema: SCHEMA })

  // ---- 前置条件：没有这个插件就什么都不做 --------------------------------
  const target = isGuardTargetInstalled()

  // --enable 是例外：它可能在「包被卸了但 bundles 还残留」时需要收尾，
  // 让 enableBundle 自己报 dependency-missing，而不是被这里静默跳过。
  if (!target.installed && !ENABLE) {
    if (ASTATUS) {
      return {
        mode: 'status',
        targetInstalled: false,
        targetEvidence: target.evidence,
        local: readLocal().display,
        guardFile: GUARD_FILE,
        stateFile: STATE_FILE,
        note: `${BUNDLE} 未安装 —— 守卫不执行任何动作`,
      }
    }
    // 其它模式（含定时）一律安静退出：不写 state，不建基线，不碰 profile
    log('info', `${BUNDLE} 未安装（${target.evidence}），跳过本次检查`)
    return {
      mode: 'skipped',
      reason: 'target-not-installed',
      target: BUNDLE,
      evidence: target.evidence,
      note: `未安装 ${BUNDLE}，未做任何操作`,
    }
  }

  // 只读模式不抢锁：--status / --ack / --clear-watermark 不该因为另一条路径
  // 正在跑就被拒掉，它们也不写 profile。
  const needsLock = !ASTATUS && !ACK && !CLEAR_WATERMARK
  if (needsLock) {
    const lock = acquireLock()
    if (!lock.ok) {
      log('info', `另一条执行路径正在跑（${JSON.stringify(lock.holder ?? lock.error)}），本轮跳过`)
      return { mode: 'skipped', reason: 'locked', holder: lock.holder ?? lock.error ?? null }
    }
  }

  // --status / --ack 不联网、不检查
  if (ASTATUS) {
    const local = readLocal()
    const plugin = readInstalledPlugin()
    const guard = readGuardFile()
    return {
      mode: 'status',
      stateFile: STATE_FILE,
      logFile: LOG_FILE,
      guardFile: GUARD_FILE,
      profileManifest: profileManifestPath(),
      bundleSelected: bundleSelected(),
      local: local.display,
      pluginInstalled: plugin.version,
      pluginDeclared: plugin.declared ?? null,
      upstreamSeen: state.upstreamSeen?.version ?? null,
      pluginSeen: state.pluginSeen?.version ?? null,
      watermark: guard.watermark ? { title: guard.watermark.title, body: guard.watermark.body, at: guard.watermark.at } : null,
      pendingStop: guard.stopSessions && !guard.stopSessions.handled ? guard.stopSessions.revision : null,
      disabled: state.disabled ?? null,
      pendingReport: (state.pendingReport ?? []).length,
      checks: state.checks ?? 0,
      lastCheckAt: state.lastCheckAt ?? null,
    }
  }
  if (ACK) {
    const n = (state.pendingReport ?? []).length
    state.pendingReport = []
    writeJsonAtomic(STATE_FILE, state)
    log('info', `已把 ${n} 条待播报事件标记为已播报`)
    return { mode: 'ack', acked: n }
  }
  if (CLEAR_WATERMARK) {
    const revision = updateWatermark(null)
    log('warn', `已清除界面水印（revision ${revision}）`)
    return { mode: 'clear-watermark', revision }
  }
  if (ENABLE) {
    const result = enableBundle({ dryRun: DRY_RUN })
    if (result.changed && !DRY_RUN) {
      state.disabled = null
      state.reportedKeys = []
      updateWatermark(null)
      log('warn', `已重新启用 ${BUNDLE}，清空事件去重记录并清除水印`)
      writeJsonAtomic(STATE_FILE, state)
    }
    return { mode: 'enable', changed: result.changed, result }
  }
  /**
   * `--disable`：**只**停用，不做任何检测。
   *
   * 这是给插件用的：用户在界面上点了「软结束」或「硬结束」，Host 半已经处理完
   * 会话，再派这一点命令把 bundle 摘掉。之所以仍然由脚本写 profile，是为了保持
   * 「profile 只有一个写者」这条约束（否则插件与脚本会并发改同一个 package.json）。
   */
  if (DISABLE_NOW) {
    const result = disableBundle({ dryRun: DRY_RUN })
    if (result.changed && !DRY_RUN) {
      state.disabled = {
        at: nowIso(),
        bundle: BUNDLE,
        reason: 'user-confirmed',
        from: state.baseline?.display ?? null,
        to: null,
        backup: result.backup,
        restore: `node ${process.argv[1]} --enable   # 或把 "${BUNDLE}" 加回 profile 的 dsh.profile.bundles`,
      }
      writeJsonAtomic(STATE_FILE, state)
      log('warn', `按用户确认停用 ${BUNDLE}（备份 ${result.backup}）`)
    } else {
      log('info', `停用请求未做改动: ${result.reason}${result.wouldChange ? '（dry-run）' : ''}`)
    }
    return { mode: 'disable', changed: result.changed, result }
  }

  const local = readLocal()
  const simulated = SIMULATE_LOCAL !== null
  if (simulated) {
    local.fingerprint = `simulated:${SIMULATE_LOCAL}`
    local.version = SIMULATE_LOCAL
    local.display = `${SIMULATE_LOCAL} (模拟)`
    log('warn', `演练模式：把本机版本当成 ${SIMULATE_LOCAL}`)
  }

  const upstream = await readUpstream()
  const config = effectiveConfig()
  const disableLocal = config.disableOn === 'local' || config.disableOn === 'either'
  const disableUpstream = config.disableOn === 'upstream' || config.disableOn === 'either'

  const events = []
  const firstRun = !state.baseline
  const reported = new Set(state.reportedKeys ?? [])

  /** 加一条事件，但 same kind+from+to 已经报过就不再报。 */
  const pushEvent = (event) => {
    const key = eventKey(event)
    if (reported.has(key)) {
      log('info', `事件 ${key} 已经播报过，跳过`)
      return false
    }
    reported.add(key)
    events.push(event)
    return true
  }

  // 1) 本机安装变了 —— 默认的停用触发器
  if (!firstRun && state.baseline.fingerprint !== local.fingerprint) {
    const fresh = pushEvent({
      at: nowIso(),
      kind: 'local-updated',
      from: state.baseline.display,
      to: local.display,
      action: disableLocal ? 'disable-bundle' : 'report-only',
    })
    if (fresh) log('warn', `本机 WorkBuddy 指纹变化: ${state.baseline.display} → ${local.display}`)
  }

  // 2) 上游发了新版本 —— 默认只播报，disableOn 含 upstream 时才停用
  let upstreamNewer = false
  if (upstream.ok) {
    const seen = state.upstreamSeen?.version
    if (seen && upstream.version !== seen) {
      const cmp = compareVersions(upstream.version, local.version)
      if (cmp > 0) {
        upstreamNewer = true
        pushEvent({
          at: nowIso(),
          kind: 'upstream-newer',
          from: seen,
          to: upstream.version,
          local: local.version,
          action: disableUpstream ? 'disable-bundle' : 'report-only',
          url: upstream.url,
        })
        log('info', `上游发布了新版本 ${upstream.version}（本机 ${local.version}）`)
      } else if (cmp < 0) {
        log('info', `上游 ${upstream.version} 落后于本机 ${local.version}（测试版或镜像滞后），忽略`)
      }
    }
  } else {
    log('warn', `读取上游版本失败: ${upstream.error}`)
  }

  // 3) 插件自身版本 —— 有新版就地升级，并挂「重启生效」水印
  const pluginBefore = readInstalledPlugin()
  let pluginLatest = { ok: false, error: 'disabled' }
  if (!NO_UPGRADE) pluginLatest = await readPluginLatest()

  let pluginUpgrade = null
  let pluginNewer = false
  let PLUGIN_UNKNOWN_REASON = null
  const installedVersion = SIMULATE_PLUGIN !== null ? SIMULATE_PLUGIN : pluginBefore.version
  if (installedVersion === null || installedVersion === undefined) {
    PLUGIN_UNKNOWN_REASON = `读不到已安装版本（${pluginBefore.path}）`
  }
  if (pluginLatest.ok && installedVersion !== null && installedVersion !== undefined) {
    const cmp = compareVersions(pluginLatest.version, installedVersion)
    if (cmp > 0) {
      pluginNewer = true
      pushEvent({
        at: nowIso(),
        kind: 'plugin-newer',
        from: installedVersion,
        to: pluginLatest.version,
        action: 'upgrade-plugin',
      })
      log('info', `插件有新版本 ${pluginLatest.version}（已安装 ${installedVersion}）`)
      if (!MODE_CHECK) {
        pluginUpgrade = upgradePlugin(pluginLatest.version, { dryRun: DRY_RUN })
        if (pluginUpgrade.upgraded) {
          // 升级后**不**自动启用：升级不等于启用。已经停用的仍然是停用的。
          //
          // `untilRestart: true` 是这条水印的全部要点：它提示的「重启 DSH 生效」
          // 在重启之后就自动失效了，所以插件半会在下一次启动时把它清掉
          // （判据是 at < 进程启动时刻，见 index.js 的 isStaleUntilRestart）。
          // 危险的红色水印不带这个字段，它必须一直留到你 --enable 为止。
          const revision = updateWatermark({
            level: 'warning',
            title: '插件已升级',
            body: '重启 DSH 生效。',
            detail: `${BUNDLE} ${installedVersion} → ${pluginLatest.version}${bundleSelected() ? '' : '（bundle 仍处于停用状态）'}`,
            untilRestart: true,
          })
          log('warn', `插件已升级到 ${pluginLatest.version}，水印 revision ${revision}（重启后自动清除）`)
        }
      }
    } else if (cmp < 0) {
      log('info', `已安装插件 ${installedVersion} 比 npm latest ${pluginLatest.version} 更新（预发布/本地版），忽略`)
    }
  } else if (PLUGIN_UNKNOWN_REASON !== null) {
    log('warn', `插件版本检查跳过: ${PLUGIN_UNKNOWN_REASON}`)
  } else if (!pluginLatest.ok && !NO_UPGRADE) {
    log('warn', `读取插件最新版失败: ${pluginLatest.error}`)
  }

  // 4) 决定要不要停用
  const triggers = events.filter((e) => e.action === 'disable-bundle')
  let disableResult = null
  let pendingDisable = false
  if (triggers.length > 0 && !MODE_CHECK) {
    const trigger = triggers[0]
    if (config.autoDisable) {
      // 无人值守模式：检测到就当场停用（旧行为）
      disableResult = disableBundle({ dryRun: DRY_RUN })
      log(disableResult.changed ? 'warn' : 'info',
        disableResult.changed
          ? `已停用 ${BUNDLE}（备份 ${disableResult.backup}）`
          : `未改动 ${BUNDLE}: ${disableResult.reason}${disableResult.wouldChange ? '（dry-run）' : ''}`)

      if (disableResult.changed) {
        updateWatermark({
          level: 'danger',
          title: 'WB 更新了',
          body: '还用，你的账号是批发的吗？',
          detail: `${trigger.from} → ${trigger.to} · ${BUNDLE} 已停用`,
        })
        issueStopSessions(
          `本机 WorkBuddy 已更新（${trigger.from} → ${trigger.to}），${BUNDLE} 已停用`,
          STOP_TEXT,
          trigger.from,
          trigger.to,
        )
        log('warn', '已写水印与软结束指令，等待 guard 插件下发到界面与会话')
      }
    } else {
      /**
       * 默认路径：**只报警，不动手**。
       *
       * 检测到本机 WB 变了，把「该停用了」这件事写进水印，由用户在界面上选
       * 「软结束」或「硬结束」。守卫不再替用户决定什么时候掐断他的会话——
       * 一个正在跑的任务被自动中止，比晚几秒停用糟糕得多。
       *
       * 水印上带 `pendingDisable` 与 `actions`，浏览器半据此画出三个按钮。
       */
      pendingDisable = true
      updateWatermark({
        level: 'danger',
        title: 'WB 更新了',
        body: '还用，你的账号是批发的吗？',
        detail: `${trigger.from} → ${trigger.to}`,
        pendingDisable: true,
        actions: ['soft', 'hard'],
        from: trigger.from,
        to: trigger.to,
      })
      log('warn', `检测到本机 WorkBuddy 更新（${trigger.from} → ${trigger.to}），已挂提示，等待用户选择软结束/硬结束`)
    }
  } else if (triggers.length > 0 && MODE_CHECK) {
    log('info', `--check 模式：命中 ${triggers.length} 个停用条件，但不修改 profile`)
  }

  // 4) 记录状态
  if (!DRY_RUN) {
    state.schema = SCHEMA
    /**
     * 演练模式**不写基线**。
     *
     * 基线是「这台机器上次见到的真实安装」。把 `simulated:9.9.9` 写进去之后，
     * 下一轮真实检查会看到指纹从模拟值变回真值，于是又报一次「本机更新」，
     * 在 reportedKeys 里留下一条假事件——测试本身污染了被测对象。
     * 演练要的是「走一遍动作」，不是「改写历史」。
     */
    if (!simulated) {
      state.baseline = {
        fingerprint: local.fingerprint,
        version: local.version,
        display: local.display,
        dpkgVersion: local.dpkgVersion,
        builtinVersionRaw: local.builtinVersionRaw,
        commit: local.commit,
        asarSize: local.asarSize,
        capturedAt: state.baseline?.capturedAt ?? nowIso(),
        updatedAt: nowIso(),
      }
    } else {
      log('info', '演练模式：不更新基线指纹（避免污染下一轮真实检查）')
    }
    if (upstream.ok) {
      state.upstreamSeen = {
        version: upstream.version,
        url: upstream.url,
        firstSeenAt: state.upstreamSeen?.firstSeenAt ?? nowIso(),
        updatedAt: nowIso(),
      }
    }
    if (pluginLatest.ok) {
      state.pluginSeen = {
        version: pluginLatest.version,
        firstSeenAt: state.pluginSeen?.firstSeenAt ?? nowIso(),
        updatedAt: nowIso(),
      }
    }
    if (pluginUpgrade?.upgraded) {
      state.pluginUpgraded = {
        at: nowIso(),
        from: installedVersion,
        to: pluginLatest.version,
        command: pluginUpgrade.command,
      }
    }
    if (events.length > 0) {
      state.pendingReport = [...(state.pendingReport ?? []), ...events].slice(-20)
    }
    state.reportedKeys = [...reported].slice(-100)
    if (disableResult?.changed) {
      state.disabled = {
        at: nowIso(),
        bundle: BUNDLE,
        reason: triggers.map((t) => t.kind).join(','),
        from: triggers[0].from,
        to: triggers[0].to,
        backup: disableResult.backup,
        restore: `node ${process.argv[1]} --enable   # 或把 "${BUNDLE}" 加回 profile 的 dsh.profile.bundles`,
      }
    }
    state.checks = (state.checks ?? 0) + 1
    state.lastCheckAt = nowIso()
    state.lastUpstreamError = upstream.ok ? null : upstream.error
    state.lastPluginError = pluginLatest.ok || NO_UPGRADE ? null : pluginLatest.error
    writeJsonAtomic(STATE_FILE, state)
    log('info', `检查 #${state.checks}：本机 ${local.display}，上游 ${upstream.ok ? upstream.version : `读取失败(${upstream.error})`}，插件 ${installedVersion ?? '?'}${pluginLatest.ok ? `(latest ${pluginLatest.version})` : ''}，事件 ${events.length} 个`)
  }

  // 5) 通知（只在真的停用、待用户确认、或明确要求播报上游新版时弹）
  if (pendingDisable) {
    notify('WorkBuddy 更新了 —— 等待你选择',
      `${triggers[0].from} → ${triggers[0].to}\n插件还在运行；到界面上选「软结束」或「硬结束」。`)
  } else if (disableResult?.changed) {
    notify('WorkBuddy 已更新 —— 插件已停用',
      `${triggers[0].from} → ${triggers[0].to}\n已停用 ${BUNDLE}；界面已挂水印，正在用它的会话已被软结束。\n恢复：node ${process.argv[1]} --enable`)
  } else if (pluginUpgrade?.upgraded) {
    notify('WorkBuddy 插件已升级', `${installedVersion} → ${pluginLatest.version}\n重启 DSH 生效。`)
  } else if (upstreamNewer && !MODE_CHECK) {
    notify('WorkBuddy 上游有新版本', `${upstream.version}（本机 ${local.version}）—— 插件仍启用；升级本机后会自动停用`)
  }

  return {
    mode: DRY_RUN ? 'dry-run' : (MODE_CHECK ? 'check' : 'watch'),
    checkedAt: nowIso(),
    firstRun,
    local: {
      display: local.display,
      version: local.version,
      dpkgVersion: local.dpkgVersion,
      asarVersion: local.asarVersion,
      commitShort: local.commitShort,
      electronVersion: local.electronVersion,
      fingerprint: local.fingerprint,
    },
    upstream: upstream.ok
      ? { version: upstream.version, publishedAt: upstream.publishedAt, url: upstream.url }
      : { error: upstream.error },
    plugin: {
      installed: installedVersion ?? null,
      declared: pluginBefore.declared ?? null,
      latest: pluginLatest.ok ? pluginLatest.version : null,
      newer: pluginNewer,
      upgrade: pluginUpgrade,
      error: pluginLatest.ok ? null : (NO_UPGRADE ? 'disabled' : pluginLatest.error),
    },
    upstreamNewer,
    events,
    changed: events.length > 0,
    disabled: disableResult?.changed ?? false,
    pendingDisable,
    disableResult,
    bundleSelected: bundleSelected(),
    pendingReport: (state.pendingReport ?? []).length,
    note: events.length === 0
      ? '无变化'
      : (disableResult?.changed
        ? `已停用 ${BUNDLE}，已挂水印并下发软结束指令`
        : (pluginUpgrade?.upgraded ? '插件已升级，已挂重启水印' : '见 disableResult/plugin')),
  }
}

/** 当前 profile 是否还选着这个 bundle（只读）。 */
function bundleSelected() {
  try {
    const manifest = JSON.parse(readFileSync(profileManifestPath(), 'utf8'))
    return Boolean(manifest?.dsh?.profile?.bundles?.includes(BUNDLE))
  } catch { return null }
}

try {
  const result = await main()
  releaseLock()
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exit(0)
} catch (error) {
  log('error', `未捕获异常: ${error?.stack || error}`)
  releaseLock()
  process.stdout.write(`${JSON.stringify({ mode: 'error', error: String(error?.message || error) })}\n`)
  process.exit(1)
}
