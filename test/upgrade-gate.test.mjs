// 升级确认卡片（upgradeGate）—— 回归用例。
//
// 需求（2026-11-13）：DSH Desktop 的 `pluginManager.updateBundle()` 是
// **先 remove 再 install** 两步，中间 `node_modules/dsh-connect-workbuddy`
// 在磁盘上真的不存在。正在跑的 wb 会话如果那一刻发请求，就是一次注定失败的
// 调用——任务断掉，用户还得手动说「继续」。npm / `dsh plugin add` 那条路
// 没有这个空窗。
//
// 所以 Desktop 上：先弹一张「现在升级吗」，点了才动手；升级前暂停会话，
// 装好后自动让它们继续。
//
// 本用例覆盖三件事：
//   1. 该拦的时候拦得住（Desktop + 有会话 + 未批准 → 不升级，只挂卡片）
//   2. 不该拦的时候不拦（无会话 / 非 Desktop → 直接升）
//   3. 批准与推迟的落盘语义（upgradeGate.approved / upgradeSnoozeUntil）
//
// 跑：node test/upgrade-gate.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const cases = []
const test = (name, fn) => cases.push({ name, fn })

/**
 * 搭一个只够跑 `pollOnce` 的环境。
 *
 * `pluginManager.updateBundle` 被换成一个记账桩：调用一次就在 `upgrades`
 * 里留一条。断言「有没有真的去升级」全看这个数组。
 */
function makeEnv({ agents = [], electron = true, upgrade = null, gate = null, snoozeUntil = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'wb-gate-'))
  const stateDir = join(home, 'workbuddy-update-watch')
  mkdirSync(stateDir, { recursive: true })
  const guardPath = join(stateDir, 'guard.json')
  writeFileSync(guardPath, `${JSON.stringify({
    schema: 1,
    revision: 30,
    watermark: null,
    stopSessions: null,
    upgrade,
    ...(gate === null ? {} : { upgradeGate: gate }),
    ...(snoozeUntil === null ? {} : { upgradeSnoozeUntil: snoozeUntil }),
  }, null, 2)}\n`, { mode: 0o600 })

  const routes = new Map()
  const upgrades = []
  const cancels = []
  const followups = []

  // 假 agent：`status` 可变，用来模拟「暂停之后真的停了」
  const fakeAgents = agents.map((id) => ({
    id,
    status: 'running',
    options: { provider: 'workbuddy', model: 'wb-1' },
    session: { ownEvents: () => [] },
    inbox: { nextTurn: [], nextStep: [] },
    cancel(cause, opts) {
      cancels.push({ id, cause, opts })
      this.status = 'inactive'
    },
    followup(message) { followups.push({ id, message }) },
  }))

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(run) { return run() },
    on() { return () => {} },
    get(name) {
      if (name === 'pluginManager') {
        return {
          async listBundles() {
            return [{ name: 'dsh-connect-workbuddy', installed: true, enabled: true }]
          },
          async updateBundle(pkg, version) {
            upgrades.push({ pkg, version })
            return { result: { application: 'applied', version } }
          },
        }
      }
      if (name === 'sessionProjections') {
        // 这个假环境里所有会话都算「在用 workbuddy」
        return { snapshot: () => ({ values: { modelSelection: { next: { provider: 'workbuddy', model: 'wb-1' } } } }) }
      }
      return undefined
    },
    webServer: { register: (spec) => { routes.set(spec.path, spec.handler); return () => {} } },
    agents: {
      list: () => fakeAgents,
      get: (id) => fakeAgents.find((a) => a.id === id),
    },
  }

  const readState = () => {
    const out = { status: null, body: '' }
    const res = {
      writeHead(status) { out.status = status },
      end(chunk) { out.body = chunk ?? '' },
    }
    routes.get('/plugins/dsh-workbuddy-account-care/state')({}, res)
    return JSON.parse(out.body)
  }

  const settle = async (out) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && out.body === '') await sleep(10)
    return { status: out.status, payload: JSON.parse(out.body || '{}') }
  }

  const post = async (action) => {
    const out = { status: null, body: '' }
    const res = {
      writeHead(status) { out.status = status },
      end(chunk) { out.body = chunk ?? '' },
    }
    const req = {
      method: 'POST',
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ action })) },
    }
    routes.get('/plugins/dsh-workbuddy-account-care/action')(req, res)
    return settle(out)
  }

  return {
    home, guardPath, ctx, readState, post,
    upgrades, cancels, followups, fakeAgents,
    cleanup() { rmSync(home, { recursive: true, force: true }) },
    /** 模拟 Electron 宿主：`apply()` 里读的就是这个属性。 */
    setElectron(on) {
      if (on) process.versions.electron = '30.0.0'
      else delete process.versions.electron
    },
  }
}

const UPGRADE = { revision: 7, from: '5.21.0', to: '5.21.2', spec: 'dsh-connect-workbuddy@5.21.2', status: 'pending', attempts: 1 }

/**
 * 1) Desktop + 有会话在跑 + 未批准 → **不能升级**，只挂确认卡片。
 *
 * 这是本次需求的核心断言：以前这里会直接 `updateBundle`，把正在跑的会话
 * 扔进 remove→install 的空窗里。
 */
test('Desktop + 有会话 + 未批准 → 只弹卡片，不升级', async () => {
  const env = makeEnv({ agents: ['s1'], upgrade: UPGRADE })
  env.setElectron(true)
  process.env.DSH_HOME = env.home
  try {
    apply(env.ctx, { selfSchedule: false, pollMs: 300, notify: false, startupDelayMs: 0 })
    await sleep(1200)

    assert.equal(env.upgrades.length, 0,
      `不该动磁盘，实际升级了 ${JSON.stringify(env.upgrades)}`)

    const state = env.readState()
    assert.ok(state.watermark, '应当挂一张确认卡片')
    assert.equal(state.watermark.upgradeGate !== undefined, true, '卡片应当带 upgradeGate 标记')
    assert.deepEqual(state.watermark.actions, ['upgrade-now', 'upgrade-later'],
      `按钮应当是「现在升级 / 稍后」，实际 ${JSON.stringify(state.watermark.actions)}`)
    assert.equal(state.watermark.level, 'warning', '这是维护提醒，不是危险告警，该用 warning')
  } finally {
    delete process.versions.electron
    env.cleanup()
  }
})

/** 2) 没有会话在跑 → 静默升级，不打扰。 */
test('Desktop + 无会话 → 直接升级，不弹卡片', async () => {
  const env = makeEnv({ agents: [], upgrade: UPGRADE })
  env.setElectron(true)
  process.env.DSH_HOME = env.home
  try {
    apply(env.ctx, { selfSchedule: false, pollMs: 300, notify: false, startupDelayMs: 0 })
    await sleep(1200)

    assert.equal(env.upgrades.length, 1,
      `没有会话就该静默升级，实际 ${env.upgrades.length} 次`)
    assert.equal(env.upgrades[0].version, '5.21.2')
    assert.equal(env.cancels.length, 0, '没有会话，不该有 cancel')
    // 升级后的通知卡应当出现（「插件已升级」）
    const state = env.readState()
    assert.ok(state.watermark?.dismissible === true || state.watermark?.untilRestart === true,
      `应当挂升级完成通知，实际 ${JSON.stringify(state.watermark)}`)
  } finally {
    delete process.versions.electron
    env.cleanup()
  }
})

/** 3) 非 Desktop（npm / CLI 路径）→ 没有空窗，不该拦，也不需要暂停。 */
test('非 Desktop + 有会话 → 直接升级，不 pause（npm 路径无空窗）', async () => {
  const env = makeEnv({ agents: ['s1'], upgrade: UPGRADE })
  env.setElectron(false)
  process.env.DSH_HOME = env.home
  try {
    apply(env.ctx, { selfSchedule: false, pollMs: 300, notify: false, startupDelayMs: 0 })
    await sleep(1200)

    assert.equal(env.upgrades.length, 1, '非 Desktop 不该被拦')
    assert.equal(env.cancels.length, 0, '非 Desktop 没有 remove→install 空窗，不该 cancel 会话')
    assert.equal(env.followups.length, 0, '没暂停过就不该发「继续」消息')
  } finally {
    delete process.versions.electron
    env.cleanup()
  }
})

/**
 * 4) 用户点「现在升级」→ 落盘批准 → 下一轮真的升，并且**先暂停再恢复**。
 *
 * 这是整条链路最重要的一条：卡片 → 批准 → 暂停 → 安装 → 自动继续。
 */
test('点「现在升级」→ 落盘 approved → 暂停会话 → 升级 → 自动继续', async () => {
  const env = makeEnv({ agents: ['s1'], upgrade: UPGRADE })
  env.setElectron(true)
  process.env.DSH_HOME = env.home
  try {
    apply(env.ctx, { selfSchedule: false, pollMs: 300, notify: false, startupDelayMs: 0 })
    await sleep(1000)
    assert.equal(env.upgrades.length, 0, '前置：还没批准，不该升级')

    const res = await env.post('upgrade-now')
    assert.equal(res.payload.ok, true, `点「现在升级」应当成功，实际 ${JSON.stringify(res.payload)}`)

    const disk = JSON.parse(readFileSync(env.guardPath, 'utf8'))
    assert.equal(disk.upgradeGate.approved, true, '批准应当落盘成 upgradeGate.approved')
    assert.equal(disk.upgradeGate.revision, 7, '批准要绑到这条升级指令的 revision 上')

    // 等下一轮 poll 把批准消费掉
    await sleep(1600)

    assert.equal(env.upgrades.length, 1, `批准之后应当真的升级，实际 ${env.upgrades.length} 次`)
    assert.ok(env.cancels.length >= 1, `升级前应当暂停会话，实际 cancel ${env.cancels.length} 次`)

    /**
     * **两条消息，顺序不能反**：先「暂停」，再「继续」。
     *
     * 这条断言是修出来的：我一度把暂停改成不发消息的纯 cancel，理由是
     * 「暂停消息会起一轮新请求、撞上空窗」。那个理由站不住——`waitForWorkbuddyIdle`
     * 就在装包**之前**等那一轮跑完。而不发消息的后果是会话被无声中断，
     * 用户只看到一轮莫名中止，再接一句没头没尾的「请继续」。
     */
    assert.equal(env.followups.length, 2,
      `应当先发暂停、再发恢复共 2 条，实际 ${env.followups.length} 条：${JSON.stringify(env.followups.map((f) => f.message.content[0].text.slice(0, 20)))}`)

    const pauseText = env.followups[0].message.content[0].text
    assert.ok(pauseText.includes('即将升级'), `第一条应当是暂停通知，实际「${pauseText}」`)
    assert.ok(pauseText.includes('保存当前进度'),
      `暂停消息要说清「先存进度」，否则 agent 只是被打断而已，实际「${pauseText}」`)

    const resumeText = env.followups[1].message.content[0].text
    assert.ok(resumeText.includes('请继续之前未完成的任务'),
      `第二条应当是恢复通知，实际「${resumeText}」`)
    assert.ok(resumeText.includes('5.21.2'), '恢复消息应当提到新版本，方便用户回看')

    /**
     * **升级完成后必须挂「插件已升级」水印。**
     *
     * 实机跑到过一次 `state.watermark === null`（而同一时刻磁盘上有水印），
     * 当时没定位到原因。这条断言把 gate 路径的**终点**钉死：只要这条路
     * 走通，水印就必须在 `state` 和磁盘上都出现。以后再出现那种不一致，
     * 这里会先红，而不是等到用户说「升级完怎么什么都没提示」。
     */
    const state = env.readState()
    assert.ok(state.watermark !== null && state.watermark !== undefined,
      `升级完成后应当挂「插件已升级」水印，实际 ${JSON.stringify(state.watermark)}`)
    assert.equal(state.watermark.title, '插件已升级')
    assert.equal(state.watermark.dismissible, true,
      '热生效的升级通知应当可被「知道了」永久收起')
    const diskWm = JSON.parse(readFileSync(env.guardPath, 'utf8')).watermark
    assert.ok(diskWm !== null && diskWm !== undefined,
      `磁盘上也应当有水印，实际 ${JSON.stringify(diskWm)}`)
    assert.equal(diskWm.title, '插件已升级')
  } finally {
    delete process.versions.electron
    env.cleanup()
  }
})

/** 5) 用户点「稍后」→ 落盘推迟时间点，且**不升级**。 */
test('点「稍后」→ 落盘 upgradeSnoozeUntil → 到期前不升级也不再弹', async () => {
  const env = makeEnv({ agents: ['s1'], upgrade: UPGRADE })
  env.setElectron(true)
  process.env.DSH_HOME = env.home
  try {
    apply(env.ctx, { selfSchedule: false, pollMs: 300, notify: false, startupDelayMs: 0 })
    await sleep(1000)

    const res = await env.post('upgrade-later')
    assert.equal(res.payload.ok, true, `点「稍后」应当成功，实际 ${JSON.stringify(res.payload)}`)

    const disk = JSON.parse(readFileSync(env.guardPath, 'utf8'))
    assert.ok(typeof disk.upgradeSnoozeUntil === 'string', '应当落盘一个推迟截止时间')
    const until = Date.parse(disk.upgradeSnoozeUntil)
    assert.ok(until > Date.now(), `推迟截止时间应当在未来，实际 ${disk.upgradeSnoozeUntil}`)
    assert.equal(disk.upgradeGate.approved, false, '推迟不是批准')

    await sleep(1600)
    assert.equal(env.upgrades.length, 0, '推迟期间不该升级')
    assert.equal(env.readState().watermark, null, '推迟之后不该还挂着那张卡片')
  } finally {
    delete process.versions.electron
    env.cleanup()
  }
})

/** 6) 推迟已过期 → 重新问一次（不能永久静默）。 */
test('推迟已过期 → 重新弹卡片', async () => {
  const expired = new Date(Date.now() - 60_000).toISOString()
  const env = makeEnv({ agents: ['s1'], upgrade: UPGRADE, snoozeUntil: expired })
  env.setElectron(true)
  process.env.DSH_HOME = env.home
  try {
    apply(env.ctx, { selfSchedule: false, pollMs: 300, notify: false, startupDelayMs: 0 })
    await sleep(1200)

    assert.equal(env.upgrades.length, 0, '过期只代表「可以再问」，不代表「自动升」')
    const state = env.readState()
    assert.ok(state.watermark?.upgradeGate !== undefined,
      `推迟过期后应当重新问，实际 ${JSON.stringify(state.watermark)}`)
  } finally {
    delete process.versions.electron
    env.cleanup()
  }
})

/** 7) 批准是**一次性**的：换一条升级指令就不再有效。 */
test('批准绑 revision：换一条升级指令后重新问', async () => {
  const staleGate = { revision: 6, approved: true, approvedAt: new Date().toISOString() }
  const env = makeEnv({ agents: ['s1'], upgrade: UPGRADE, gate: staleGate })
  env.setElectron(true)
  process.env.DSH_HOME = env.home
  try {
    apply(env.ctx, { selfSchedule: false, pollMs: 300, notify: false, startupDelayMs: 0 })
    await sleep(1200)

    assert.equal(env.upgrades.length, 0,
      '批准绑在旧 revision 6 上，当前指令是 7，不该放行')
    assert.ok(env.readState().watermark?.upgradeGate !== undefined, '应当重新挂卡片')
  } finally {
    delete process.versions.electron
    env.cleanup()
  }
})

/**
 * 8) 推迟到期之后必须**重新弹卡片**。
 *
 * 这条是从实现里挖出来的真 bug（2026-11-13）：早先「挂过卡片」与「记过推迟
 * 日志」共用一个 `pendingUpgradeGateRevision`，用户一点「稍后」它就被置成
 * 当前 revision；30 分钟后推迟到期、重新进 gate 分支时，去重判据
 * `!== revision` 已不成立，于是**卡片再也不弹**，升级被永久静默。
 *
 * 症状很隐蔽：不报错、不写日志，只是从某一天起插件再也不升级了。
 * 所以这条用例守的是「重弹」这件事本身，与推迟时长无关。
 */
test('点「稍后」→ 推迟到期 → 必须重新弹卡片（不能永久静默）', async () => {
  const env = makeEnv({ agents: ['s1'], upgrade: UPGRADE })
  env.setElectron(true)
  process.env.DSH_HOME = env.home
  try {
    apply(env.ctx, { selfSchedule: false, pollMs: 300, notify: false, startupDelayMs: 0 })
    await sleep(1000)

    await env.post('upgrade-later')
    await sleep(600)
    assert.equal(env.readState().watermark, null, '推迟之后卡片应当收起来')

    // 把推迟截止时间改到过去，模拟 30 分钟过去了
    const disk = JSON.parse(readFileSync(env.guardPath, 'utf8'))
    disk.upgradeSnoozeUntil = new Date(Date.now() - 1000).toISOString()
    writeFileSync(env.guardPath, `${JSON.stringify(disk, null, 2)}\n`, { mode: 0o600 })

    await sleep(1500)
    const state = env.readState()
    assert.ok(state.watermark?.upgradeGate !== undefined,
      `推迟到期后卡片必须重新出现，实际 ${JSON.stringify(state.watermark)}`)
  } finally {
    delete process.versions.electron
    env.cleanup()
  }
})

/**
 * 9) 三条消息的去重标记必须互不包含。
 *
 * 它们都带「本条消息由监控插件自动发送」这半句（都是本插件发的）。早先
 * `SOFT_STOP_MARKER` 就是那半句本身，于是：
 *
 *   · 收件箱里躺过一条「升级暂停」→ 真正的**软结束**（WB 变了、可能封号）
 *     被当成「已经停过了」跳过，唯一要紧的那条提示发不出去；
 *   · 反过来，暂停也会被软结束挡掉。
 *
 * 这类串味不会报错，只会让某条该发的消息永远发不出去。所以直接用文案本身
 * 断言，不依赖任何一次端到端流程碰巧覆盖到。
 */
test('三条消息的去重标记互不包含（软结束 / 升级暂停 / 升级恢复）', async () => {
  /**
   * 从模块里读常量，不用正则去解析源码——早先那版用 `([\s\S]*?)\n\n` 截取
   * 定义，紧跟着的文档注释里只要有空行就会截歪，报「找不到定义」。
   *
   * `index.js` 没有把这些常量 `export`，所以退一步：用一个假的 ctx 跑
   * `apply()`，从它实际发出的消息里取文案。这样断言的是**真正的行为**，
   * 而不是「源码里字符串长什么样」。
   */
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const readConst = (name) => {
    // 从 `const NAME =` 开始，读到这个语句结束（第一个空行）
    const start = source.indexOf(`const ${name} = `)
    assert.notEqual(start, -1, `index.js 里找不到 const ${name}`)
    const rest = source.slice(start + `const ${name} = `.length)
    /**
     * 必须按 `/\r?\n\r?\n/` 切，不能写死 `'\n\n'`。
     *
     * 这个仓库的源文件是 CRLF（`git ls-files --eol index.js` → `i/crlf`）。
     * 写死 `'\n\n'` 时切不开，`block` 会吞掉整个文件剩下的一半，然后
     * 把后面所有字符串字面量都当成这个常量的内容——断言于是永远为真，
     * 用例形同虚设（实际报的是 `soft contains pause: true`）。
     */
    const block = rest.split(/\r?\n\r?\n/)[0]
    const quoted = [...block.matchAll(/'([^']*)'/g)].map((m) => m[1])
    assert.ok(quoted.length > 0, `${name} 里没找到字符串字面量`)
    /**
     * 跨行拼接（`'a' + 'b'`）会得到两个片段，这里按出现顺序接起来。
     * 只在**同一个语句块**内拼接，所以不会像刚才那样把后面的常量也吃进来。
     */
    return quoted.join('')
  }
  const soft = readConst('SOFT_STOP_MARKER')
  const pause = readConst('PAUSE_MARKER')
  const resume = readConst('RESUME_MARKER')

  const pairs = [
    ['软结束', soft, '暂停', pause],
    ['软结束', soft, '恢复', resume],
    ['暂停', pause, '恢复', resume],
  ]
  for (const [aName, a, bName, b] of pairs) {
    assert.equal(a.includes(b), false, `${aName}标记「${a}」不该包含${bName}标记「${b}」`)
    assert.equal(b.includes(a), false, `${bName}标记「${b}」不该包含${aName}标记「${a}」`)
  }

  // 脚本写的 STOP_TEXT 必须仍能被 SOFT_STOP_MARKER 认出来
  const watch = readFileSync(new URL('../scripts/watch.mjs', import.meta.url), 'utf8')
  const stopText = watch.match(/const STOP_TEXT = '([^']*)'/)?.[1] ?? ''
  assert.ok(stopText.includes(soft),
    '脚本的 STOP_TEXT 必须含 SOFT_STOP_MARKER，否则脚本写的暂停指令与插件去重判据对不上')
})

/**
 * 每个用例跑在**独立子进程**里。
 *
 * 为什么不能在一个进程里顺序跑完：`apply()` 启动的 guard.json 轮询没有
 * 「停掉」的入口（`selfSchedule: false` 只关掉 watch.mjs 的定时，不关这个）。
 * 而 `guardFile()` 每轮都重新读 `process.env.DSH_HOME`，于是前一个用例留下的
 * 实例会跟着 `DSH_HOME` 一起漂到当前用例的目录，抢先把升级做掉——它的
 * `upgrades` 数组当然还是空的，断言就假红。
 *
 * 实测症状（2026-11-13）：日志里明明有「开始升级 / 升级完成」，用例却报
 * 「实际升级了 0 次」。子进程隔离是这里唯一干净的解法。
 */
const ONLY = process.argv[2] === '--case' ? Number(process.argv[3]) : null

if (ONLY === null) {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const self = fileURLToPath(import.meta.url)
  let failed = 0
  for (const [index, item] of cases.entries()) {
    const run = spawnSync(process.execPath, [self, '--case', String(index)], {
      encoding: 'utf8',
      env: { ...process.env },
    })
    const ok = run.status === 0
    if (!ok) failed += 1
    console.log(`  ${ok ? '✓' : '✗'} ${item.name}`)
    if (!ok) {
      const detail = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim().split('\n')
      console.log(`    ${detail[detail.length - 1] ?? '(无输出)'}`)
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} 通过`)
  process.exit(failed === 0 ? 0 : 1)
}

try {
  await cases[ONLY].fn()
  process.exit(0)
} catch (error) {
  console.log(String(error?.message || error).split('\n').slice(0, 3).join('\n'))
  process.exit(1)
}
