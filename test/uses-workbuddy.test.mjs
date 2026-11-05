// usesWorkbuddy 的回归用例。
//
// 起因：2026-11-05 一条一直在用 deepseek-flash 的会话（只是在对话里聊到
// WorkBuddy）被判定成「正在用 workbuddy」并收到了软结束指令。根因是当时把
// `agent.options.provider`（会话创建时的配置，不会随切换更新）当成了独立证据。
//
// 跑：node test/uses-workbuddy.test.mjs
import assert from 'node:assert/strict'
import { usesWorkbuddy } from '../index.js'

/** 造一个够用的 agent 假体：只看 ownEvents 与 options。 */
function fakeAgent({ options = {}, lastAssistant = null } = {}) {
  const events = lastAssistant === null
    ? []
    : [{ type: 'assistant/message', data: { message: { source: { provider: lastAssistant, model: 'x' } } } }]
  return {
    id: 's1',
    options,
    session: { ownEvents: () => events },
  }
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ---- 投影可用时，投影说了算 ----
test('投影 next 是 workbuddy → 命中', () => {
  const got = usesWorkbuddy(fakeAgent(), { modelSelection: { next: { provider: 'workbuddy', model: 'hy4free' } } })
  assert.equal(got, 'workbuddy/hy4free')
})

test('投影 next 是 workbuddy-global → 命中', () => {
  const got = usesWorkbuddy(fakeAgent(), { modelSelection: { next: { provider: 'workbuddy-global', model: 'm' } } })
  assert.equal(got, 'workbuddy-global/m')
})

test('投影 next 缺席时回退 lastUsed', () => {
  const got = usesWorkbuddy(fakeAgent(), { modelSelection: { lastUsed: { provider: 'workbuddy', model: 'm' } } })
  assert.equal(got, 'workbuddy/m')
})

test('投影 next 是别的 provider，lastUsed 才是 workbuddy → 不命中（当前选择优先）', () => {
  const got = usesWorkbuddy(fakeAgent(), {
    modelSelection: {
      next: { provider: 'deepseek-account', model: 'deepseek-flash' },
      lastUsed: { provider: 'workbuddy', model: 'hy4free' },
    },
  })
  assert.equal(got, null)
})

// ---- 回归：options 不能单独定罪 ----
test('options.provider=workbuddy 但投影是 deepseek → 不命中（本次踩的坑）', () => {
  const agent = fakeAgent({ options: { provider: 'workbuddy', model: 'hy4free' }, lastAssistant: 'deepseek-account' })
  const got = usesWorkbuddy(agent, { modelSelection: { next: { provider: 'deepseek-account', model: 'deepseek-flash' } } })
  assert.equal(got, null)
})

test('options.provider=workbuddy、投影是空对象 → 不命中', () => {
  const agent = fakeAgent({ options: { provider: 'workbuddy', model: 'hy4free' }, lastAssistant: 'deepseek-account' })
  assert.equal(usesWorkbuddy(agent, { modelSelection: {} }), null)
})

// ---- 降级路径：投影不可用时要求双证据 ----
test('投影不可用 + 配置与最后一条 assistant 都是 workbuddy → 命中', () => {
  const agent = fakeAgent({ options: { provider: 'workbuddy', model: 'hy4free' }, lastAssistant: 'workbuddy' })
  assert.equal(usesWorkbuddy(agent, undefined), 'workbuddy/hy4free')
})

test('投影不可用 + 配置是 workbuddy 但最后一条是 deepseek → 不命中', () => {
  const agent = fakeAgent({ options: { provider: 'workbuddy', model: 'hy4free' }, lastAssistant: 'deepseek-account' })
  assert.equal(usesWorkbuddy(agent, undefined), null)
})

test('投影不可用 + 配置是 workbuddy 但没有任何 assistant 消息 → 不命中', () => {
  const agent = fakeAgent({ options: { provider: 'workbuddy', model: 'hy4free' }, lastAssistant: null })
  assert.equal(usesWorkbuddy(agent, undefined), null)
})

test('投影不可用 + 配置是 deepseek → 不命中', () => {
  const agent = fakeAgent({ options: { provider: 'deepseek-account' }, lastAssistant: 'deepseek-account' })
  assert.equal(usesWorkbuddy(agent, undefined), null)
})

// ---- 读日志炸了也不能崩 ----
test('session.ownEvents 抛错 → 当成没有 assistant 消息', () => {
  const agent = {
    options: { provider: 'workbuddy', model: 'm' },
    session: { ownEvents: () => { throw new Error('boom') } },
  }
  assert.equal(usesWorkbuddy(agent, undefined), null)
})

let failed = 0
for (const { name, fn } of cases) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    ${error.message.split('\n')[0]}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
