/**
 * dsh-workbuddy 账号呵护 —— Host 半。
 *
 * 三件事，全部由脚本（`scripts/watch.mjs`）写下的指令文件驱动：
 *
 *   1. 把「水印」这一状态发布给浏览器半，由它在 shell.overlay 里画出来；
 *   2. 检测到更新后**不自动停用**：挂一张带「软结束 / 硬结束」的提示，等用户选；
 *   3. 用户选了之后执行动作（软结束 = 先让会话停，硬结束 = 直接停用），
 *      再由脚本把 bundle 从 profile 里摘掉。
 *
 * 为什么默认不再自动停用：一个正在跑的任务被自动中止，代价比晚几秒停用大得多。
 * 需要无人值守的场景把 `config.json` 的 `autoDisable` 设成 true 即可回到旧行为。
 *
 * **谁在定时**：本插件自己。**加载完立即跑第一次**，之后每隔 `intervalMinutes`
 * （默认 3）派生一次包内的 `scripts/watch.mjs`，后者做检测、停用与升级，并把
 * 结果写成下面这个指令文件；插件再据此软结束会话、推水印。
 *
 * 为什么第一次不等一个间隔（2026-11-06 改）：装完插件、或者 DSH 重启后，
 * 用户最需要的恰恰是**那一刻**的检查结果——`dsh-connect-workbuddy` 可能已经
 * 被升级过，也可能 WorkBuddy 客户端刚更新。等 3 分钟才第一次检查，等于把
 * 最该防的那段窗口留成真空。改成启动即跑之后，`startupDelayMs` 仍然保留一个
 * 很小的默认值（见下），只用来躲开 profile 收敛的瞬间，不是「等一个周期」。
 *
 * 为什么不用 DSH 的「自动化任务」：那是**按计划给会话发一条消息**——
 * 每触发一次就是一次完整的模型回合。而这件事没有任何需要模型判断的地方，
 * 3 分钟一次就是一天 480 个回合、换 480 句「无变化」。定时器要在进程里，
 * 不要经过模型。
 *
 * 为什么仍然由**脚本**而不是插件自己判停用：派生出去的进程是独立的一份代码，
 * 即使本插件因为别的原因半死不活，它照样能把危险的 bundle 关掉。判断只有
 * 一个执行者（脚本），呈现只有一个执行者（本插件），不重叠。
 *
 * 代价也要说清楚：默认「插件自带定时」，所以 **DSH 不在跑的时候不检查**。
 * 这在语义上是够的——DSH 没跑就没有任何请求会被发出去。若你仍想要「DSH 关了
 * 也守着」，把 systemd 定时器也装上即可（`npx dsh-workbuddy-account-care install`），
 * 两边有 `run.lock` 互斥，不会同时写。
 *
 * 状态文件（默认 `$DSH_HOME/workbuddy-update-watch/guard.json`，脚本写入）：
 *   {
 *     "schema": 1,
 *     "revision": 7,                     // 每次实质变化 +1，插件据此只处理一次
 *     "watermark": {                     // null 表示没有水印
 *       "level": "danger" | "warning" | "info",
 *       "title": "WB 更新了",
 *       "body": "还用，你的账号是批发的吗？",
 *       "detail": "5.6.2.40046327 → 5.9.9.99999999",
 *       "at": "2026-11-04T10:00:00.000Z",
 *       "untilRestart": false            // true = 只活到下一次 DSH 启动
 *     },
 *     "stopSessions": {                  // 一次性指令，处理完由插件回写 handled
 *       "revision": 7,
 *       "reason": "本机 WorkBuddy 已更新",
 *       "text": "本机 provider 已更新，本条消息由监控插件自动发送，…"
 *     }
 *   }
 *
 * `untilRestart` 是「重启后水印还在」这个问题的正解：水印本身是持久化在
 * guard.json 里的（这是必要的——危险的红色提示必须活过重启），所以指望浏览器
 * 缓存过期是错的。真正该过期的是**语义上只对本次进程有效**的那一条：
 * 「插件已升级，重启生效」。脚本给它打上 `untilRestart: true`，本插件在启动时
 * 比较 `watermark.at` 与本进程的启动时刻，早于启动时刻就把它清成 null。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本进程的启动时刻：早于它的「一次性」水印都算过期。 */
const BOOT_AT_MS = Date.now()

/** 被呵护插件的 bundle 名。 */
const GUARDED_BUNDLE = 'dsh-connect-workbuddy'
/** 会被当成「正在用 WorkBuddy」的 provider 前缀。 */
const GUARDED_PROVIDERS = ['workbuddy', 'workbuddy-global']
/** 状态文件轮询间隔：脚本每 3 分钟跑一次，15 秒足够及时且几乎不耗资源。 */
const POLL_MS = 15_000

/** 包内检查脚本的绝对路径（本文件与它同在包根下）。 */
const WATCH_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'watch.mjs')

/** 自带定时的默认间隔，分钟。 */
const DEFAULT_INTERVAL_MINUTES = 3

/**
 * 插件加载后到第一次检查之间的默认延迟，毫秒。
 *
 * 不是「等一个间隔」，而是「等这一轮 Cordis 树装配完」。插件 apply 时
 * profile 的 loader 树可能还没收敛（`pluginManager.listBundles()` 会短暂
 * 看不到 `dsh-connect-workbuddy`，于是这一轮被误判成「目标未安装」而跳过）。
 * 3 秒足够绝大多数机器走完收敛，又短到用户感觉不到。
 *
 * 设 `startupDelayMs: 0` 就真的是「apply 内同步派生」，代价是可能要多等
 * 一个重试周期（见 `MISSING_RETRY_MS`）才能看到结果。
 */
const DEFAULT_STARTUP_DELAY_MS = 3_000

/**
 * 启动时发现目标插件「未安装」时的重试间隔，毫秒。
 *
 * 这条路径几乎只出现在启动收敛期：上一轮刚被呵护插件自己从 bundles 里摘掉，
 * 或 profile 还没读完。等一个整周期（3 分钟）再确认太迟，所以先用短间隔
 * 重试几次；重试完仍然没有，才回到常规节奏。
 */
const MISSING_RETRY_MS = 15_000
/** 「未安装」用短间隔重试的次数上限。 */
const MISSING_RETRY_LIMIT = 4

/**
 * 运行中「插件装了/卸了/改了启用状态」时，多久补跑一次检查，毫秒。
 *
 * 比 `startupDelayMs` 的默认值还短：那一刻 profile 已经落盘，不需要再等
 * 收敛；用户点完「安装」应当几乎立刻看到结果。
 */
const EVENT_RECHECK_DELAY_MS = 1_000

/**
 * 一轮检查结束后，下一轮该等多久。
 *
 * 抽成纯函数是为了能测：真正的 `tick` 里那点分叉（未就绪就短重试、就绪就
 * 回到常规节奏）如果埋在闭包里，只有等 3 分钟才能验证一次。
 *
 * @param {object} input
 * @param {boolean|undefined} input.installed 目标插件是否已安装（`undefined` = 判不了，按已安装处理）
 * @param {number} input.missingRetries 本轮之前已经用掉的短重试次数
 * @param {number} input.intervalMinutes 常规间隔
 * @returns {{ delayMs: number, missingRetries: number, event: 'retry'|'given-up'|'ok' }}
 */
function planNextCheck({ installed, missingRetries, intervalMinutes }) {
  const regularMs = intervalMinutes * 60_000
  if (installed !== false) return { delayMs: regularMs, missingRetries: 0, event: 'ok' }
  if (missingRetries < MISSING_RETRY_LIMIT) {
    return { delayMs: MISSING_RETRY_MS, missingRetries: missingRetries + 1, event: 'retry' }
  }
  return { delayMs: regularMs, missingRetries, event: 'given-up' }
}

/** 供浏览器半读取的水印/状态端点。 */
const STATE_PATH = '/plugins/dsh-workbuddy-account-care/state'
/** 界面按钮的动作端点（软结束 / 硬结束）。 */
const ACTION_PATH = '/plugins/dsh-workbuddy-account-care/action'
/** 软结束之后等会话自己停下来的上限；超时也照样停用，只是把结果记进日志。 */
const SOFT_WAIT_MS = 120_000

function resolveDshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

function guardFile() {
  return process.env.WB_GUARD_FILE?.trim()
    || join(resolveDshHome(), 'workbuddy-update-watch', 'guard.json')
}

/**
 * 在 **HMR 事务之外** 执行一段异步代码。
 *
 * 为什么需要：`@deepseek-ai/dsh-hmr` 的 `runExclusive()` 这样判断嵌套：
 *
 *     runExclusive(operation) {
 *       if (this.executing.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'))
 *       const task = this.operations.then(async () => {
 *         return this.executing.run(true, operation)
 *       })
 *       ...
 *     }
 *
 * 而 `pluginManager` 的每个写操作都经 `configure()` → `hmr.runExclusive()`，
 * 包括 `updateBundle()` 内部的 remove + install 两步。
 *
 * `this.executing` 是 `AsyncLocalStorage`。ALS 上下文会跟着**异步链**传播，
 * 连 `setTimeout` / `setImmediate` 都会继承。所以只要本插件的 `poll()` 是从
 * 某个 HMR 事务（最典型的是「刚装完本插件」那次 reconcile）里排期出来的，
 * 之后再怎么延后调用，`getStore()` 都还在——实测把首轮 poll 改成 setTimeout 0
 * 依然报同样的错。
 *
 * 解法只有一个：**显式退出**那个 ALS。`AsyncLocalStorage.exit(fn)` 会把 fn
 * 放在没有 store 的上下文里执行，此后整条链都干净了。
 *
 * `executing` 没出现在 hmr 的 Service 声明里（属于实现细节），所以这里全部
 * 做能力探测：拿不到就照常执行——没有 hmr 的 profile（如精简的 `dsh web`）
 * 本来就没有事务这一层，直接跑正是正确行为。
 */
async function runOutsideHmr(ctx, operation) {
  let hmr
  try {
    hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined
  } catch { hmr = undefined }

  // `executing` 是 dsh-hmr 的私有 AsyncLocalStorage（Service 声明里没公开，
  // 但实例上确实存在）。拿得到就精确退出；拿不到就照常执行——
  // 没有 hmr 的 profile 本来就没有事务这一层。
  const store = hmr?.executing
  if (typeof store?.exit === 'function' && typeof store.getStore === 'function') {
    return store.getStore() !== undefined
      ? await store.exit(() => operation())
      : await operation()
  }
  return await operation()
}

/**
 * 这个升级错误是不是**瞬时**的（等一会儿再试就能成）。
 *
 * 目前已知一种：`HMR transactions cannot be nested`。
 *
 * 成因在 `pluginManager.configure()`：
 *
 *     configure(operation) {
 *       const hmr = this.ownerContext.get("hmr")
 *       return hmr === void 0 ? operation() : hmr.runExclusive(operation)
 *     }
 *
 * `updateBundle` 内部（HMR 下）会先 `removeBundle` 再 `installBundle`，
 * 两者都走 `configure()` → `hmr.runExclusive()`。如果这次升级恰好发生在
 * **另一个 HMR 事务还没结束**的时候（最典型的就是本插件刚被安装 / 刚重新
 * reconcile，`apply()` 里的首轮 poll 就同步跑了起来），就会撞上嵌套限制。
 *
 * 这类失败不是「升级本身有问题」，所以**不该消耗重试次数**——否则两次偶然
 * 的时序冲突就会把自动升级判死。交给下一轮（15 秒 / 3 分钟）重试即可。
 */
function isTransientUpgradeError(value) {
  const text = String(value?.message ?? value?.error?.diagnostic ?? value?.error?.code ?? value ?? '')
  return /HMR transactions cannot be nested/i.test(text)
}

/**
 * `ChangeResult` 的失败原因拼成人能读的一行。
 *
 * `error.code` 是枚举（`incompatible-version` 之类），`diagnostic` 才是细节，
 * 两者都要留 —— 只报 code 看不出为什么，只报 diagnostic 又丢了分类。
 */
function describeFailure(result) {
  if (result?.error?.code) {
    return `${result.error.code}${result.error.diagnostic ? `: ${result.error.diagnostic}` : ''}`
  }
  return String(result?.application ?? 'unknown')
}

/**
 * 把 `name@version` 拆开。取**最后一个** `@`，因为 scope 包形如
 * `@scope/name@1.2.3`，第一个 `@` 是 scope 前缀。
 *
 * 拆不出来（没有版本、是 tarball/路径/git spec）就返回 null，
 * 调用方据此跳过 `updateBundle` 直接 `installBundle`。
 */
function splitSpec(spec) {
  const text = String(spec ?? '').trim()
  const at = text.lastIndexOf('@')
  if (at <= 0) return { name: null, version: null }
  const name = text.slice(0, at)
  const version = text.slice(at + 1)
  if (name === '' || version === '' || /[/\\:]/.test(version)) return { name: null, version: null }
  return { name, version }
}

/**
 * 当前 profile 名。CLI 升级路径要用它（`dsh plugin --profile <p> add`）。
 *
 * Desktop 的宿主进程**不导出 `DSH_PROFILE`**，所以这里的兜底不是可选的：
 * 读 `config.profile`（`apply` 里传进来的），再退到环境变量，最后用 `desktop`。
 * 与 `scripts/watch.mjs` 的 `resolveProfile()` 是同一套优先级，只是插件本体
 * 没有候选探测能力（它不该去扫别人的 profile 目录）。
 */
function profileName(config) {
  const fromConfig = typeof config?.profile === 'string' ? config.profile.trim() : ''
  if (fromConfig !== '') return fromConfig
  const fromEnv = process.env.DSH_PROFILE?.trim()
  if (fromEnv) return fromEnv
  return 'desktop'
}

/** 读状态文件；不存在或读坏都当成「没有水印、没有指令」。 */
async function readGuardState() {
  const file = guardFile()
  try {
    const info = await stat(file)
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return {
      ok: true,
      file,
      mtimeMs: info.mtimeMs,
      revision: Number.isFinite(parsed?.revision) ? parsed.revision : 0,
      watermark: parsed?.watermark ?? null,
      stopSessions: parsed?.stopSessions ?? null,
      upgrade: parsed?.upgrade ?? null,
    }
  } catch (error) {
    return {
      ok: false, file, mtimeMs: 0, revision: 0,
      watermark: null, stopSessions: null, upgrade: null,
      error: String(error?.message || error),
    }
  }
}

/**
 * 这条水印是不是「活到重启为止」的那种，并且确实已经是上一次进程写的。
 *
 * 判据是时间戳而不是出现次数：脚本写 `untilRestart: true` 的水印时带上
 * `at`，本进程启动之后再写的一定晚于 `BOOT_AT_MS`，属于「本次运行的提示」；
 * 早于它的说明是上一个进程留下的，而它要提示的那件事（重启生效）已经发生了。
 *
 * 时间戳读不出来时一律**不清**：宁可多留一条提示，也不要误删危险水印。
 */
function isStaleUntilRestart(watermark) {
  if (watermark === null || watermark?.untilRestart !== true) return false
  const at = Date.parse(String(watermark.at ?? ''))
  if (!Number.isFinite(at)) return false
  return at < BOOT_AT_MS
}

/**
 * 这条水印是不是「旧版脚本写的」——即 `untilRestart` 这个字段还不存在时的
 * 「插件已升级」水印。
 *
 * 为什么要单独认它：字段是后加的，升级到本版本之前落盘的那条（用户当时看到
 * 的就是「重启后还在」的那个）身上没有 `untilRestart`，光看字段它会一直留着。
 * 这个兜底只在启动时判一次，而且只认窗口里的那条标题——把匹配面放到最窄，
 * 宁可漏掉、不可误清。危险水印（「WB 更新了」）永远不在此列。
 */
const LEGACY_RESTART_TITLE = '插件已升级'
/** 只认「这次启动前不久」留下的：更早的说明它已经经历了不止一次重启，另有异常。 */
const LEGACY_WINDOW_MS = 24 * 60 * 60 * 1000

function isLegacyRestartWatermark(watermark) {
  if (watermark === null || watermark?.untilRestart !== undefined) return false
  if (String(watermark.title ?? '') !== LEGACY_RESTART_TITLE) return false
  const at = Date.parse(String(watermark.at ?? ''))
  if (!Number.isFinite(at)) return false
  return at < BOOT_AT_MS && BOOT_AT_MS - at < LEGACY_WINDOW_MS
}

/** 该清的理由；null 表示留着。 */
function staleReason(watermark) {
  if (isStaleUntilRestart(watermark)) return 'until-restart-elapsed'
  if (isLegacyRestartWatermark(watermark)) return 'legacy-upgrade-watermark'
  return null
}

/**
 * 清掉上一个进程留下的「重启生效」水印。
 *
 * 只改 `watermark`：`revision` 继续 +1，这样浏览器半那边已经渲染着的旧卡片
 * 会因为 revision 变化而被重新读取，而不是停在那里等一次刷新。
 */
async function clearStaleWatermark(file, stale, reason) {
  let current
  try { current = JSON.parse(await readFile(file, 'utf8')) } catch { return null }
  // 读与写之间别人可能又改了；以当前磁盘内容为准再判一次
  if (staleReason(current.watermark) === null) return null
  current.watermark = null
  current.revision = (Number(current.revision) || 0) + 1
  current.watermarkClearedAt = new Date().toISOString()
  current.watermarkClearedReason = reason
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  return { revision: current.revision, title: stale.title ?? null, reason }
}

/** 原子回写：只改动 `stopSessions.handled`，其它字段原样保留。 */
async function markHandled(state, report) {
  if (!state.ok) return
  let current
  try { current = JSON.parse(await readFile(state.file, 'utf8')) } catch { return }
  current.stopSessions = { ...(current.stopSessions ?? {}), handled: report }
  current.handledAt = new Date().toISOString()
  const tmp = `${state.file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, state.file)
}

/**
 * 把升级指令的执行结果写回 `guard.json`。
 *
 * 只改 `upgrade` 这一个子对象：`revision` 的抬升交给脚本侧的下一次写入，
 * 这里不碰，否则「脚本按 revision 判断要不要执行」会自我触发。
 * `status` 从 `pending` 变成 `done`/`failed`，脚本据此不再重复下发。
 */
async function markUpgrade(state, report) {
  if (!state.ok) return
  let current
  try { current = JSON.parse(await readFile(state.file, 'utf8')) } catch { return }
  const previous = current.upgrade ?? {}
  current.upgrade = { ...previous, ...report, requestedAt: previous.issuedAt ?? null }
  current.upgradeAt = report?.at ?? new Date().toISOString()
  const tmp = `${state.file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, state.file)
}

/** 消息内容 → 纯文本，用于判断是否已经软结束过（避免重复发）。 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * 软结束消息的正文（默认）。
 *
 * 这句话是给「下一轮的那个 agent」看的：它得知道三件事——现在该停下来、
 * 为什么停（本机 provider 变了）、以及这条消息不是用户本人写的。
 */
const DEFAULT_STOP_TEXT = '本机 provider 已更新，本条消息由监控插件自动发送，收到后暂停你的所有任务, 等待重启 agent 工具'

/**
 * 去重标记：收件箱里已经有这句话的会话，不再重复插一条。
 *
 * 用正文里的一个稳定片段而不是额外加前缀——正文就是用户要看到的样子，
 * 不该为了机器识别再挂一个 `[workbuddy-guard]` 之类的标签。
 */
const SOFT_STOP_MARKER = '本条消息由监控插件自动发送'

/**
 * 日志里最后一条 assistant 消息是谁生成的（只用于降级判定，见下）。
 */
function lastAssistantProvider(agent) {
  try {
    const events = agent.session.ownEvents()
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event.type !== 'assistant/message') continue
      const source = event.data?.message?.source
      return source?.provider ?? null
    }
  } catch { /* 读不到日志就当不知道 */ }
  return null
}

/**
 * 这条会话是不是「正在用 WorkBuddy」。
 *
 * **唯一可信的证据是会话投影 `modelSelection`**。它和界面上那个模型选择器
 * 读的是同一份数据（`next = pending ?? lastUsed`），所以「界面没提示、会话
 * 却被停用」这种事不会发生——两边永远一致。
 *
 * 踩过的坑（2026-11-05）：曾经把 `agent.options.provider` 也当成独立证据。
 * 那是会话**创建时**的配置，用户中途换过 provider 并不会更新。于是一条一直
 * 在用 deepseek 的会话（只是聊到了 WorkBuddy）被判成 workbuddy，收到了软
 * 结束指令。所以现在它不再有独立否决权。
 *
 * 只有在投影服务整个不可用时才降级，而且要求两个信号同时成立（配置 +
 * 最后一条 assistant 消息都是 workbuddy）——拿不准就不动手，比误伤便宜。
 */
function usesWorkbuddy(agent, projections) {
  const selection = projections?.modelSelection
  // `next` 就是界面选择器显示的那个值（= pending ?? lastUsed），优先信它；
  // 只有它缺席时才回退到 lastUsed。
  const current = selection?.next ?? selection?.lastUsed
  if (current && GUARDED_PROVIDERS.includes(current.provider)) return `${current.provider}/${current.model}`
  // 投影可用且明确说了别的 provider → 到此为止，不再找别的证据
  if (selection !== undefined && selection !== null) return null

  // ---- 降级路径：投影不可用 ----
  const options = agent?.options ?? {}
  if (!GUARDED_PROVIDERS.includes(options.provider)) return null
  const lastProvider = lastAssistantProvider(agent)
  if (lastProvider === null || !GUARDED_PROVIDERS.includes(lastProvider)) return null
  return `${options.provider}/${options.model ?? '?'}`
}

/**
 * 软结束一条会话：中止当前轮但保留收件箱，然后送一条明确的说明。
 *
 * 顺序是有意的 —— 先 cancel 再 followup：cancel 会清空并中止正在跑的轮次，
 * 之后 followup 排队的那条说明才会成为下一轮的唯一输入，而不是被这次中止
 * 一起丢掉。
 */
function softStop(agent, reason, text) {
  const model = `${agent.options?.provider ?? '?'}/${agent.options?.model ?? '?'}`
  agent.cancel({ kind: 'hook', reason: `workbuddy-guard: ${reason}` }, { keepInbox: true })
  agent.followup({
    id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{
      type: 'text',
      text,
    }],
  })
  return model
}

/**
 * 解析「加载后多久跑第一次」。
 *
 * 默认 3 秒（`DEFAULT_STARTUP_DELAY_MS`），不是默认一个间隔——那是这次要修的
 * 行为本身。允许显式 `0`（同步内的下一个 tick 就派生），也允许「改大」来给
 * 慢机器上的 profile 收敛留时间。
 *
 * 为什么不用 `Number(x) >= 0` 一把梭：`Number(null)` === 0、`Number('')` === 0、
 * `Number([])` === 0。配置没写这个键时 `config.startupDelayMs` 就是 `undefined`，
 * 一旦被当成 0，「等一会儿」的默认值会被静默吃掉。所以先看类型。
 */
function resolveStartupDelayMs(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return DEFAULT_STARTUP_DELAY_MS
  if (typeof raw === 'string' && raw.trim() === '') return DEFAULT_STARTUP_DELAY_MS
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_STARTUP_DELAY_MS
  return ms
}

/**
 * 「刚装载/卸载/改启用」这类事件到达时，把下一次检查提前到多久。
 *
 * 与 `startupDelayMs` 取小值：事件发生时 profile 已经落盘，不需要再等收敛；
 * 若用户把 `startupDelayMs` 配成 0，那这里也应当跟着是 0。
 */
function resolveRecheckDelayMs(startupDelayMs) {
  return Math.min(startupDelayMs, EVENT_RECHECK_DELAY_MS)
}

export const name = 'dsh-workbuddy-account-care'
/**
 * 这些服务缺失时插件保持惰性，而不是把整个 profile 弄挂。
 *
 * `agents` 必须是声明的：软结束会话要遍历 `ctx.agents.list()`。漏掉它时
 * `ctx.agents` 在 Cordis 里是 undefined，整段软结束会抛异常并被轮询的
 * try/catch 吞掉 —— 表现就是「水印出来了、会话没停」。
 *
 * `pluginManager` **不在这里**：它是可选能力，用 `ctx.get('pluginManager')`
 * 取（见 `resolveUpgrader`）。写进 `inject` 会让没有该服务的 profile
 * 整个插件都加载不起来 —— 而水印与停用是核心功能，不该被升级能力拖累。
 */
export const inject = ['webServer', 'agents']

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const pollMs = Number(config.pollMs) > 0 ? Number(config.pollMs) : POLL_MS

  /** 已经处理过的指令 revision，避免同一指令重复执行。 */
  let handledStopRevision = 0
  /** 已经执行过的升级指令 revision；防止同一个 pending 被反复执行。 */
  let handledUpgradeRevision = 0
  /** 已经下发的水印 revision，避免每 15 秒重推同样的值。 */
  let publishedWatermarkRevision = -1
  /** 浏览器半要读的当前值。 */
  let current = { watermark: null, revision: 0, guardFile: guardFile() }

  // ---- 浏览器半读这里 -------------------------------------------------
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      // 只接受本机浏览器；这个值不含任何凭据，但也没有理由暴露到局域网。
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({
        watermark: current.watermark,
        revision: current.revision,
        at: new Date().toISOString(),
      }))
    },
  }), 'workbuddy-guard: state route')

  // ---- 动作端点：界面上「软结束 / 硬结束」走这里 -------------------------
  /**
   * 这里只做三件事，都很短：软结束时先让会话停，硬结束时直接停用，最后清掉待确认水印。
   *
   * 为什么停用仍然由脚本做：写 profile 的 `package.json` 只能有一个写者，
   * 脚本与插件并发改同一个文件会写出半成品。插件负责「判断与调度」，脚本负责「落盘」。
   */
  let actionInFlight = null

  async function waitForWorkbuddyIdle(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const agents = ctx.agents?.list?.() ?? []
      const busy = agents.filter((agent) => {
        if (agent.status !== 'running') return false
        try {
          const projections = ctx.get('sessionProjections')?.snapshot(agent.session)?.values
          return usesWorkbuddy(agent, projections) !== null
        } catch { return false }
      })
      if (busy.length === 0) return { idle: true, waitedMs: timeoutMs - (deadline - Date.now()) }
      if (Date.now() >= deadline) return { idle: false, remaining: busy.map((a) => a.id) }
      await new Promise((resolve) => { const t = setTimeout(resolve, 1000); t.unref?.() })
    }
  }

  /** 派脚本停用 bundle（`--disable` 只停用、不检测）。 */
  function disableCurrentBundle() {
    return new Promise((resolve) => {
      const args = [WATCH_SCRIPT, '--disable']
      const profile = config.profile ?? process.env.DSH_PROFILE
      if (typeof profile === 'string' && profile !== '') args.push('--profile', profile)
      let child
      try {
        child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) })
        return
      }
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      child.on('error', (error) => resolve({ ok: false, error: String(error?.message || error) }))
      child.on('close', (code) => {
        const line = stdout.trim().split('\n').filter(Boolean).pop()
        let parsed
        try { parsed = JSON.parse(line) } catch { parsed = undefined }
        resolve({ ok: code === 0, code, result: parsed, stderr: stderr.trim().slice(0, 400) })
      })
    })
  }

  /**
   * 动作完成后把水印从「待确认」改成「已停用」。
   *
   * 刻意**不删掉**：插件被摘除后 WorkBuddy provider 也跟着消失，水印自然不显示；
   * 但用户要是强开了 `dsh-connect-workbuddy`，这条水印就该重新跟着 provider 选择
   * 出现/消失——所以它得活着，只是不再带按钮。
   */
  async function finalizeWatermark(file, action) {
    let snapshot
    try { snapshot = JSON.parse(await readFile(file, 'utf8')) } catch { return null }
    const previous = snapshot.watermark ?? {}
    snapshot.watermark = {
      level: 'danger',
      title: previous.title ?? 'WB 更新了',
      body: previous.body ?? '',
      detail: `${previous.from ?? '?'} → ${previous.to ?? '?'}`,
      pendingDisable: false,
      actions: [],
      handledBy: action,
      at: new Date().toISOString(),
    }
    snapshot.revision = (Number(snapshot.revision) || 0) + 1
    snapshot.actionAt = new Date().toISOString()
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, file)
    publishedWatermarkRevision = snapshot.revision
    current = { watermark: snapshot.watermark, revision: snapshot.revision, guardFile: file }
    return snapshot.revision
  }

  async function runAction(action) {
    const state = await readGuardState()
    const wm = state.watermark ?? {}
    const from = wm.from ?? '?'
    const to = wm.to ?? '?'
    const reason = `WorkBuddy 版本与基线不一致（${from} → ${to}）`

    let stopped = []
    let idle = null
    if (action === 'soft') {
      // 先把消息送出去让会话停，再等它真的停下来
      try {
        stopped = stopWorkbuddySessions(reason, DEFAULT_STOP_TEXT).stopped
      } catch (error) {
        logger.error?.(`[workbuddy-guard] 软结束失败: ${error?.message || error}`)
      }
      idle = await waitForWorkbuddyIdle(SOFT_WAIT_MS)
      logger.warn?.(`[workbuddy-guard] 软结束：停止 ${stopped.length} 个会话，idle=${idle.idle}`)
    }

    const disabled = await disableCurrentBundle()
    if (!disabled.ok) logger.error?.(`[workbuddy-guard] 停用失败: ${disabled.error ?? disabled.stderr ?? disabled.code}`)
    await finalizeWatermark(state.file, action)
    logger.warn?.(`[workbuddy-guard] 动作 ${action} 完成：disabled=${disabled.ok}`)
    return { stopped, idle, disabled }
  }

  async function handleAction(req, res) {
    const send = (status, payload) => {
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify(payload))
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: 'method-not-allowed' })
    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 4096) throw new Error('body-too-large')
      }
    } catch (error) {
      return send(400, { ok: false, error: String(error?.message || error) })
    }
    let body = {}
    try { body = raw === '' ? {} : JSON.parse(raw) } catch { return send(400, { ok: false, error: 'bad-json' }) }
    const action = body.action
    if (action === 'ack') return send(200, { ok: true, action })
    if (action !== 'soft' && action !== 'hard') return send(400, { ok: false, error: 'unknown-action' })
    if (actionInFlight !== null) return send(409, { ok: false, error: 'busy', action: actionInFlight })
    actionInFlight = action
    try {
      const result = await runAction(action)
      return send(200, { ok: true, action, ...result })
    } catch (error) {
      logger.error?.(`[workbuddy-guard] 动作 ${action} 失败: ${error?.message || error}`)
      return send(500, { ok: false, action, error: String(error?.message || error) })
    } finally {
      actionInFlight = null
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ACTION_PATH,
    handler: (req, res) => { void handleAction(req, res) },
  }), 'workbuddy-guard: action route')

  // ---- 上一个进程留下的「重启生效」水印：第一次 poll 前清掉 -------------
  /**
   * 这是「重启后水印还在」的根治点。
   *
   * 刻意放在 poll 的**第一次**赋值之前，而不是单独开一个启动 effect：
   * 浏览器半个页面一加载就会拉一次状态，如果清除与首次发布并行，用户会先
   * 看见旧卡片、再看着它消失——那个闪烁比多留一条提示更糟。串在 poll 里，
   * 第一次 `current` 就已经是清干净之后的值。
   *
   * 只判一次（`staleChecked`）：之后再写的 `untilRestart` 水印都属于本进程，
   * 不该被清。失败不影响任何其它功能，下一轮会从磁盘如实读出当前值。
   */
  let staleChecked = false
  async function clearStaleOnce(state) {
    if (staleChecked) return state
    staleChecked = true
    if (!state.ok) return state
    const reason = staleReason(state.watermark)
    if (reason === null) return state
    try {
      const cleared = await clearStaleWatermark(state.file, state.watermark, reason)
      if (cleared === null) return state
      logger.warn?.(`[workbuddy-guard] 已清除上一次进程留下的「重启生效」水印（${cleared.title ?? '未知标题'}，${cleared.reason}）`)
      // 重新读一遍：revision 已经被抬高，后面按新值发布
      return await readGuardState()
    } catch (error) {
      logger.error?.(`[workbuddy-guard] 清理过期水印失败: ${error?.message || error}`)
      return state
    }
  }

  /** 停用 bundle 由脚本负责；插件只记录它是否已经生效，供诊断。 */
  async function bundleStillEnabled() {
    const manager = ctx.get('pluginManager')
    if (manager === undefined) return null
    try {
      const bundles = await manager.listBundles()
      const row = bundles.find((b) => b.name === GUARDED_BUNDLE)
      return row === undefined ? null : Boolean(row.enabled)
    } catch { return null }
  }

  /** 找出正在跑、且正在用 workbuddy 的会话，逐个软结束。 */
  function stopWorkbuddySessions(reason, text) {
    const stopped = []
    const skipped = []
    const agents = ctx.agents?.list?.() ?? []
    if (agents.length === 0) return { stopped, skipped, note: 'no-live-agents' }
    for (const agent of agents) {
      // 单个会话出问题不能带走整批：每个都独立兜底
      try {
        const projections = ctx.get('sessionProjections')?.snapshot(agent.session)?.values
        const model = usesWorkbuddy(agent, projections)
        if (model === null) continue
        const status = agent.status
        if (status !== 'running') {
          skipped.push({ sessionId: agent.id, model, status })
          continue
        }
        // 已经软结束过就不再重复插一条，否则每 3 分钟一轮会堆满收件箱
        const inboxText = [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]
          .map((m) => textOf(m.content))
          .join('\n')
        if (inboxText.includes(SOFT_STOP_MARKER)) {
          skipped.push({ sessionId: agent.id, model, status, already: true })
          continue
        }
        softStop(agent, reason, text)
        stopped.push({ sessionId: agent.id, model })
        logger.warn?.(`[workbuddy-guard] 软结束会话 ${agent.id}（${model}）`)
      } catch (error) {
        skipped.push({ sessionId: agent.id, error: String(error?.message || error) })
        logger.error?.(`[workbuddy-guard] 软结束 ${agent.id} 失败: ${String(error?.message || error)}`)
      }
    }
    return { stopped, skipped }
  }

  /**
   * 把 `dsh-connect-workbuddy` 升到指定版本。三条路，按环境挑一条。
   *
   * 为什么不是一条：这个插件同时活在两种宿主里，而它们**没有共同的可执行入口**。
   *
   *   1. `host-service` —— DSH Desktop（Electron）或任何装了
   *      `@deepseek-ai/dsh-plugin-manager` 的 profile。用 `ctx.get('pluginManager')`
   *      调 `installBundle`。这是最正确的一条：与界面里点「更新」走同一条 pnpm
   *      路径，装完会自动 reconcile `dsh.profile.bundles`，HMR 下还能热生效。
   *      **不需要 `dsh` 在 PATH 上。**
   *
   *   2. `dsh-cli` —— 命令行启动的 Harness（`dsh web`），`dsh` 是真实可执行文件。
   *      调 `dsh plugin --profile <p> add <spec>`。
   *
   *   3. 都没有 —— 只报告，不改动。把结论写进日志与 `--status`，让用户自己升。
   *
   * 早先只有第 2 条路，且写死 `execFileSync('dsh', …)`。在 Desktop 上它 100%
   * 失败：宿主的 PATH 里没有 `dsh`，安装目录里只有 `dsh.cmd`，而 Node 修
   * CVE-2024-27980 之后拒绝在不带 shell 时 spawn `.cmd`（ENOENT/EINVAL）。
   * 于是每轮只留下一条 `spawnSync dsh ENOENT` 的 warn。
   *
   * 顺序是「先问宿主，再问 PATH」：宿主存在就说明这个进程自己有插件管理能力，
   * 比自己 fork 一个 CLI 更可靠，也不依赖用户的 PATH 配置。
   */
  function resolveUpgrader() {
    // 1) 宿主服务
    let manager = null
    try {
      manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined
    } catch { manager = undefined }
    if (manager && typeof manager.updateBundle === 'function') {
      return {
        kind: 'host-service',
        label: '宿主 pluginManager.updateBundle',
        async run(spec) {
          const { name, version } = splitSpec(spec)
          if (name === null || version === null) {
            return { ok: false, method: 'host-service', error: `无法从 ${spec} 解析出包名与版本` }
          }

          /**
           * 宿主侧**只有** `updateBundle` 这一条路，没有降级。
           *
           * `installBundle` 看着像备选，实际不行：源码里那行判断是
           *
           *   if (hmr 存在 && 包名已在 dependencies 里) throw already-installed
           *
           * ——与版本号无关。只要包已经装了（升级场景必然已装），有 HMR 时
           * `installBundle` 一律拒绝。实测返回的就是 `already-installed`。
           * 所以不要再把它当 fallback，那只会掩盖真正的原因。
           */
          try {
            const updated = await manager.updateBundle(name, version)
            // PluginUpdateResult: { from, to, step, result: ChangeResult, restore? }
            const result = updated?.result ?? updated
            const ok = result?.application === 'applied' || result?.application === 'restart-required'
            const rolledBack = updated?.restore !== undefined && updated?.restore !== null
            if (ok && !rolledBack) {
              return {
                ok: true,
                method: 'host-service/updateBundle',
                application: result?.application ?? null,
                version: result?.version ?? null,
                restart: result?.application === 'restart-required',
                error: null,
              }
            }
            return {
              ok: false,
              method: 'host-service/updateBundle',
              application: result?.application ?? null,
              step: updated?.step ?? null,
              transient: isTransientUpgradeError(result),
              error: `${describeFailure(result)}${rolledBack ? '（已回滚）' : ''}`,
            }
          } catch (error) {
            const message = String(error?.message || error)
            return {
              ok: false,
              method: 'host-service/updateBundle',
              transient: isTransientUpgradeError(error),
              error: message,
            }
          }
        },
      }
    }

    // 2) 命令行
    const cli = findDshCli()
    if (cli !== null) {
      return {
        kind: 'dsh-cli',
        label: `CLI ${cli.command}`,
        async run(spec) {
          const args = ['plugin', '--profile', profileName(config), 'add', spec]
          const out = await spawnCapture(cli.command, [...cli.prefix, ...args])
          if (out.ok) return { ok: true, method: 'dsh-cli', output: out.stdout.slice(-2000) }
          return { ok: false, method: 'dsh-cli', error: out.error }
        },
      }
    }

    // 3) 都不行
    return {
      kind: 'none',
      label: '（不可用）',
      async run() {
        return {
          ok: false,
          method: 'none',
          error: '既没有 pluginManager 服务，也找不到 dsh 命令；请手动升级',
        }
      },
    }
  }

  /**
   * 找 `dsh` 可执行文件。找不到返回 null。
   *
   * Windows 上不能直接 spawn `dsh.cmd`（CVE-2024-27980 之后 Node 拒绝），
   * 所以这里**只认 .exe**，或者确认能通过 `cmd.exe /c` 调用。返回的
   * `prefix` 就是给 `spawnCapture` 用的前置参数。
   */
  function findDshCli() {
    const isWin = process.platform === 'win32'
    const exts = isWin
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
    const dirs = (process.env.PATH ?? '').split(isWin ? ';' : ':').filter(Boolean)
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = join(dir, `dsh${ext.toLowerCase()}`)
        try {
          if (existsSync(candidate)) {
            // .cmd/.bat 必须经 cmd.exe
            if (isWin && /\.(cmd|bat)$/i.test(candidate)) {
              return { command: process.env.COMSPEC || 'cmd.exe', prefix: ['/c', candidate] }
            }
            return { command: candidate, prefix: [] }
          }
        } catch { /* 读不到就跳过 */ }
      }
    }
    return null
  }

  /** 跑一个子进程并收齐输出；不抛异常。 */
  function spawnCapture(command, args, timeoutMs = 300_000) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
      child.stdout?.on('data', (c) => { stdout += String(c) })
      child.stderr?.on('data', (c) => { stderr += String(c) })
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, timeoutMs)
      timer.unref?.()
      child.on('error', (error) => { clearTimeout(timer); finish({ ok: false, error: String(error?.message || error) }) })
      child.on('close', (code) => {
        clearTimeout(timer)
        finish({
          ok: code === 0,
          code,
          stdout,
          stderr,
          error: code === 0 ? null : `退出码 ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ''}`,
        })
      })
    })
  }

  /** 执行一条升级指令，把结果写回 guard.json 供下一轮与 `--status` 读取。 */
  async function runUpgrade(state, request) {
    const spec = String(request.spec ?? `${GUARDED_BUNDLE}@${request.to}`)
    const upgrader = resolveUpgrader()
    logger.warn?.(`[workbuddy-guard] 开始升级 ${spec}（方式：${upgrader.label}）`)
    let outcome
    try {
      outcome = await runOutsideHmr(ctx, () => upgrader.run(spec))
    } catch (error) {
      outcome = { ok: false, method: upgrader.kind, error: String(error?.message || error) }
    }
    await markUpgrade(state, {
      revision: Number(request.revision) || 0,
      // 瞬时失败（HMR 事务嵌套）写 `pending` 而不是 `failed`：
      // 脚本据此不消耗重试次数，下一轮还会再试。
      status: outcome.ok ? 'done' : (outcome.transient === true ? 'pending' : 'failed'),
      transient: outcome.transient === true ? true : undefined,
      method: outcome.method ?? upgrader.kind,
      at: new Date().toISOString(),
      application: outcome.application ?? null,
      restart: outcome.restart === true,
      ...(outcome.error ? { error: outcome.error } : {}),
    })
    if (outcome.ok) {
      logger.warn?.(`[workbuddy-guard] 升级完成：${spec}（${outcome.method}${outcome.restart ? '，需重启生效' : ''}）`)
      // 升级不等于启用；且只有「需要重启」时才挂一次性水印。
      if (outcome.restart === true) {
        await pushRestartWatermark(request.from, request.to)
      }
    } else if (outcome.transient === true) {
      logger.warn?.(`[workbuddy-guard] 升级暂时做不了（${outcome.error}），下一轮再试`)
    } else {
      logger.error?.(`[workbuddy-guard] 升级失败（${outcome.method}）：${outcome.error}`)
    }
    return outcome
  }

  /** 升级后的「重启生效」水印；与脚本写的那条同构，重启后自动过期。 */
  async function pushRestartWatermark(from, to) {
    const file = guardFile()
    let snapshot
    try { snapshot = JSON.parse(await readFile(file, 'utf8')) } catch { return }
    snapshot.watermark = {
      level: 'warning',
      title: '插件已升级',
      body: '重启 DSH 生效。',
      detail: `${GUARDED_BUNDLE} ${from ?? '?'} → ${to ?? '?'}`,
      untilRestart: true,
      at: new Date().toISOString(),
    }
    snapshot.revision = (Number(snapshot.revision) || 0) + 1
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, file)
    publishedWatermarkRevision = snapshot.revision
    current = { watermark: snapshot.watermark, revision: snapshot.revision, guardFile: file }
  }

  /** 读一次状态文件，按 revision 执行应该执行的动作。 */
  async function poll() {
    // 0) 上一次进程留下的「重启生效」水印，在首次发布之前就清掉
    const state = await clearStaleOnce(await readGuardState())

    // 1) 水印：值变了就重推，没变就什么都不做
    if (state.revision !== publishedWatermarkRevision) {
      publishedWatermarkRevision = state.revision
      current = { watermark: state.watermark, revision: state.revision, guardFile: state.file }
    }

    // 1.5) 插件升级指令（脚本只负责「想升到哪」，执行在宿主进程里）
    const upgrade = state.upgrade
    if (upgrade && upgrade.status === 'pending' && Number(upgrade.revision) > handledUpgradeRevision) {
      handledUpgradeRevision = Number(upgrade.revision)
      await runUpgrade(state, upgrade)
    }

    // 2) 软结束会话：指令里带 stopSessions 就执行一次（幂等）
    const stop = state.stopSessions
    if (stop && Number(stop.revision) > handledStopRevision && !stop.handled) {
      const reason = String(stop.reason || 'WorkBuddy 版本与基线不一致')
      const text = String(stop.text || DEFAULT_STOP_TEXT)
      let sessions = { stopped: [], skipped: [] }
      let failure = null
      try {
        sessions = stopWorkbuddySessions(reason, text)
      } catch (error) {
        // 整段失败也要留证据：否则「水印出来了、会话没停」会无声无息
        failure = String(error?.message || error)
        logger.error?.(`[workbuddy-guard] 软结束整批失败: ${failure}`)
      }
      handledStopRevision = Number(stop.revision)
      await markHandled(state, {
        at: new Date().toISOString(),
        stopped: sessions.stopped,
        skipped: sessions.skipped,
        ...(sessions.note === undefined ? {} : { note: sessions.note }),
        ...(failure === null ? {} : { failure }),
        // 脚本已经停用过 bundle；这里回读它是否真的不在了，作为第二条证据
        bundleStillEnabled: await bundleStillEnabled(),
      })
      logger.warn?.(`[workbuddy-guard] 指令 #${stop.revision} 完成：软结束 ${sessions.stopped.length} 个，跳过 ${sessions.skipped.length}${failure ? `（失败：${failure}）` : ''}`)
    }
  }

  /**
   * 派生一次检查脚本。
   *
   * 子进程而不是 import：脚本是一份自包含的 CLI（自带参数解析、锁、日志），
   * 它失败也不会把 Host 进程带下水；而且用户手动跑的命令与定时跑的是同一份代码。
   */
  function runWatchOnce() {
    return new Promise((resolve) => {
      const args = [WATCH_SCRIPT]
      const profile = config.profile ?? process.env.DSH_PROFILE
      if (typeof profile === 'string' && profile !== '') args.push('--profile', profile)
      if (config.notify === false) args.push('--no-notify')

      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }

      let child
      try {
        child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        finish({ ok: false, error: String(error?.message || error) })
        return
      }

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
      // 单次检查最多 5 分钟：脚本自己也会超时，这里只兜底
      const guard = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } }, 5 * 60_000)
      guard.unref?.()

      child.on('error', (error) => { clearTimeout(guard); finish({ ok: false, error: String(error?.message || error) }) })
      child.on('close', (code) => {
        clearTimeout(guard)
        const line = stdout.trim().split('\n').filter(Boolean).pop()
        let parsed
        try { parsed = JSON.parse(line) } catch { parsed = undefined }
        if (code !== 0) logger.warn?.(`[workbuddy-guard] 检查脚本退出码 ${code}: ${stderr.trim().slice(0, 400)}`)
        finish({ ok: code === 0, code, result: parsed, stderr: stderr.trim() })
      })
    })
  }

  // ---- 自带定时：每 intervalMinutes 派生一次检查 ------------------------
  const selfSchedule = config.selfSchedule !== false
  const intervalMinutes = Number(config.intervalMinutes) > 0
    ? Number(config.intervalMinutes)
    : DEFAULT_INTERVAL_MINUTES
  /** 加载后到第一次检查的延迟（默认 3 秒），见 `resolveStartupDelayMs`。 */
  const startupDelayMs = resolveStartupDelayMs(config.startupDelayMs)

  /**
   * 被呵护插件的插件是否装在本机。
   *
   * 没装就**不派生进程**：脚本自己也会判一次，但这里先挡一道，省掉每 3 分钟
   * 一个必然空转的子进程，也避免在没有那个插件的环境里留下任何状态文件。
   *
   * `installed` 是「profile 声明了这个依赖」，与「是否被选中」无关 —— 呵护插件
   * 自己会把它从 bundles 里摘掉，那时它仍然是已安装、只是停用。
   */
  async function guardTargetInstalled() {
    const manager = ctx.get('pluginManager')
    if (manager === undefined) return undefined // 无法判断时交给脚本去判
    try {
      const bundles = await manager.listBundles()
      const row = bundles.find((b) => b.name === GUARDED_BUNDLE)
      return row === undefined ? false : row.installed !== false
    } catch {
      return undefined
    }
  }

  if (selfSchedule) {
    ctx.effect(() => {
      let alive = true
      let timer
      let loggedMissing = false
      /** 本轮「目标未安装」已经用掉的短重试次数；一轮真正检查过就归零。 */
      let missingRetries = 0
      /** 一次检查还没跑完。并发派生两个脚本没有意义：它们会互相抢 `run.lock`。 */
      let inFlight = false
      /** 检查进行中收到「该再看一眼」的请求；结束后立刻补跑，不丢事件。 */
      let recheckRequested = false

      const arm = (delayMs) => {
        if (!alive) return
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(tick, delayMs)
        timer?.unref?.()
      }

      const tick = async () => {
        if (!alive) return
        timer = undefined
        if (inFlight) {
          // 已经有一轮在跑：记下来，等它结束再补跑，绝不并发
          recheckRequested = true
          return
        }
        inFlight = true
        let installed
        try {
          installed = await guardTargetInstalled()
          if (installed === false) {
            const plan = planNextCheck({ installed, missingRetries, intervalMinutes })
            if (plan.event === 'retry') {
              // 启动收敛期最常见：别按 3 分钟算，先用短间隔确认一次再认命
              logger.warn?.(`[workbuddy-guard] ${GUARDED_BUNDLE} 暂未就绪，${Math.round(MISSING_RETRY_MS / 1000)} 秒后重试（${plan.missingRetries}/${MISSING_RETRY_LIMIT}）`)
            } else if (!loggedMissing) {
              logger.warn?.(`[workbuddy-guard] ${GUARDED_BUNDLE} 未安装，呵护插件保持静默（装上后自动开始）`)
              loggedMissing = true
            }
          } else {
            loggedMissing = false
            const outcome = await runWatchOnce()
            if (outcome.result?.changed) {
              logger.warn?.(`[workbuddy-guard] 定时检查：${outcome.result.note ?? '有变化'}`)
            }
          }
        } catch (error) {
          logger.error?.(`[workbuddy-guard] 定时检查失败: ${error?.message || error}`)
        } finally {
          inFlight = false
        }
        const plan = planNextCheck({ installed, missingRetries, intervalMinutes })
        missingRetries = plan.missingRetries
        if (!alive) return
        if (recheckRequested) {
          // 跑这一轮的时候又有人要求补跑：用事件的短延迟，而不是等下一个周期
          recheckRequested = false
          arm(resolveRecheckDelayMs(startupDelayMs))
          return
        }
        arm(plan.delayMs)
      }

      /**
       * 「刚装上/刚卸掉/刚改过启用状态」也属于该立刻看一眼的时刻。
       *
       * 这条订阅补的是**运行中安装**：用户在界面上点「安装」或执行
       * `dsh plugin add` 之后，本插件不会重新 apply（HMR 一般不重载 Host），
       * 如果只靠定时器，装完仍要等一个间隔才第一次检查。事件一到就把排期
       * 提前到秒级——`plugin-manager/changed` 在 manager 的操作结束时同步发出，
       * 此时 profile 已落盘，正好是检查的最佳时机。
       */
      const offChanged = ctx.on?.('plugin-manager/changed', () => {
        if (!alive) return
        if (inFlight) {
          recheckRequested = true
          return
        }
        arm(resolveRecheckDelayMs(startupDelayMs))
      })

      // 加载完立即跑第一次：装完插件 / 重启 DSH 的那一刻最该看一眼。
      // startupDelayMs 只用来躲开 profile 收敛，不是一个完整周期。
      arm(startupDelayMs)
      logger.warn?.(`[workbuddy-guard] 自带定时已启用：加载后 ${Math.round(startupDelayMs / 1000)} 秒首次检查，之后每 ${intervalMinutes} 分钟一次`)
      return () => {
        alive = false
        if (timer !== undefined) clearTimeout(timer)
        if (typeof offChanged === 'function') offChanged()
      }
    }, 'workbuddy-guard: self schedule')
  } else {
    logger.warn?.('[workbuddy-guard] 自带定时已关闭（selfSchedule: false），依赖外部定时器')
  }

  // ---- 启动即读一次，然后轮询 -----------------------------------------
  ctx.effect(() => {
    let alive = true
    let timer
    const tick = async () => {
      if (!alive) return
      try { await poll() } catch (error) {
        logger.error?.(`[workbuddy-guard] poll 失败: ${error?.message || error}`)
      }
      if (alive) timer = setTimeout(tick, pollMs)
      timer?.unref?.()
    }
    /**
     * 首轮**不能**在 `apply()` 里同步跑。
     *
     * `apply()` 执行时，Cordis 可能正处在一个 HMR 事务里（本插件刚被安装、
     * 刚被 reconcile 之后就是这种情况）。而 `pluginManager.updateBundle()`
     * 内部的 `configure()` 会调 `hmr.runExclusive()`——于是首轮 poll 里的升级
     * 就会撞上「HMR transactions cannot be nested」。
     *
     * 推到下一个宏任务就够了：那时 `apply()` 已经返回，事务也结束了。
     * 水印与软结束不依赖这一轮，晚一个 tick 没有任何可观察差别。
     */
    const first = setTimeout(tick, 0)
    first?.unref?.()
    return () => {
      alive = false
      clearTimeout(first)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, 'workbuddy-guard: poll')
}

/** 浏览器半可以查询的水印默认文案。 */
export const DEFAULT_WATERMARK = {
  level: 'danger',
  title: 'WB 更新了',
  body: '还用，你的账号是批发的吗？',
}

/** 测试出口：不参与插件契约，只有 test/ 里的用例 import 它。 */
export { usesWorkbuddy, resolveStartupDelayMs, resolveRecheckDelayMs, planNextCheck, DEFAULT_STARTUP_DELAY_MS, MISSING_RETRY_MS, MISSING_RETRY_LIMIT, EVENT_RECHECK_DELAY_MS }
