// 端到端：用假 ctx 真跑一遍 apply()，验证「加载后立刻派生一次检查」。
//
// 用 `--state-dir` 把状态指向临时目录，脚本本身仍是包里那份真脚本
// （`--check --no-notify --dry-run` 的组合不写 profile、不弹通知），
// 所以这里观察到的是真实行为，而不是桩。
//
// 注意：这条用例会联网（读 WorkBuddy 更新接口与 npm）。网络不通时脚本会
// 返回 `judgedVersion: null` 并正常退出——对本用例没有影响，我们只在乎
// 「派生发生在什么时刻、发生了几次」。
//
// 跑：node test/e2e-startup.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, DEFAULT_STARTUP_DELAY_MS } from '../index.js'


/**
 * 假 Host ctx：只实现 apply 会碰到的面。
 *
 * 隔离手段是 `DSH_HOME`：被派生的脚本从环境变量继承它，于是状态目录、
 * 日志、profile 全都落在临时目录里，不会碰到真实的 `~/.dsh`。
 */
function fakeCtx() {
  const disposers = []
  return {
    logger: { info() {}, warn() {}, error() {} },
    effect(run) {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    get(name) {
      if (name === 'pluginManager') {
        return { async listBundles() { return [{ name: 'dsh-connect-workbuddy', installed: true, enabled: true }] } }
      }
      if (name === 'sessionProjections') return { snapshot: () => ({ values: {} }) }
      return undefined
    },
    webServer: { register: () => {} },
    agents: { list: () => [] },
    // 刻意**不** unref：apply 里的定时器都是 unref 的，若这里也 unref，
    // 事件循环会立刻空转退出，测试就看不到任何结果。
    async settle(ms) {
      await new Promise((resolve) => { setTimeout(resolve, ms) })
    },
    disposeAll() { for (const d of disposers.splice(0).reverse()) d() },
  }
}

const dir = mkdtempSync(join(tmpdir(), 'wb-guard-home-'))
/** 脚本把日志写到 `$DSH_HOME/workbuddy-update-watch/watch.log`。 */
const logFile = join(dir, 'workbuddy-update-watch', 'watch.log')
process.env.DSH_HOME = dir
process.env.WORKBUDDY_WATCH_VERBOSE = '1'
const ctx = fakeCtx()
const startedAt = Date.now()
const warnings = []
ctx.logger.warn = (msg) => warnings.push(String(msg))

apply(ctx, { startupDelayMs: 0, intervalMinutes: 60, notify: false, pollMs: 60_000 })

let firstLine = null
try {
  // 最多等 30 秒让第一轮跑完（脚本要联网，正常 1~5 秒）
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(logFile)) {
      const text = readFileSync(logFile, 'utf8').trim()
      if (text !== '') { firstLine = text.split('\n')[0]; break }
    }
    await ctx.settle(200)
  }
} finally {
  ctx.disposeAll()
}

let failed = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`) } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${String(error?.message || error).split('\n')[0]}`)
  }
}

console.log(`  · 启动日志：${warnings[0] ?? '(无)'}`)
check('加载后安排了首次检查（日志里能看到排期）', () => {
  assert.ok(warnings.some((w) => w.includes('首次检查')), '缺少「首次检查」排期日志')
})
check('首次检查在加载后几秒内就真的跑起来了（不是 3 分钟后）', () => {
  assert.ok(firstLine !== null, `等了 30 秒也没看到脚本写下第一条日志；checked ${logFile}`)
})
check('首次延迟配置确实没有退化成 intervalMinutes', () => {
  assert.ok(DEFAULT_STARTUP_DELAY_MS < 60_000)
  assert.equal(DEFAULT_STARTUP_DELAY_MS, 3_000)
})
check('整个过程远早于一个 60 分钟的间隔', () => {
  assert.ok(Date.now() - startedAt < 60_000, `耗时 ${Date.now() - startedAt}ms`)
})

try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录，删不掉也无所谓 */ }
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条失败`)
process.exit(failed === 0 ? 0 : 1)
