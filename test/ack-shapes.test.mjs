// 「知道了」的两种语义 —— 回归用例。
//
// 起因（2026-11-09）：`ae36602` 把 ack 真正落到 Host 之后，需求 3 的强提醒
// 名存实亡。客户端 `onDismiss` 按 `permanent` 判据打算 1.8 秒后把危险告警
// 重新浮出来（`RESHOW_MS`），可 Host 已经因为 ackedRevision 相等而不再下发
// 同一条水印，于是卡片「闪一下就被撤掉」——既不像消失，也不像提醒。
//
// 需求把「知道了」写成两种语义：
//   · 升级通知（`dismissible` / `untilRestart`）——需求 2「点击之后直接消失」
//   · 危险告警与其收尾水印——需求 3「点了之后消失，再重现」的强提醒
//
// 本用例用假 ctx 驱动 `apply()`，四种形态各跑一遍，断言 Host 是否继续下发。
// 不派生 watch.mjs（`selfSchedule: false`），不联网，guard.json 手写。
//
// 跑：node test/ack-shapes.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const SHAPES = [
  {
    name: '危险告警（pendingDisable）→ 继续下发，强提醒',
    expectSuppressed: false,
    watermark: {
      level: 'danger',
      title: 'WB 更新了',
      body: '还用，你的账号是批发的吗？',
      detail: '5.9.3 → 6.0.0',
      from: '5.9.3',
      to: '6.0.0',
      pendingDisable: true,
      actions: ['soft', 'hard', 'ack'],
    },
  },
  {
    name: '重启生效升级通知（untilRestart）→ 压住，需求 2',
    expectSuppressed: true,
    watermark: {
      level: 'warning',
      title: '插件已升级',
      body: '重启 DSH 生效。',
      detail: 'dsh-connect-workbuddy 5.20.0 → 5.21.2',
      pendingDisable: false,
      actions: ['ack'],
      untilRestart: true,
    },
  },
  {
    name: '热生效升级通知（dismissible）→ 压住，需求 2',
    expectSuppressed: true,
    watermark: {
      level: 'info',
      title: '插件已升级',
      body: '已热生效，无需重启。',
      detail: 'dsh-connect-workbuddy 5.20.0 → 5.21.2',
      pendingDisable: false,
      actions: ['ack'],
      dismissible: true,
    },
  },
  {
    name: '收尾水印（点过硬结束）→ 继续下发，需求 3「强开后随 provider 显示」',
    expectSuppressed: false,
    watermark: {
      level: 'danger',
      title: 'WB 更新了',
      body: '还用，你的账号是批发的吗？',
      detail: '5.9.3 → 6.0.0',
      from: '5.9.3',
      to: '6.0.0',
      pendingDisable: false,
      actions: ['close', 'ack'],
      handledBy: 'hard',
      dismissedAfterAction: 'hard',
    },
  },
]

const cases = []
const test = (name, fn) => cases.push({ name, fn })

/**
 * 每种形态独立一个 DSH_HOME + 一次全新 `apply()`。
 *
 * `apply()` 的状态（`publishedWatermarkRevision` 等）在闭包里，跨形态复用会
 * 让后一个形态看到前一个的 revision，测出来的东西就不是本形态的行为了。
 */
function runShape(shape, index) {
  const home = mkdtempSync(join(tmpdir(), `wb-ack-${index}-`))
  const stateDir = join(home, 'workbuddy-update-watch')
  mkdirSync(stateDir, { recursive: true })
  const guardPath = join(stateDir, 'guard.json')
  const revision = 20 + index
  writeFileSync(guardPath, `${JSON.stringify({
    schema: 1,
    revision,
    watermark: { ...shape.watermark, at: new Date().toISOString() },
    stopSessions: null,
    upgrade: null,
  }, null, 2)}\n`, { mode: 0o600 })

  const routes = new Map()
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
        }
      }
      if (name === 'sessionProjections') return { snapshot: () => ({ values: {} }) }
      return undefined
    },
    webServer: { register: (spec) => { routes.set(spec.path, spec.handler); return () => {} } },
    // 空数组：没有后台会话。危险告警的按钮组合本就不影响本用例的判据
    agents: { list: () => [] },
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

  /**
   * 路由的 handler 是 `(req, res) => { void handleAction(req, res) }`——
   * 外层故意不返回 promise（真实 webServer 也不需要）。所以这里不能 `await`
   * 它，只能等 `res.end` 被调用。早期版本直接 await，拿到的永远是空 body。
   */
  const settle = async (out) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && out.body === '') await sleep(10)
    return { status: out.status, payload: JSON.parse(out.body || '{}') }
  }

  const postAck = async (revision_, suppress) => {
    const out = { status: null, body: '' }
    const res = {
      writeHead(status) { out.status = status },
      end(chunk) { out.body = chunk ?? '' },
    }
    const body = { action: 'ack', revision: revision_ }
    if (suppress !== undefined) body.suppress = suppress
    const req = {
      method: 'POST',
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    }
    routes.get('/plugins/dsh-workbuddy-account-care/action')(req, res)
    return settle(out)
  }

  return { home, guardPath, ctx, readState, postAck, revision }
}

/**
 * 跑一个形态：发布 → ack → 观察 Host 还发不发。
 *
 * @param {object} options
 * @param {object} options.shape            形态（含 watermark 与默认期望）
 * @param {number} options.index            DSH_HOME 与 revision 的区分序号
 * @param {boolean|undefined} options.suppress  ack 时显式带上的结论；undefined = 不带
 * @param {boolean} options.expectSuppressed   这一轮期望被压住吗
 * @param {string} options.label           断言失败时的场景说明
 */
async function verify({ shape, index, suppress, expectSuppressed, label }) {
  const env = runShape(shape, index)
  process.env.DSH_HOME = env.home
  try {
    apply(env.ctx, { selfSchedule: false, pollMs: 200, notify: false, startupDelayMs: 0 })
    await sleep(900)

    const before = env.readState()
    assert.ok(before.watermark !== null && before.watermark !== undefined,
      `${label}：前置，水印应当已经发布，实际 ${JSON.stringify(before.watermark)}`)
    assert.equal(before.revision, env.revision)

    const ack = await env.postAck(before.revision, suppress)
    assert.equal(ack.payload.ok, true, `${label}：ack 应当成功，实际 ${JSON.stringify(ack.payload)}`)

    await sleep(150)
    const justAfter = env.readState()
    await sleep(1400)
    const later = env.readState()

    // 落盘永远要写：即使不压住，也要记住「用户已经看过这一次」，
    // 只是这个记忆不阻止 Host 继续下发
    const disk = JSON.parse(readFileSync(env.guardPath, 'utf8'))
    assert.equal(disk.ackedRevision, env.revision, `${label}：ackedRevision 应当落盘`)
    if (suppress !== undefined) {
      assert.equal(disk.ackSuppress, suppress,
        `${label}：客户端给的结论应当原样落盘，方便 --status 排查`)
    }

    if (expectSuppressed) {
      assert.equal(justAfter.watermark, null, `${label}：ack 后 Host 应当立刻停止下发`)
      assert.equal(later.watermark, null, `${label}：后续轮次也不该再下发`)
    } else {
      assert.notEqual(justAfter.watermark, null, `${label}：ack 后 Host 应当继续下发（客户端 reshow 才有数据）`)
      assert.notEqual(later.watermark, null, `${label}：后续轮次应当继续下发`)
    }
  } finally {
    rmSync(env.home, { recursive: true, force: true })
  }
}

for (const [index, shape] of SHAPES.entries()) {
  test(shape.name, () => verify({
    shape,
    index,
    suppress: undefined,
    expectSuppressed: shape.expectSuppressed,
    label: shape.name,
  }))
}

/**
 * 第二组：客户端**显式**带 `suppress` 时，Host 必须照办，不能自己再猜一遍。
 *
 * 为什么需要这一组：`isPending && !hasBackground`（待确认、但没有后台 wb 会话）
 * 这种情况需求要求「点了之后消失」，可是宿主分辨不出来——它拿不到
 * `retainedBy.mainView`，只会把自己的会话也算成后台，于是永远 busy。
 * 判断权交给客户端，Host 收到 `suppress` 就照做；否则两边各判一次，
 * 结果一旦不一致，就会出现「卡片闪一下又回来」或者「该强提醒的再也不出现」。
 */
const DANGER = SHAPES.find((s) => s.watermark.pendingDisable === true)
const HOT = SHAPES.find((s) => s.watermark.dismissible === true)

const OVERRIDES = [
  {
    name: '危险告警 + suppress:true → 压住（客户端说没有后台会话）',
    shape: DANGER,
    suppress: true,
    expectSuppressed: true,
  },
  {
    name: '热生效升级通知 + suppress:false → 继续下发（客户端说还要提醒）',
    shape: HOT,
    suppress: false,
    expectSuppressed: false,
  },
]

for (const [index, override] of OVERRIDES.entries()) {
  test(override.name, () => verify({
    shape: override.shape,
    index: 10 + index,
    suppress: override.suppress,
    expectSuppressed: override.expectSuppressed,
    label: override.name,
  }))
}

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
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
