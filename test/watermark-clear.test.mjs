// 「风险窗口关闭 → 清掉残留水印」与「目标版本已装上 → upgrade 自愈」—— 回归用例。
//
// 起因（2026-11-18，用户实测，Debian 13 trixie 那台）：
//
//   「wb 更新的警告标不会消失 … 水印挂了一个多小时，每轮检查都 mismatch:false，
//    但就是没人去清它。」
//
// 两条独立的死状态：
//
//   ① `scripts/watch.mjs` 里**根本没有**「条件解除 → 清水印」这条路径。
//      `updateWatermark()` 全文件只有 5 个调用点，`mismatch === false` 之后
//      没有任何分支碰 guard.json。设计意图写在旧注释里（「危险的红色水印不带
//      `untilRestart`，必须一直留到你 `--enable` 为止」）——可那台机器的
//      `dsh-connect-workbuddy` 是**宿主** `pluginManager.updateBundle` 升上去的，
//      `--enable` 从未发生，注释假设的出口压根不存在。
//
//   ② `issueUpgrade()` 重发前只看 attempts/status，不看磁盘现装版本。
//      guard 里钉着 `failed / attempts:2`，而磁盘上**就是**目标版本
//      （宿主装的）⇒ `installed === latest` ⇒ `pluginNewer === false`
//      ⇒ 谁也不会再来改这个 `failed`。界面永远显示「升级失败」。
//
// ⚠️ 本用例守住的**核心判据**（第一版写错的就是这里）：
//
//   清水印的条件**不能**写成 `!mismatch`。`mismatch` 是**边沿触发**的
//   （「WB 本轮变了没有」），报警那一轮结束时基线就推进到新版本，下一轮
//   `wbMismatch` 必然为 false —— 风险明明还开着（新 WB 配旧 connect），
//   边沿信号却说「没事了」。实测症状：红牌挂上后**第二圈**就被自己清掉。
//
//   正确语义 = 「这个具体的风险配对还成立吗」，拿**水印上记下的 connectVersion**
//   与**磁盘现装的**比：不等 ⇒ connect 动过 ⇒ 作者已适配 / 用户已升级 ⇒ 关。
//   相等 ⇒ 仍是「新 WB 配旧 connect」⇒ 留着。
//
// 跑：node test/watermark-clear.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(new URL('../scripts/watch.mjs', import.meta.url))
const INSTALLED = '5.24.14'
const WB_JUDGED = '5.11.3.43806934'
const JUDGE_SET = ['workbuddy-darwin-x64', 'workbuddy-darwin-arm64', 'workbuddy-win32-x64-user']

const cases = []
const test = (name, fn) => cases.push({ name, fn })

/**
 * 造一套沙盒：临时 DSH_HOME + 独立 state 目录 + 只装了目标包的假 profile。
 *
 * **profile 必须是「装了包」的样子**：脚本第一件事就是
 * `isGuardTargetInstalled()`，查不到包就整轮静默退出（`mode:'skipped'`），
 * 那么不管断言什么都会「通过」——假绿。这里显式建出 `node_modules`，
 * 并让 `package.json` 的版本成为脚本读到的「现装版本」。
 */
function sandbox({ guard, state, installed = INSTALLED, baseline = WB_JUDGED }) {
  const root = mkdtempSync(join(tmpdir(), 'wb-clear-'))
  const stateDir = join(root, 'state')
  const profileDir = join(root, 'profile')
  const pkgDir = join(profileDir, 'node_modules', 'dsh-connect-workbuddy')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(pkgDir, { recursive: true })

  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-connect-workbuddy', version: installed }))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'wb-test-profile',
    dsh: { profile: { bundles: ['dsh-connect-workbuddy'] } },
  }))

  writeFileSync(join(stateDir, 'guard.json'), JSON.stringify({
    schema: 1, revision: 78, watermark: null, ackedRevision: 0, ackSuppress: false, upgrade: null,
    ...guard,
  }))
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
    schema: 1,
    baseline: {
      version: baseline,
      connectVersion: INSTALLED,
      platformId: 'workbuddy-win32-x64-user',
      judgeSet: JUDGE_SET,
      source: 'interface+link',
      updatedAt: '2026-11-17T16:32:54Z',
    },
    checks: 6190,
    reportedKeys: [],
    ...state,
  }))
  return { root, stateDir, profileDir, pkgDir }
}

/**
 * 跑一轮 `watch.mjs`，返回解析后的 stdout 与迭代后的 guard.json。
 *
 * 默认用 `--simulate-version <基线值>`：判定版本 == 基线 ⇒ 不联网、
 * 不推进基线、`mismatch` 恒 false。这正好是「报警已经报过、现在处于稳态」
 * 的真实场景，也是清水印那条路唯一该生效的时刻。
 */
function runOnce(box, { simulate = WB_JUDGED, upstream = null } = {}) {
  const env = { ...process.env }
  delete env.DSH_PROFILE
  delete env.DSH_PROFILE_DIR
  env.DSH_HOME = box.root
  if (upstream === null) delete env.WORKBUDDY_WATCH_UPSTREAM
  else env.WORKBUDDY_WATCH_UPSTREAM = upstream

  const args = [SELF, '--state-dir', box.stateDir, '--profile-dir', box.profileDir, '--no-notify', '--no-upgrade']
  if (simulate !== null) args.push('--simulate-version', simulate)

  const run = spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 60_000 })
  const raw = (run.stdout ?? '').trim()
  let result = null
  try { result = JSON.parse(raw.split('\n').pop()) } catch { /* 留在 result=null */ }
  const guard = JSON.parse(readFileSync(join(box.stateDir, 'guard.json'), 'utf8'))
  return { result, guard, status: run.status, stderr: run.stderr ?? '' }
}

const dangerWatermark = (patch = {}) => ({
  level: 'danger',
  title: 'WB 更新了',
  body: '还用，你的账号是批发的吗？',
  detail: '5.9.3.42398134 → 5.11.3.43806934',
  from: '5.9.3.42398134',
  to: '5.11.3.43806934',
  connectVersion: '5.23.0',
  pendingDisable: false,
  actions: ['close', 'ack'],
  handledBy: 'close',
  at: '2026-11-17T14:39:29.199Z',
  ...patch,
})

// ---------------------------------------------------------------------------
// ① 配对被打断（水印记 5.23.0，磁盘 5.24.14）→ 清掉
// ---------------------------------------------------------------------------

test('connect 动过（水印记 5.23.0 ≠ 现装 5.24.14）→ 清掉水印，revision +1', () => {
  const box = sandbox({ guard: { watermark: dangerWatermark({ connectVersion: '5.23.0' }) } })
  try {
    const { guard, result } = runOnce(box)
    assert.equal(result?.mode, 'watch', `脚本没跑起来：${JSON.stringify(result)}`)
    assert.equal(guard.watermark, null, '配对已经打断，水印必须清掉')
    assert.equal(guard.revision, 79, '清水印要走 updateWatermark(null)，它负责 revision +1')
  } finally { rmSync(box.root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ② 配对仍然成立（水印记 5.24.14 == 现装 5.24.14）→ 必须留着
//
// 这条就是第一版实现写错的场景：`!mismatch` 在报警轮之后恒为 true，
// 于是红牌第二圈就没了。
// ---------------------------------------------------------------------------

test('connect 没动（水印记 == 现装）→ 连跑三轮都不许清', () => {
  const box = sandbox({ guard: { watermark: dangerWatermark({ connectVersion: INSTALLED }) } })
  try {
    for (let round = 1; round <= 3; round += 1) {
      const { guard } = runOnce(box)
      assert.ok(guard.watermark !== null,
        `第 ${round} 轮就把还在生效的红牌清掉了 —— 判据写成了 !mismatch 而不是「配对是否被打断」`)
      assert.equal(guard.watermark.title, 'WB 更新了')
      assert.equal(guard.revision, 78, `第 ${round} 轮 revision 被无谓抬升`)
    }
  } finally { rmSync(box.root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ③ 读不到判定版本 → 绝不能清（哪怕配对看起来已经打断）
// ---------------------------------------------------------------------------

test('所有平台都读不到版本 → 水印保留（judgedVersion === null 不是「解除」）', () => {
  const box = sandbox({ guard: { watermark: dangerWatermark({ connectVersion: '5.23.0' }) } })
  try {
    // 指向一个必然连不上的地址：读不到 ⇒ judgedVersion === null
    const { guard, result } = runOnce(box, { simulate: null, upstream: 'http://127.0.0.1:1/nope' })
    assert.equal(result?.judgedVersion, null, '前置条件：这一轮必须读不到版本')
    assert.ok(guard.watermark !== null, '读不到版本正是最该保留告警的场景')
    assert.equal(guard.revision, 78)
  } finally { rmSync(box.root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ④ 升级通知不归这条管
// ---------------------------------------------------------------------------

test('升级通知（dismissible / untilRestart）不会被清水印这条顺手抹掉', () => {
  const box = sandbox({
    guard: {
      watermark: {
        level: 'warning', title: '插件已升级', body: '重启 DSH 生效。',
        detail: 'dsh-connect-workbuddy 5.24.13 → 5.24.14',
        untilRestart: true, dismissible: true, actions: ['ack'],
        at: '2026-11-17T16:00:00.000Z',
      },
    },
  })
  try {
    const { guard } = runOnce(box, { simulate: null, upstream: 'http://127.0.0.1:1/nope' })
    assert.ok(guard.watermark !== null, '升级通知有自己的生命周期，不该被清')
    assert.equal(guard.watermark.title, '插件已升级')
  } finally { rmSync(box.root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ⑤ 老水印没有 connectVersion → 保守留下
// ---------------------------------------------------------------------------

test('老水印缺 connectVersion 字段 → 留下（证明不了配对被打断就不清）', () => {
  const stale = dangerWatermark({ connectVersion: '5.23.0' })
  delete stale.connectVersion
  const box = sandbox({ guard: { watermark: stale } })
  try {
    const { guard } = runOnce(box)
    assert.ok(guard.watermark !== null, '缺字段时无法证明风险解除，误清真红牌的代价更大')
    assert.equal(guard.revision, 78)
  } finally { rmSync(box.root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ⑥ 本轮刚判定出风险 → 清水印不能抢先，水印要由第 4 节重建成带新配对的
// ---------------------------------------------------------------------------

test('本轮刚刚 mismatch → 清水印不抢先；写出的红牌必须自带 connectVersion', () => {
  const box = sandbox({
    guard: { watermark: dangerWatermark({ connectVersion: '5.23.0' }) },
    baseline: '1.0.0',
  })
  try {
    const { guard, result } = runOnce(box, { simulate: WB_JUDGED })
    assert.equal(result?.mismatch, true, '前置条件：本轮必须判定出不一致')
    assert.ok(guard.watermark !== null, '刚判定出的风险不该在本轮被清')
    assert.equal(guard.watermark.pendingDisable, true)
    assert.equal(guard.watermark.connectVersion, INSTALLED,
      '新红牌必须记下当前的 connect 版本，否则下一轮永远无法判定「配对是否被打断」')
    // 只该由第 4 节抬**一次** revision。清水印那条若抢先跑一遍，
    // 会先把 78 抬到 79、清成 null，再被重建抬到 80 —— 白抬一次，
    // 客户端还会因为 revision 变化把「已 snooze」状态复位一次。
    assert.equal(guard.revision, 79, '清水印那条在本轮抢先跑了（revision 被抬了两次）')
  } finally { rmSync(box.root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// ⑦ upgrade 死状态自愈
// ---------------------------------------------------------------------------

test('upgrade 钉在 failed/attempts:2 而磁盘上就是目标版本 → 自愈为 done，且不抬 revision', () => {
  const { root, stateDir, profileDir, pkgDir } = sandbox({
    guard: {
      revision: 78,
      upgrade: {
        revision: 78, from: '5.24.13', to: INSTALLED, spec: `dsh-connect-workbuddy@${INSTALLED}`,
        status: 'failed', attempts: 2, method: 'dsh-cli',
        previousError: '退出码 1: error: profile "desktop" is managed exclusively by the Electron application',
      },
    },
  })
  void stateDir; void profileDir; void pkgDir
  try {
    const { guard } = runOnce({ root, stateDir, profileDir, pkgDir }, { simulate: null, upstream: 'http://127.0.0.1:1/nope' })
    assert.equal(guard.upgrade.status, 'done', '目标版本已经在磁盘上了，状态不该永远停在 failed')
    assert.equal(guard.upgrade.method, 'dsh-cli', '原有的执行方式要保留')
    assert.equal(guard.upgrade.attempts, 2, '历史尝试次数是记录，不该被抹掉')
    assert.equal(guard.revision, 78, '记账修复不该抬 revision（水印生命周期不归它驱动）')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('upgrade 目标版本还没装上 → 保持原状，不许假装成功', () => {
  const box = sandbox({
    installed: '5.24.13',
    guard: {
      upgrade: {
        revision: 78, from: '5.24.13', to: INSTALLED, spec: `dsh-connect-workbuddy@${INSTALLED}`,
        status: 'failed', attempts: 2, method: 'dsh-cli',
      },
    },
  })
  try {
    const { guard } = runOnce(box, { simulate: null, upstream: 'http://127.0.0.1:1/nope' })
    assert.equal(guard.upgrade.status, 'failed', '磁盘上还是旧版，不能自愈')
    assert.equal(guard.revision, 78)
  } finally { rmSync(box.root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------

let failed = 0
for (const { name, fn } of cases) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n      ${String(error?.message ?? error).split('\n')[0]}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
