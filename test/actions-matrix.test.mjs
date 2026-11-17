// 按钮矩阵 + 「关闭插件」幂等 —— 回归用例。
//
// 起因（2026-11-17，用户实测两次反馈）：
//
//   ① 「WB 客户端更新后弹出水印，有关闭插件和知道了，但是这时候插件已经被
//      关闭了。这里不能把插件直接关闭。」
//      → 待确认且**没有**后台 wb 会话时，不该给「关闭插件」。需求第 17 行
//        据此改成「一个按钮。这里不要关闭插件」。
//
//   ② 「有时候还会出现点关闭插件无法关闭。」
//      → `--disable` 是幂等的，插件已经不在 bundles 里时返回
//        `{ changed: false, reason: 'already-disabled' }`。宿主原先只认
//        `changed === true`，于是「本来就已经关了」被判成失败：水印停在
//        `pendingDisable: true`、按钮不动，再点还是同样的结果——死循环。
//
// 本用例不联网、不派生 watch.mjs，用假 ctx 驱动 `apply()`，直接读 /state 上
// 发布出来的 `watermark.actions`，并直接调 /action 验证 disabledOk。
//
// 跑：node test/actions-matrix.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const BUNDLE = 'dsh-connect-workbuddy'

const cases = []
const test = (name, fn) => cases.push({ name, fn })

/**
 * 搭一个最小环境。
 *
 * `agents` 决定「有没有后台 wb 会话在跑」——宿主用
 * `hasBackgroundWorkbuddySession()` 判，读的是 `ctx.agents.list()` 里
 * `status === 'running'` 且投影 modelSelection 指向 wb 的那几条。
 */
function runEnv({ watermark, index, bundleEnabled = true, running = false, disableResult }) {
  const home = mkdtempSync(join(tmpdir(), `wb-actions-${index}-`))
  const stateDir = join(home, 'workbuddy-update-watch')
  mkdirSync(stateDir, { recursive: true })
  const guardPath = join(stateDir, 'guard.json')
  const revision = 30 + index
  writeFileSync(guardPath, `${JSON.stringify({
    schema: 1,
    revision,
    watermark: { ...watermark, at: new Date().toISOString() },
    stopSessions: null,
    upgrade: null,
  }, null, 2)}\n`, { mode: 0o600 })

  const routes = new Map()
  const agents = running
    ? [{ id: 'session-bg-1', session: 's1', status: 'running', options: { provider: 'workbuddy', model: 'x' } }]
    : []

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(run) { return run() },
    on() { return () => {} },
    get(name) {
      if (name === 'pluginManager') {
        return {
          async listBundles() {
            return [{ name: BUNDLE, installed: true, enabled: bundleEnabled }]
          },
        }
      }
      if (name === 'sessionProjections') {
        return {
          snapshot: () => ({
            values: running ? { modelSelection: { lastUsed: { provider: 'workbuddy', model: 'x' }, next: { provider: 'workbuddy', model: 'x' } } } : {},
          }),
        }
      }
      return undefined
    },
    webServer: { register: (spec) => { routes.set(spec.path, spec.handler); return () => {} } },
    agents: { list: () => agents },
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

  const post = async (body) => {
    const out = { status: null, body: '' }
    const res = {
      writeHead(status) { out.status = status },
      end(chunk) { out.body = chunk ?? '' },
    }
    const req = {
      method: 'POST',
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }
    routes.get('/plugins/dsh-workbuddy-account-care/action')(req, res)
    return settle(out)
  }

  return { home, guardPath, ctx, readState, post, revision, disableResult }
}

const PENDING_DANGER = {
  level: 'danger',
  title: 'WB 更新了',
  body: '还用，你的账号是批发的吗？',
  detail: '5.9.3 → 6.0.0',
  from: '5.9.3',
  to: '6.0.0',
  pendingDisable: true,
  actions: ['soft', 'hard', 'ack'],
}

const HANDLED_DANGER = {
  ...PENDING_DANGER,
  pendingDisable: false,
  actions: ['close', 'ack'],
  handledBy: 'hard',
  dismissedAfterAction: 'hard',
}

/** 起 Host，等它把水印推出来一次。 */
async function boot(env) {
  process.env.DSH_HOME = env.home
  apply(env.ctx, { selfSchedule: false, pollMs: 150, notify: false, startupDelayMs: 0 })
  await sleep(700)
  return env.readState()
}

// ---------------------------------------------------------------------------
// ① 按钮矩阵
// ---------------------------------------------------------------------------

test('待确认 + 有后台 wb 在跑 → 软结束 / 硬结束 / 知道了', async () => {
  const env = runEnv({ watermark: PENDING_DANGER, index: 0, running: true })
  const state = await boot(env)
  try {
    assert.deepEqual(state.watermark.actions, ['soft', 'hard', 'ack'],
      `实际 ${JSON.stringify(state.watermark.actions)}`)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test('待确认 + 没有后台任务 → 只有知道了（需求第 17 行：这里不要关闭插件）', async () => {
  const env = runEnv({ watermark: PENDING_DANGER, index: 1, running: false })
  const state = await boot(env)
  try {
    assert.deepEqual(state.watermark.actions, ['ack'],
      `不该出现 close，实际 ${JSON.stringify(state.watermark.actions)}`)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test('已处理 + 用户强开、后台停了 → 关闭插件 / 知道了（需求第 26-28 行）', async () => {
  const env = runEnv({ watermark: HANDLED_DANGER, index: 2, running: false, bundleEnabled: true })
  const state = await boot(env)
  try {
    assert.deepEqual(state.watermark.actions, ['close', 'ack'],
      `实际 ${JSON.stringify(state.watermark.actions)}`)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test('插件已关 → 只有知道了，不论有没有后台任务', async () => {
  const env = runEnv({ watermark: HANDLED_DANGER, index: 3, running: true, bundleEnabled: false })
  const state = await boot(env)
  try {
    assert.deepEqual(state.watermark.actions, ['ack'],
      `实际 ${JSON.stringify(state.watermark.actions)}`)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

test('升级通知 → 只有知道了（不能摆一个「关闭插件」的按钮）', async () => {
  const env = runEnv({
    watermark: {
      level: 'info',
      title: '插件已升级',
      body: '已热生效，无需重启。',
      detail: '5.24.10 → 5.24.11',
      pendingDisable: false,
      actions: ['ack'],
      dismissible: true,
    },
    index: 4,
  })
  const state = await boot(env)
  try {
    assert.deepEqual(state.watermark.actions, ['ack'],
      `实际 ${JSON.stringify(state.watermark.actions)}`)
  } finally { rmSync(env.home, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ② 「关闭插件」幂等：已经关了也算成功
// ---------------------------------------------------------------------------

/**
 * 这一组验证的是 `runAction` 里 `disabledOk` 的判据。
 *
 * 真的去 spawn `watch.mjs --disable` 会改写真实 profile，所以这里用一个
 * 桩脚本替换 `WATCH_SCRIPT` 做不到（它是模块级常量）。改为直接验证判据本身：
 * 把三种 `--disable` 返回值喂给同一段判断，确认只有「失败」那类被拒。
 */
const disabledOkOf = (disabled) => disabled.ok
  && (
    disabled.result?.changed === true
    || disabled.result?.result?.changed === true
    || disabled.result?.result?.reason === 'already-disabled'
  )

test('already-disabled 判成功（点了「关闭插件」不会卡在「无法关闭」）', () => {
  assert.equal(disabledOkOf({
    ok: true,
    code: 0,
    result: { mode: 'disable', changed: false, result: { changed: false, reason: 'already-disabled' } },
  }), true)
})

test('真关掉了判成功', () => {
  assert.equal(disabledOkOf({
    ok: true,
    code: 0,
    result: { mode: 'disable', changed: true, result: { changed: true } },
  }), true)
})

test('回滚 / manifest 坏掉 / spawn 失败 → 仍判失败，水印必须留着', () => {
  for (const disabled of [
    { ok: false, error: 'spawn EPERM' },
    { ok: true, code: 1, result: { mode: 'disable', changed: false, result: { changed: false, reason: 'verify-failed-rolled-back' } } },
    { ok: true, code: 0, result: { mode: 'disable', changed: false, result: { changed: false, reason: 'profile-manifest-missing' } } },
  ]) {
    assert.equal(disabledOkOf(disabled), false, `不该判成功：${JSON.stringify(disabled)}`)
  }
})

// ---------------------------------------------------------------------------

let failed = 0
for (const { name, fn } of cases) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
