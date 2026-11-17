// profile 解析 —— 回归用例。
//
// 起因（2026-11-17，用户实测）：
//
//   「npm 版的 dsh，wb 更新的警告标不会消失 … profileName 兜底值是在判断不出本机
//    是运行在什么环境下才兜底的，插件应该可以读取到究竟跑在什么环境吧。直接不配置，
//    走 resolveProfile() 反而可以认出是 web。」
//
// 根因：`profileName()` 的兜底是**硬编码 `'desktop'`**。
//
//   function profileName(config) {
//     const fromConfig = config?.profile?.trim()
//     if (fromConfig) return fromConfig
//     const fromEnv = process.env.DSH_PROFILE?.trim()
//     if (fromEnv) return fromEnv
//     return 'desktop'          // ← npm 版（profile 名是 web）必然猜错
//   }
//
// 而 DSH 本来就把答案provide 到 context 上了：`hostCtx.provide('profileContext', …)`
// （dsh/src/profile-boot.ts:338），字段 `{ name, dir, … }`。`dsh-shell-env` 就是从
// 它读出 `DSH_PROFILE` / `DSH_PROFILE_DIR` 的（dsh-shell-env/src/index.ts:176-181）。
//
// 后果不是「界面不好看」：`dsh plugin --profile desktop add …` 会把包
// 装进用户**根本没在跑**的那份 profile，或者直接报「先打开 Desktop 一次」。
//
// 本用例把优先级钉住，并特别守住两件事：
//   1. 读不到就是 null，**不许猜**；
//   2. `dir` 只从 profileContext / DSH_PROFILE_DIR 取，**不许拿名字去拼**——
//      用了 `DSH_HOME` 做隔离却没清 `DSH_PROFILE` 的环境（测试就是这样）会被
//      带偏到真实 profile。
//
// 跑：node test/profile-resolution.test.mjs
import assert from 'node:assert/strict'

import { resolveProfileInfo, profileName } from '../index.js'

const cases = []
const test = (name, fn) => cases.push({ name, fn })

/** 造一个只有 `get()` 的 ctx；`profileContext` 传 undefined 就是「服务没装」。 */
const ctxWith = (profileContext) => ({ get: (name) => (name === 'profileContext' ? profileContext : undefined) })
const noCtx = { get: () => undefined }

/** 保存/恢复那两个环境变量，免得一个用例影响下一个。 */
function withEnv(patch, run) {
  const before = { DSH_PROFILE: process.env.DSH_PROFILE, DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR']) {
    if (patch[key] === undefined) delete process.env[key]
    else process.env[key] = patch[key]
  }
  try { return run() } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// ---------------------------------------------------------------------------
// ① profileContext 说了算
// ---------------------------------------------------------------------------

test('profileContext.name / .dir 优先于一切', () => {
  withEnv({ DSH_PROFILE: 'something-else', DSH_PROFILE_DIR: '/nope' }, () => {
    const info = resolveProfileInfo(
      ctxWith({ name: 'web', dir: '/home/u/.dsh/profiles/web' }),
      { profile: 'also-ignored' },
    )
    assert.deepEqual(info, { name: 'web', dir: '/home/u/.dsh/profiles/web', source: 'profileContext' })
  })
})

test('profileContext 只给 name 不给 dir → dir 是 null，不拿名字去拼', () => {
  const info = resolveProfileInfo(ctxWith({ name: 'web' }), {})
  assert.equal(info.name, 'web')
  assert.equal(info.dir, null)
  assert.equal(info.source, 'profileContext')
})

test('profileContext 是空对象 → 当作没有，继续往下退', () => {
  withEnv({ DSH_PROFILE: undefined, DSH_PROFILE_DIR: undefined }, () => {
    assert.equal(resolveProfileInfo(ctxWith({}), {}), null)
  })
})

test('ctx.get 抛异常 → 不炸，继续往下退', () => {
  const ctx = { get() { throw new Error('service-disposal') } }
  withEnv({ DSH_PROFILE: 'web', DSH_PROFILE_DIR: undefined }, () => {
    assert.equal(resolveProfileInfo(ctx, {})?.name, 'web')
  })
})

// ---------------------------------------------------------------------------
// ② 读不到就返回 null —— 这是本次修复的核心
// ---------------------------------------------------------------------------

test('什么都有没 → null（不猜 desktop）', () => {
  withEnv({ DSH_PROFILE: undefined, DSH_PROFILE_DIR: undefined }, () => {
    assert.equal(resolveProfileInfo(noCtx, {}), null)
    assert.equal(profileName(noCtx, {}), null)
  })
})

test('profileName 绝不返回硬编码的 default', () => {
  withEnv({ DSH_PROFILE: undefined, DSH_PROFILE_DIR: undefined }, () => {
    const got = profileName(noCtx, {})
    assert.equal(got, null)
    assert.notEqual(got, 'desktop', '这就是 npm 版装错 profile 的成因')
  })
})

// ---------------------------------------------------------------------------
// ③ config.profile 与 DSH_PROFILE 的先后
// ---------------------------------------------------------------------------

test('config.profile 优先于 DSH_PROFILE', () => {
  withEnv({ DSH_PROFILE: 'from-env', DSH_PROFILE_DIR: undefined }, () => {
    assert.equal(resolveProfileInfo(noCtx, { profile: 'from-config' })?.name, 'from-config')
  })
})

test('DSH_PROFILE 兜底（手工在终端跑脚本的场景）', () => {
  withEnv({ DSH_PROFILE: 'web', DSH_PROFILE_DIR: undefined }, () => {
    const info = resolveProfileInfo(noCtx, {})
    assert.equal(info.name, 'web')
    assert.equal(info.source, 'env')
  })
})

test('空白 / 非字符串的 config.profile 视为没配', () => {
  withEnv({ DSH_PROFILE: 'web', DSH_PROFILE_DIR: undefined }, () => {
    for (const bad of ['   ', 42, null, undefined, {}, []]) {
      assert.equal(resolveProfileInfo(noCtx, { profile: bad })?.name, 'web', `profile=${JSON.stringify(bad)}`)
    }
  })
})

// ---------------------------------------------------------------------------
// ④ 名字与目录必须成对 —— 不许拿名字拼目录
// ---------------------------------------------------------------------------

test('只有 DSH_PROFILE、没有 DSH_PROFILE_DIR → dir 是 null（不拼 <home>/profiles/<name>）', () => {
  withEnv({ DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: undefined }, () => {
    const info = resolveProfileInfo(noCtx, {})
    assert.equal(info.name, 'desktop')
    assert.equal(info.dir, null,
      '拼出来的目录在 DSH_HOME 被重定向的环境里指向另一个真实 profile')
  })
})

test('DSH_PROFILE_DIR 与名字一起给 → 原样带上', () => {
  withEnv({ DSH_PROFILE: 'web', DSH_PROFILE_DIR: '/tmp/isolated/profiles/web' }, () => {
    const info = resolveProfileInfo(noCtx, {})
    assert.equal(info.name, 'web')
    assert.equal(info.dir, '/tmp/isolated/profiles/web')
  })
})

// ---------------------------------------------------------------------------

let failed = 0
for (const { name, fn } of cases) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n      ${error?.message ?? error}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
