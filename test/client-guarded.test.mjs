// 浏览器半的 provider 判定 —— 回归用例。
//
// 起因（2026-11-17，用户实测）：
//   「WB 更新后弹出水印，有关闭插件和知道了，但后台明明有 wb provider 的会话
//     在跑」——本该是「软结束 / 硬结束 / 知道了」。
//
// 根因在 client.js 的 `guarded`：
//
//   const pick = selection?.next ?? selection?.lastUsed
//   return pick !== undefined && GUARDED_PROVIDERS.includes(pick.provider)
//
// `modelSelection` 的投影是 `{ lastUsed, next: pending ?? lastUsed }`，**新会话
// 两个字段都存在但是 null**。于是 `null !== undefined` 成立，接着读
// `null.provider` 抛 TypeError，被 `read()` 的 catch 接住，把 running 和
// selected **一起**清成 false。
//
// 后果不是「少提示一条」，而是按钮组合整体判反。宿主侧 `usesWorkbuddy` 写的是
// `if (current && ...)`，两边不对称——这是漏改的一处。
//
// client.js 是浏览器 bundle（`window.__ModuleLoader__.load`），不能直接 import，
// 所以这里从源码里取出 `guarded` 的函数体再求值：测的就是**随包发布的那段代码**，
// 而不是测试里另抄一份。
//
// 跑：node test/client-guarded.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'client.js'), 'utf8')

/** 从 client.js 里抠出 `const guarded = (row) => { ... }` 的函数体。 */
function extractGuarded(text) {
  const start = text.indexOf('const guarded = (row) => {')
  assert.notEqual(start, -1, 'client.js 里找不到 `const guarded = (row) => {`，提取逻辑要跟着改')
  const open = text.indexOf('{', start)
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  throw new Error('guarded 的花括号不配对')
}

const body = extractGuarded(source)
const GUARDED_PROVIDERS = ['workbuddy', 'workbuddy-global']
/**
 * 把函数体装回一个闭包里求值。
 *
 * 不能写成 `new Function('row', 'GUARDED_PROVIDERS', body)` 再 `guarded(row)`
 * —— 那样 GUARDED_PROVIDERS 是**调用期**参数，不传就是 undefined。真实代码里
 * 它是模块级常量（client.js 顶部的数组），所以这里用工厂把它闭包进去。
 */
// eslint-disable-next-line no-new-func
const guarded = new Function('GUARDED_PROVIDERS', `return (row) => {${body}}`)(GUARDED_PROVIDERS)

const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ---- 投影的三种真实形态 ----

test('新建会话：next / lastUsed 都是 null → 不命中，且不能抛异常', () => {
  const row = { projectionValues: { modelSelection: { lastUsed: null, next: null } } }
  assert.doesNotThrow(() => guarded(row))
  assert.equal(guarded(row), false)
})

test('next 为 null、lastUsed 是 workbuddy → 回退命中', () => {
  const row = {
    projectionValues: {
      modelSelection: { lastUsed: { provider: 'workbuddy', model: 'hy4free' }, next: null },
    },
  }
  assert.equal(guarded(row), true)
})

test('next 是 workbuddy → 命中', () => {
  const row = { projectionValues: { modelSelection: { lastUsed: null, next: { provider: 'workbuddy', model: 'x' } } } }
  assert.equal(guarded(row), true)
})

test('next 是 workbuddy-global → 命中（两个 provider 都算）', () => {
  const row = { projectionValues: { modelSelection: { next: { provider: 'workbuddy-global', model: 'x' } } } }
  assert.equal(guarded(row), true)
})

test('next 是 deepseek → 不命中', () => {
  const row = { projectionValues: { modelSelection: { next: { provider: 'deepseek-account', model: 'x' } } } }
  assert.equal(guarded(row), false)
})

// ---- 残缺输入：不能因为读不到就炸掉，进而把 running/selected 一起清掉 ----

test('modelSelection 整个缺失 → 不命中，不抛', () => {
  assert.doesNotThrow(() => guarded({ projectionValues: {} }))
  assert.equal(guarded({ projectionValues: {} }), false)
})

test('projectionValues 缺失 → 不命中，不抛', () => {
  assert.equal(guarded({}), false)
})

test('row 是 null → 不命中，不抛', () => {
  assert.equal(guarded(null), false)
})

// ---- 这个用例的意义：任何一次抛异常都会让 read() 的 catch 把两个开关清成 false ----

test('对上面所有形态求值都不抛异常（抛一次就等于「后台有会话」被抹掉）', () => {
  const rows = [
    { projectionValues: { modelSelection: { lastUsed: null, next: null } } },
    { projectionValues: { modelSelection: {} } },
    { projectionValues: {} },
    {},
    null,
    { projectionValues: { modelSelection: { next: { provider: 'workbuddy', model: 'x' } } } },
  ]
  for (const row of rows) {
    assert.doesNotThrow(() => guarded(row), `guarded(${JSON.stringify(row)}) 抛了异常`)
  }
})

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
