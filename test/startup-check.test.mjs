// 首次检查时机的回归用例。
//
// 起因（2026-11-06）：装完插件、或者重启 DSH 之后，要等满 `intervalMinutes`
// （默认 3 分钟）才做第一次检查。而那恰恰是最该看一眼的时刻——目标插件可能刚
// 被升级，WorkBuddy 客户端也可能刚更新。用户要的是「加载后就执行一次」。
//
// 两条断言：
//   1. 首次排期的延迟是秒级（`resolveStartupDelayMs`），不是 3 分钟；
//   2. 「目标未就绪」时用短间隔重试、就绪后立刻回到常规节奏（`planNextCheck`）。
// 两者都是纯函数，不需要真的等 3 分钟，也不会起子进程。
//
// 跑：node test/startup-check.test.mjs
import assert from 'node:assert/strict'
import {
  resolveStartupDelayMs,
  resolveRecheckDelayMs,
  planNextCheck,
  DEFAULT_STARTUP_DELAY_MS,
  MISSING_RETRY_MS,
  MISSING_RETRY_LIMIT,
  EVENT_RECHECK_DELAY_MS,
} from '../index.js'

const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ---- 1. 首次延迟 ----

test('缺省 → 秒级默认值，绝不是一个间隔', () => {
  const ms = resolveStartupDelayMs(undefined)
  assert.equal(ms, DEFAULT_STARTUP_DELAY_MS)
  assert.ok(ms < 60_000, `首次延迟必须远小于一分钟，实际 ${ms}ms`)
})

test('显式 0 → 立刻', () => {
  assert.equal(resolveStartupDelayMs(0), 0)
  assert.equal(resolveStartupDelayMs('0'), 0)
})

test('允许改大（慢机器等 profile 收敛）', () => {
  assert.equal(resolveStartupDelayMs(15_000), 15_000)
  assert.equal(resolveStartupDelayMs('2500'), 2_500)
})

test('垃圾值 / 负数 / null / 空串 → 退回默认，不能被误读成 0', () => {
  for (const bad of [null, '', '   ', 'abc', NaN, -1, Infinity, {}, [], true, false]) {
    assert.equal(resolveStartupDelayMs(bad), DEFAULT_STARTUP_DELAY_MS, `${JSON.stringify(bad)} 应退回默认`)
  }
})

// ---- 2. 后续节奏 ----

test('目标已就绪 → 下一轮按 intervalMinutes', () => {
  const plan = planNextCheck({ installed: true, missingRetries: 3, intervalMinutes: 3 })
  assert.equal(plan.delayMs, 180_000)
  assert.equal(plan.missingRetries, 0, '真正检查过就不能把重试计数留着')
  assert.equal(plan.event, 'ok')
})

test('目标未就绪 → 短间隔重试，且计数递增', () => {
  const plan = planNextCheck({ installed: false, missingRetries: 0, intervalMinutes: 3 })
  assert.equal(plan.delayMs, MISSING_RETRY_MS)
  assert.equal(plan.missingRetries, 1)
  assert.equal(plan.event, 'retry')
  assert.ok(plan.delayMs < 180_000, '重试必须快于常规间隔')
})

test('连续未就绪 → 重试用尽后回到常规节奏，且只认一次「放弃」', () => {
  let retries = 0
  for (let i = 0; i < MISSING_RETRY_LIMIT; i += 1) {
    const plan = planNextCheck({ installed: false, missingRetries: retries, intervalMinutes: 3 })
    assert.equal(plan.event, 'retry')
    retries = plan.missingRetries
  }
  const final = planNextCheck({ installed: false, missingRetries: retries, intervalMinutes: 3 })
  assert.equal(final.event, 'given-up')
  assert.equal(final.delayMs, 180_000)
})

test('判不了（installed 为 undefined）→ 当作已就绪，交给脚本自己判', () => {
  const plan = planNextCheck({ installed: undefined, missingRetries: 0, intervalMinutes: 3 })
  assert.equal(plan.event, 'ok')
  assert.equal(plan.delayMs, 180_000)
})

test('重试过又恢复 → 计数归零，不会把下一次误当重试', () => {
  const healed = planNextCheck({ installed: true, missingRetries: 4, intervalMinutes: 3 })
  assert.equal(healed.missingRetries, 0)
  assert.equal(healed.delayMs, 180_000)
})

// ---- 3. 运行中安装/卸载：补跑一次 ----

test('插件变更事件 → 也走秒级补跑（覆盖「运行中才装上」）', () => {
  const delay = resolveRecheckDelayMs(DEFAULT_STARTUP_DELAY_MS)
  assert.equal(delay, EVENT_RECHECK_DELAY_MS)
  assert.ok(delay < 5_000, `补跑应当几乎立刻，实际 ${delay}ms`)
})

test('startupDelayMs 配成 0 时，事件补跑也跟着是 0', () => {
  assert.equal(resolveRecheckDelayMs(0), 0)
})

test('startupDelayMs 配得很大时，事件补跑不会被拖慢', () => {
  assert.equal(resolveRecheckDelayMs(120_000), EVENT_RECHECK_DELAY_MS)
})

let failed = 0
for (const { name, fn } of cases) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${String(error?.message || error).split('\n')[0]}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
