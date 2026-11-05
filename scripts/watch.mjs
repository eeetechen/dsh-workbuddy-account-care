#!/usr/bin/env node
/**
 * dsh-workbuddy 账号呵护 (WorkBuddy Account Care)
 * ---------------------------------------------------------------------------
 * 每 3 分钟问一次 WorkBuddy 官方的版本接口。只要接口给的版本号和本地记录的
 * 基点版本号对不上，就认为「客户端已经更新」，于是挂水印 / 停用 bundle
 * `dsh-connect-workbuddy` / 弹桌面通知。
 *
 * 唯一数据源：`https://www.workbuddy.cn/v2/update?platform=<platform>`
 *   从响应里取出两个版本号，**取高者**作为判定依据：
 *     1. `productVersion`（形如 5.9.3.42398134）—— 接口自己报的
 *     2. `url` 的文件名里的版本号 —— 例如
 *        …/darwin-x64/WorkBuddy-darwin-x64-5.9.3.42398134-d4692421.dmg
 *        只切字符串解析文件名，**不下载**（见 parseDownloadFilename）。
 *   两个数不一致时不投票：谁高按谁算，低的那个记一条日志。
 *   可用 WORKBUDDY_WATCH_UPSTREAM（整个 URL）或 WORKBUDDY_WATCH_PLATFORM 覆盖。
 *
 * **刻意不读本机安装**。
 *   早先的判据是扫描 app.asar / 内置插件 build id / cli/product.json 拼成一个
 *   指纹，问题有两个：一是每个平台的安装布局不一样（deb 在 /opt，macOS 在
 *   .app/Contents），漏读就静默降级；二是「同版本重装、asar 大小变了一点」这种
 *   与版本无关的改动也会触发。现在判据只有一个数字：判定版本 ≠ 记录版本。
 *   代价是：读不到接口就无法判定——本轮直接跳过，绝不猜、绝不误停用。
 *
 * 基点（baseline）与重锚：
 *   state.json 的 `baseline.version`。没有基线时（首轮、或 state.json 被删）
 *   直接落基线、不报警；之后每轮把基线推进到接口当前值，所以同一个版本上
 *   不会反复弹提示。要重新落基点，删掉 state.json 里的 baseline 即可。
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
 * `dsh-workbuddy-account-care` 读取：
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
 *   node workbuddy-update-watch.mjs --simulate-version 9.9.9.999  # 把接口版本当成它（测试用）
 *   node workbuddy-update-watch.mjs --simulate-plugin 9.9.9      # 测试用
 *   node workbuddy-update-watch.mjs --clear-watermark            # 手动清水印
 *   附加：--no-notify  --no-upgrade  --state-dir <dir>  --profile <name>  --profile-dir <dir>
 *
 * 输出：一行 JSON（便于定时任务/agent 解析），细节都写进 watch.log。
 * 退出码：0 正常（含「无更新」）；1 运行出错（网络错误不算错，只降级）。
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync,
  readFileSync, renameSync, rmSync, statSync, writeFileSync,
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
const STOP_TEXT = '本机 provider 已更新，本条消息由监控插件自动发送，收到后暂停你的所有任务, 等待重启 agent 工具'
const HOME = process.env.HOME || process.env.USERPROFILE || homedir()
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh')
const STATE_DIR = join(DSH_HOME, 'workbuddy-update-watch')
const DEFAULT_PROFILE = process.env.DSH_PROFILE || 'web'

/**
 * 上游版本接口的 platform 标识。
 *
 * 这是 WorkBuddy 官网下载页自己用的那套名字（见它的 download-*.js：
 * `workbuddy-linux-x64-deb` / `workbuddy-darwin-arm64` /
 * `workbuddy-win32-x64-user` …）。猜错时接口返回 404，脚本按「读不到接口」
 * 降级：本轮不判定、不改配置，只在日志里记一条。
 */
function guessUpstreamPlatform() {
  if (process.env.WORKBUDDY_WATCH_PLATFORM) return process.env.WORKBUDDY_WATCH_PLATFORM
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') return `workbuddy-darwin-${arch}`
  if (process.platform === 'win32') return `workbuddy-win32-${arch}-user`
  return `workbuddy-linux-${arch}-deb`
}
/**
 * 本机对应的平台标识，同时也是**判定作用域**。
 *
 * 这条很要紧：官方各平台不是同步发版的（实测 macOS/Windows 在 5.9.3，
 * Linux 全线还停在 5.6.2）。所以「版本号」只有在同一个 platform 下才有可比性，
 * 换一个 platform 去比，等于拿两个产品的版本号对撞。
 */
const PLATFORM_ID = guessUpstreamPlatform()
const UPSTREAM_URL = process.env.WORKBUDDY_WATCH_UPSTREAM
  || `https://www.workbuddy.cn/v2/update?platform=${PLATFORM_ID}`

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
/**
 * 演练：把**接口返回的版本**当成这个值，用来在不改任何真实状态的前提下走一遍
 * 「检测到不一致 → 挂提示」的完整链路。
 *
 * `--simulate-local` 是历史名字（那时判定还在读本机安装），保留为别名。
 */
const SIMULATE_VERSION = opt('--simulate-version', null) ?? opt('--simulate-local', null)
/**
 * 演练：把接口返回的下载链接换成这个，用来看「文件名里的版本」那一路解析得对不对。
 * 显式给一个和 --simulate-version 不一致的链接，就能验证「取高者」的分支。
 */
const SIMULATE_URL = opt('--simulate-url', null)
const SIMULATE_PLUGIN = opt('--simulate-plugin', null)
const PROFILE = opt('--profile', DEFAULT_PROFILE)
const PROFILE_DIR = opt('--profile-dir', join(DSH_HOME, 'profiles', PROFILE))
const STATE = opt('--state-dir', STATE_DIR)
const DISABLE_ON_UPSTREAM = flag('--disable-on-upstream')
  || process.env.WORKBUDDY_WATCH_DISABLE_ON_UPSTREAM === '1'

const STATE_FILE = join(STATE, 'state.json')
const CONFIG_FILE = join(STATE, 'config.json')
const LOG_FILE = join(STATE, 'watch.log')
/** 给 dsh-workbuddy-account-care 的指令文件。 */
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
 *     "disableOn": "local",     // 兼容旧键，见下
 *     "autoDisable": false      // 检测到就立刻停用（无人值守）
 *   }
 *
 * `disableOn` 是「判定源」时代的产物，那时有两个触发器（本机安装 / 上游发布）。
 * 现在判定只剩一条规则（接口版本 ≠ 记录版本），所以：
 *   "never"  —— 仍然有效：命中只挂提示，永不自动改 profile
 *   其它值   —— 视为默认（命中即视为停用条件，要不要当场停用由 autoDisable 决定）
 * 环境变量 WORKBUDDY_WATCH_DISABLE_ON_UPSTREAM=1 也仍然被当作「启用停用条件」。
 */
function effectiveConfig() {
  const defaults = { disableOn: 'local', autoDisable: false }
  const fromFile = readJson(CONFIG_FILE, {})
  const disableOn = DISABLE_ON_UPSTREAM
    ? 'either'
    : String(fromFile.disableOn ?? defaults.disableOn)
  const valid = new Set(['local', 'upstream', 'either', 'never'])
  return {
    /** 命中版本不一致时，这条事件算不算「停用条件」。 */
    disableOnHit: (valid.has(disableOn) ? disableOn : defaults.disableOn) !== 'never',
    /**
     * 检测到之后要不要**立刻**停用。
     *
     * 默认 false：检测到只弹提示，由用户在界面上选「软结束 / 硬结束」。
     * 置 true 就回到旧行为（自动停用），留给需要无人值守的场景。
     */
    autoDisable: fromFile.autoDisable === true,
    rawDisableOn: disableOn,
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

// ---------------------------------------------------------------------------
// 下载链接：只解析文件名里的版本号，绝不下载
// ---------------------------------------------------------------------------

/**
 * 本机的「文件名平台串」，例如 darwin-x64 / linux-x64 / win32-x64。
 *
 * 上游的平台标识是 `workbuddy-darwin-x64` / `workbuddy-linux-x64-deb` /
 * `workbuddy-win32-x64-user`，而安装包文件名里只带 `darwin-x64` 这一段。
 * 剥掉前缀和后缀，两者才能对上。
 */
function expectedFilenamePlatform() {
  const m = guessUpstreamPlatform().toLowerCase().match(/^workbuddy-([a-z0-9]+-[a-z0-9]+)/)
  return m ? m[1] : null
}

/**
 * 从下载链接里取出文件名与版本号。
 *
 * **纯字符串处理**：不发请求、不读文件、不校验 sha256。这个守卫每 3 分钟跑
 * 一次，为了「确认自己没看错」去拖 180MB 的安装包显然不合理；而文件名本身
 * 就是发布流水线的产物，格式稳定（实测两个平台都是这个形状）：
 *
 *   …/workbuddy/saas/darwin-x64/WorkBuddy-darwin-x64-5.9.3.42398134-d4692421.dmg
 *   …/workbuddy/saas/darwin-x64/WorkBuddy-darwin-x64-5.9.3.42398134-d4692421.zip
 *                                   └── 平台 ──┘ └─── 版本 ───┘ └ 构建 ┘ └扩展┘
 *
 * 同一版本会同时挂 .dmg / .zip（其它平台是 .deb / .exe / .AppImage），所以
 * 扩展名不参与判定——版本号才参与。
 */
function parseDownloadFilename(rawUrl) {
  if (!rawUrl) return { ok: false, error: 'no-url' }
  let filename
  try {
    const parsed = new URL(rawUrl)
    const segs = parsed.pathname.split('/').filter(Boolean)
    filename = decodeURIComponent(segs[segs.length - 1] ?? '')
  } catch {
    return { ok: false, error: 'bad-url', url: rawUrl }
  }
  if (!filename) return { ok: false, error: 'no-filename', url: rawUrl }

  /**
   * 版本号是 4 段数字（5.9.3.42398134）：前两段是语义版本，第三段是产品
   * 版本号，第四段是构建号。构建哈希（如 d4692421）是十六进制、不含点，
   * 不会被这条正则误抓。
   */
  const m = filename.match(/(\d+\.\d+\.\d+\.\d+)/)
  const ext = (filename.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase()
  const expected = expectedFilenamePlatform()
  return {
    ok: Boolean(m),
    ...(m ? { version: m[1] } : { error: 'no-version-in-filename' }),
    filename,
    ext,
    url: rawUrl,
    /** 文件名里有没有本机的平台串。对不上说明这份链接不是给这台机器的。 */
    platformOk: expected ? filename.toLowerCase().includes(expected) : null,
    expectedPlatform: expected,
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
// 指令文件（与 dsh-workbuddy-account-care 的契约）
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
    execFileSync(notifySend, ['-a', 'dsh-workbuddy 账号呵护', '-u', 'critical', '-t', '0', title, body], {
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
    const plugin = readInstalledPlugin()
    const guard = readGuardFile()
    return {
      mode: 'status',
      stateFile: STATE_FILE,
      logFile: LOG_FILE,
      guardFile: GUARD_FILE,
      profileManifest: profileManifestPath(),
      bundleSelected: bundleSelected(),
      baselineVersion: state.baseline?.version ?? null,
      baselinePlatform: state.baseline?.platformId ?? null,
      baselineAt: state.baseline?.updatedAt ?? null,
      baselineSource: state.baseline?.source ?? null,
      baselineLinkFile: state.baseline?.linkFile ?? null,
      upstreamUrl: UPSTREAM_URL,
      platformId: PLATFORM_ID,
      platform: expectedFilenamePlatform(),
      lastJudge: state.lastJudge ?? null,
      pluginInstalled: plugin.version,
      pluginDeclared: plugin.declared ?? null,
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
      /**
       * **刻意不清水印**：强开插件后，那条「WB 更新了」应该重新跟着 provider
       * 选择出现/消失（这是产品约定）。要彻底消掉它用 `--clear-watermark`。
       */
      log('warn', `已重新启用 ${BUNDLE}，清空事件去重记录（水印保留，可随 provider 显示）`)
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
        from: state.baseline?.version ?? null,
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

  /**
   * 数据源：上游接口的**两个字段**，取高者。
   *
   *   1. `productVersion`          —— 接口自己报的版本
   *   2. `url` 文件名里的版本       —— 即将发布的那份安装包叫什么
   *                                   （只解析文件名，绝不下载）
   *
   * 为什么不是「必须一致」：发布是不同步的。清单先改、CDN 上的文件名晚几分钟
   * 跟上（或者反过来）是常态，要求一致就等于每次发版都要多等一个检查周期，
   * 其间两个字段谁也不认。取高者的含义很直接——**谁先说新版本，就按谁算**，
   * 另一边只记一条日志供排查。
   *
   * 本机安装仍然一个字节都不读（见文件头）。
   */
  const simulated = SIMULATE_VERSION !== null
  const upstream = simulated
    ? {
      ok: true,
      version: SIMULATE_VERSION,
      // 演练时**不联网**：既快，也能在没有外网的机器上验证整条链路。
      // 同时造一个形状真实的链接，好让文件名解析那一路也被真的走一遍。
      url: SIMULATE_URL ?? `https://download.codebuddy.cn/workbuddy/saas/${expectedFilenamePlatform()}/`
        + `WorkBuddy-${expectedFilenamePlatform()}-${SIMULATE_VERSION}-d4692421.zip`,
      publishedAt: null,
      simulated: true,
    }
    : await readUpstream()
  if (simulated) log('warn', `演练模式：把接口版本当成 ${SIMULATE_VERSION}（不联网、不推进基线）`)
  if (!simulated && SIMULATE_URL !== null) {
    upstream.url = SIMULATE_URL
    log('warn', `演练模式：把下载链接换成 ${SIMULATE_URL}`)
  }

  // ---- 两路版本号，按高者取 ----------------------------------------------
  const link = parseDownloadFilename(upstream.url)
  const ifaceVersion = upstream.ok ? upstream.version : null
  const linkVersion = link.ok ? link.version : null
  /**
   * `sources`：
   *   both      —— 接口字段和文件名都解析出了版本
   *   interface —— 没拿到/没解析出链接，只有接口这一路
   *   link      —— 只有文件名这一路（接口没给版本，实际不会发生，留着兜底）
   *   none      —— 两路都没有
   *
   * **两路不一致时不投票、不弃权，直接取高的那个。**
   * 理由：这两个数都是「已经发布了什么」的证词，而发布过程本身是不同步的
   * ——清单先变、CDN 上的文件名后变（或反过来）是常态。取高者等于「谁先
   * 说新版本，就按谁算」，宁可早一点提醒，也不要因为另一路还停在旧值而
   * 漏掉一次真实更新。低的那一路只记一条日志，供排查用。
   */
  let sources
  let judgedVersion = null
  let versionGap = null
  if (ifaceVersion !== null && linkVersion !== null) {
    sources = 'both'
    const cmp = compareVersions(ifaceVersion, linkVersion)
    judgedVersion = cmp >= 0 ? ifaceVersion : linkVersion
    if (cmp !== 0) {
      versionGap = { interfaceVersion: ifaceVersion, linkVersion, picked: judgedVersion }
    }
  } else if (ifaceVersion !== null) {
    sources = 'interface'
    judgedVersion = ifaceVersion
  } else if (linkVersion !== null) {
    sources = 'link'
    judgedVersion = linkVersion
  } else {
    sources = 'none'
  }

  if (link.ok && link.platformOk === false) {
    // 只提醒、不拦：文件名拼法偶尔会变，为这个停下判定不值得。
    log('warn', `下载链接的平台串不是本机的（期望 ${link.expectedPlatform}）：${link.filename}`)
  }
  if (sources === 'interface') {
    log('warn', `没拿到可解析的下载链接（${link.error ?? 'unknown'}），本轮只看接口版本`)
  }
  if (versionGap) {
    log('warn', `接口与文件名版本不一致（接口 ${ifaceVersion} / 文件名 ${linkVersion}），按高者取 ${judgedVersion}`)
  }

  const config = effectiveConfig()

  const events = []
  const firstRun = !state.baseline
  const reported = new Set(state.reportedKeys ?? [])
  /**
   * 老格式基线的迁移点。
   *
   * 旧版本把「本机指纹」写进 baseline（带 fingerprint/commit/asarSize），其中
   * version 是本机内置插件的 build id（如 5.9.2.42136757），和新判据用的接口
   * 版本（如 5.9.3.42398134）根本不是一个体系。直接比必然对不上，于是规则切换
   * 的那一刻会凭空弹一次「更新了」。
   *
   * 所以：发现 baseline 里**没有 `source` 标记**（= 老格式），就把它当「没有
   * 基线」——这一轮静默重锚到当前值，不报事件、不挂水印。
   *
   * 有 `source` 的都是新口径（`interface+link` / `interface` / `link`），
   * 原样沿用，不重锚。
   */
  const legacyBaseline = Boolean(state.baseline) && state.baseline?.source === undefined
  /**
   * 平台变了 = 判定作用域变了，不是客户端更新。
   *
   * 触发场景：Node 从 x64 换成 arm64（Rosetta、换机器、升级 Node）、用户改了
   * WORKBUDDY_WATCH_PLATFORM、或者代码里的推断规则变了。这时版本号会从
   * 5.9.3.42398134 跳到 5.6.2.40046327（Linux 线），照旧比较就是一次假的
   * 「客户端更新了」，会平白弹出停用提示。
   *
   * 所以：老基线记着别的平台 → 静默重锚，只在日志里说一句。
   */
  const platformChanged = Boolean(state.baseline?.platformId) && state.baseline.platformId !== PLATFORM_ID
  if (platformChanged) {
    log('warn', `判定平台变了（${state.baseline.platformId} → ${PLATFORM_ID}），版本号不可比，重新落基点`)
  }
  /** 这两种情况都按「没有基线」处理：不报事件，直接落新基点。 */
  const reanchor = legacyBaseline || platformChanged
  if (legacyBaseline) {
    log('warn', `基线是旧格式（${state.baseline?.version ?? '?'}，来自本机指纹），按「无基线」重新落基点`)
  }

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

  // 1) 版本号对不上 —— 唯一的停用触发器
  //
  // 比的是字符串本身，不比大小：降级（接口回退到旧版本）同样算「变了」，
  // 因为客户端被换成旧构建同样可能让插件的私有接口失效。
  let versionChanged = false
  // 版本是否真的不一致（跟「这一轮有没有报出来」分开：去重会让事件为 0）。
  const mismatch = judgedVersion !== null && !firstRun && !reanchor
    && state.baseline.version !== judgedVersion
  if (judgedVersion === null) {
    // 两路都拿不到版本就**什么都不做**：不推进基线、不报事件、不挂提示。
    log('warn', `读取接口版本失败: ${upstream.error} —— 本轮不判定`)
  } else if (firstRun || reanchor) {
    log('info', `落基线：${sources === 'both' ? '接口与文件名一致' : '仅接口'} 版本 ${judgedVersion}（不报警）`)
  } else if (mismatch) {
    const recorded = state.baseline.version
    versionChanged = pushEvent({
      at: nowIso(),
      kind: 'wb-version-changed',
      from: recorded,
      to: judgedVersion,
      action: config.disableOnHit ? 'disable-bundle' : 'report-only',
      url: link.ok ? link.url : (upstream.url ?? null),
      interfaceVersion: ifaceVersion,
      linkVersion,
    })
    if (versionChanged) {
      log('warn', `WorkBuddy 版本不一致：记录 ${recorded} → ${judgedVersion}`
        + `（接口 ${ifaceVersion ?? '?'}，文件名 ${linkVersion ?? '?'}）`)
    }
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
          `WorkBuddy 客户端已更新（${trigger.from} → ${trigger.to}），${BUNDLE} 已停用`,
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
       * 检测到版本号对不上，把「该停用了」这件事写进水印，由用户在界面上选
       * 「软结束」或「硬结束」。守卫不替用户决定什么时候掐断他的会话——
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
      log('warn', `检测到 WorkBuddy 版本变化（${trigger.from} → ${trigger.to}），已挂提示，等待用户选择软结束/硬结束`)
    }
  } else if (triggers.length > 0 && MODE_CHECK) {
    log('info', `--check 模式：命中 ${triggers.length} 个停用条件，但不修改 profile`)
  }

  // 4) 记录状态
  if (!DRY_RUN) {
    state.schema = SCHEMA
    /**
     * 基线推进规则：**只有真的读到接口才推进**。
     *
     * 因为「基线 = 上次接口返回的版本」，读不到接口时推进就等于把基点清零，
     * 下一轮成功时会凭空报一次变化。
     *
     * 演练模式（--simulate-version）不推进：否则模拟值会被写成真基线，下一轮
     * 真实检查又会看到「变回去」，测试本身污染被测对象。演练要的是走一遍动作。
     *
     * 另外：命中版本变化时也照样推进——同一版本不该反复弹提示。去重还有
     * reportedKeys（kind|from|to）兜底。
     */
    if (judgedVersion !== null && !simulated && !MODE_CHECK) {
      state.baseline = {
        version: judgedVersion,
        /** 这个数是在哪个平台上取的。跨平台比版本号没有意义。 */
        platformId: PLATFORM_ID,
        /** 这个数是被几路确认过的：both / interface / link。 */
        source: sources === 'both' ? 'interface+link' : sources,
        linkFile: link.ok ? link.filename : null,
        ...(state.baseline?.capturedAt ? { capturedAt: state.baseline.capturedAt } : {}),
        ...(state.baseline?.version === judgedVersion ? {} : { changedAt: nowIso() }),
        updatedAt: nowIso(),
      }
    } else if (simulated) {
      log('info', '演练模式：不推进基线（避免污染下一轮真实检查）')
    } else if (MODE_CHECK) {
      // `--check` 是「只看一眼」：连基线都不推进。否则跑一次 --check 就把这次
      // 变化「消费」掉了，真正该弹的提示反而不会弹。
      log('info', '--check 模式：不推进基线（这次变化留给正常检查去报）')
    }
    /**
     * 清掉旧字段。
     *
     * `upstreamSeen` 是「上游发布」与「本机安装」两条触发器并存时的记录，
     * 现在它和 baseline 表达同一件事，留着只会让人以为有两个基点。
     */
    if (state.upstreamSeen !== undefined) {
      delete state.upstreamSeen
      log('info', '已清理旧字段 upstreamSeen（现在只有 baseline 一个基点）')
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
    /**
     * 最近一次「两路判定」的结果。
     *
     * `--status` 不联网，所以它没法现场再解析一遍；把上一次的结论留在
     * state 里，排查「到底是哪一路看到的新版本」就不用翻日志。
     */
    state.lastJudge = {
      at: nowIso(),
      platformId: PLATFORM_ID,
      sources,
      interfaceVersion: ifaceVersion,
      linkVersion,
      linkFile: link.ok ? link.filename : null,
      /** 最终采信的版本（两路不一致时取高者）。 */
      judgedVersion,
      versionGap,
    }
    state.lastUpstreamError = upstream.ok ? null : upstream.error
    state.lastPluginError = pluginLatest.ok || NO_UPGRADE ? null : pluginLatest.error
    writeJsonAtomic(STATE_FILE, state)
    log('info', `检查 #${state.checks}：接口 ${ifaceVersion ?? `读取失败(${upstream.error})`}，文件名 ${linkVersion ?? `未解析(${link.error})`}，判定 ${judgedVersion ?? '不做'}${simulated ? '(模拟)' : ''}，基线 ${state.baseline?.version ?? '?'}，插件 ${installedVersion ?? '?'}${pluginLatest.ok ? `(latest ${pluginLatest.version})` : ''}，事件 ${events.length} 个`)
  }

  // 5) 通知（只在真的停用、待用户确认、或插件自升级时弹）
  if (pendingDisable) {
    notify('WorkBuddy 更新了 —— 等待你选择',
      `${triggers[0].from} → ${triggers[0].to}\n插件还在运行；到界面上选「软结束」或「硬结束」。`)
  } else if (disableResult?.changed) {
    notify('WorkBuddy 已更新 —— 插件已停用',
      `${triggers[0].from} → ${triggers[0].to}\n已停用 ${BUNDLE}；界面已挂水印，正在用它的会话已被软结束。\n恢复：node ${process.argv[1]} --enable`)
  } else if (pluginUpgrade?.upgraded) {
    notify('WorkBuddy 插件已升级', `${installedVersion} → ${pluginLatest.version}\n重启 DSH 生效。`)
  }

  return {
    mode: DRY_RUN ? 'dry-run' : (MODE_CHECK ? 'check' : 'watch'),
    checkedAt: nowIso(),
    firstRun,
    legacyBaseline,
    platformChanged,
    platformId: PLATFORM_ID,
    baseline: state.baseline
      ? {
        version: state.baseline.version,
        platformId: state.baseline.platformId ?? null,
        source: state.baseline.source ?? null,
        updatedAt: state.baseline.updatedAt ?? null,
      }
      : null,
    upstream: upstream.ok
      ? {
        version: upstream.version,
        publishedAt: upstream.publishedAt ?? null,
        url: upstream.url ?? null,
        simulated,
      }
      : { error: upstream.error },
    /** 从下载链接文件名里解析出来的那一路。 */
    link: link.ok
      ? { version: link.version, filename: link.filename, ext: link.ext, platformOk: link.platformOk }
      : { error: link.error ?? null },
    sources,
    judgedVersion,
    /** 两路不一致时：谁低、谁被采信。一致时为 null。 */
    versionGap,
    plugin: {
      installed: installedVersion ?? null,
      declared: pluginBefore.declared ?? null,
      latest: pluginLatest.ok ? pluginLatest.version : null,
      newer: pluginNewer,
      upgrade: pluginUpgrade,
      error: pluginLatest.ok ? null : (NO_UPGRADE ? 'disabled' : pluginLatest.error),
    },
    versionChanged,
    mismatch,
    events,
    changed: events.length > 0,
    disabled: disableResult?.changed ?? false,
    pendingDisable,
    disableResult,
    bundleSelected: bundleSelected(),
    pendingReport: (state.pendingReport ?? []).length,
    note: events.length === 0
      ? (judgedVersion === null
        ? '本轮不判定（读不到接口版本）'
        : (firstRun || reanchor
          ? '落基线，不报警'
          : (mismatch ? '版本不一致，但这条事件已提示过（不重复弹）' : '无变化（判定版本等于基线）')))
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
