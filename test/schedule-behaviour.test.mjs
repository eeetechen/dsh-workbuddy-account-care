// 排期行为的集成用例：用假 ctx 驱动 apply()，验证
//   1. 加载后立刻跑第一次；
//   2. 运行中收到 plugin-manager/changed 会补跑一次；
//   3. 检查进行中再收到事件，不会并发派生两次（只能有一次在飞）。
//
// watch 脚本是包里那份真脚本，用 DSH_HOME 指向临时目录做隔离，
// 并用 WORKBUDDY_WATCH_UPSTREAM 指向一个不可达地址让它秒回，避免联网等待。
//
// 跑：node test/schedule-behaviour.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, DEFAULT_STARTUP_DELAY_MS, EVENT_RECHECK_DELAY_MS } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'wb-sched-'))
const logFile = join(dir, 'workbuddy-update-watch', 'watch.log')
process.env.DSH_HOME = dir
// 不可达地址：脚本会立刻失败返回，不阻塞用例
process.env.WORKBUDDY_WATCH_UPSTREAM = 'http://127.0.0.1:1/v2/update'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 数脚本写了几行日志 = 它真的被派生并跑完了几轮。
 *
 * 不数「检查 #N」：临时 DSH_HOME 里没有装 `dsh-connect-workbuddy`，
 * 脚本会在前置检查处安静跳过、只写一行「跳过本次检查」。那同样是
 * **一次真实的派生**，正是本用例要观察的东西。
 */
function checkCount() {
  if (!existsSync(logFile)) return 0
  return readFileSync(logFile, 'utf8').split('\n').filter((line) => line.trim() !== '').length
}

function makeCtx({ beforeListBundles } = {}) {
  const listeners = new Map()
  const disposers = []
  const logs = []
  const ctx = {
    logs,
    listBundlesCalls: 0,
    listeners,
    logger: {
      info() {},
      warn: (m) => logs.push(String(m)),
      error: (m) => logs.push(`ERR ${m}`),
    },
    effect(run) {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const current = listeners.get(name) ?? []
        listeners.set(name, current.filter((one) => one !== listener))
      }
    },
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) listener(payload)
    },
    get(name) {
      if (name === 'pluginManager') {
        return {
          async listBundles() {
            ctx.listBundlesCalls += 1
            if (beforeListBundles !== undefined) await beforeListBundles()
            return [{ name: 'dsh-connect-workbuddy', installed: true, enabled: true }]
          },
        }
      }
      if (name === 'sessionProjections') return { snapshot: () => ({ values: {} }) }
      return undefined
    },
    webServer: { register: () => {} },
    agents: { list: () => [] },
    disposeAll() { for (const dispose of disposers.splice(0).reverse()) dispose() },
  }
  return ctx
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })

test('加载后立刻跑第一次（startupDelayMs: 0）', async () => {
  const ctx = makeCtx()
  try {
    apply(ctx, { startupDelayMs: 0, intervalMinutes: 60, notify: false, pollMs: 600_000 })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && checkCount() === 0) await sleep(100)
    assert.ok(checkCount() >= 1, '加载后 20 秒内应当至少跑完一轮')
  } finally {
    ctx.disposeAll()
  }
})

test('运行中收到 plugin-manager/changed → 补跑一次', async () => {
  const ctx = makeCtx()
  try {
    // 起点故意给一个大延迟：若事件不生效，20 秒内不会有第二轮
    apply(ctx, { startupDelayMs: 0, intervalMinutes: 60, notify: false, pollMs: 600_000 })
    const first = Date.now() + 20_000
    while (Date.now() < first && checkCount() === 0) await sleep(100)
    const before = checkCount()
    assert.ok(before >= 1, '前置：第一轮应当已经跑完')

    ctx.emit('plugin-manager/changed', { reason: 'install' })
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && checkCount() <= before) await sleep(100)
    assert.equal(checkCount(), before + 1, `事件后应当恰好补跑一次，实际 ${checkCount() - before} 次`)
  } finally {
    ctx.disposeAll()
  }
})

test('检查进行中连发多个事件 → 不并发，只补跑一次', async () => {
  // 让 listBundles 挂住，就能把 tick 精确停在 inFlight 窗口里——这才是
  // 「检查进行中」的真实形状（而不是脚本已经跑完、事件落在空闲期）。
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = makeCtx({
    beforeListBundles: () => gate,
  })
  const baseline = checkCount()
  try {
    apply(ctx, { startupDelayMs: 0, intervalMinutes: 60, notify: false, pollMs: 600_000 })
    // 等第一轮真的进到 listBundles
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && ctx.listBundlesCalls === 0) await sleep(50)
    assert.ok(ctx.listBundlesCalls >= 1, '前置：第一轮应当已经进入检查')

    for (let i = 0; i < 5; i += 1) {
      ctx.emit('plugin-manager/changed', { reason: 'install' })
      await sleep(20)
    }
    release()
    const until = Date.now() + 15_000
    while (Date.now() < until) await sleep(200)
    const total = checkCount() - baseline
    assert.ok(total >= 1, '至少要跑完一轮')
    // 一进一出：卡住那轮 + 合并后的补跑。绝不应该是 1 + 5。
    assert.ok(total <= 3, `5 个事件不该变成 5 轮；实际 ${total} 轮`)
  } finally {
    release?.()
    ctx.disposeAll()
  }
})

test('默认值仍应是秒级延迟（不是几分钟）', () => {
  assert.ok(DEFAULT_STARTUP_DELAY_MS <= 10_000)
  assert.ok(EVENT_RECHECK_DELAY_MS <= DEFAULT_STARTUP_DELAY_MS)
})

let failed = 0
for (const { name, fn } of cases) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${String(error?.message || error).split('\n')[0]}`)
  }
}

try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录 */ }
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
