/**
 * WorkBuddy 版本守卫 —— 浏览器半。
 *
 * 只做两件事：
 *   1. 从 Host 的 `/plugins/dsh-workbuddy-guard/state` 取「当前该不该有水印、写什么」；
 *   2. 自己判断「现在有没有 workbuddy 会话在跑」，只有跑着的时候才把水印画出来。
 *
 * 为什么第 2 件事放在浏览器而不是 Host：`running` 是会话级的瞬时状态，Host 每 15 秒
 * 才轮询一次文件，等它把「刚起跑 / 刚停」传回来，水印早就滞后了；而浏览器这半本来就
 * 订阅着会话列表（`sessions.list`），拿到的是实时值，切 provider、起停一轮立刻就有反应。
 *
 * 显示规则（与产品约定一致）：
 *   - **有 workbuddy 系 provider 的会话正在运行** → 全局显示；
 *   - 没有 → 不显示（哪怕 guard.json 里还留着水印内容）；
 *   - 「知道了」只是先收起来：只要还有 workbuddy 会话在跑，过一会儿它会带入场动画
 *     重新浮现；等没有会话在跑时再点，就不会再冒出来；
 *   - workbuddy-connect 更新（revision 变化）是一切的复位点。
 *
 * 设计取舍：
 *   - 用 `shell.overlay`（frame 级浮层，在每一列之上、不在滚动容器里），
 *     这样切会话、滚页面都不会把它带走。
 *   - 玻璃感浮层：半透明底色 + `backdrop-filter` 模糊 + 极细描边 + 顶部高光，
 *     让水印像「浮在页面之上的一层玻璃」，而不是一块实心色条。底色由级别
 *     颜色（主题令牌）混进背景层颜色，亮/暗主题各自成立。
 *   - 入场/退场动画各自 340ms / 180ms；`prefers-reduced-motion` 时全部关掉。
 *   - 水印**不吃点击**：容器 `pointer-events: none`，只有卡片与「知道了」可点，
 *     否则它会挡住下面的对话。
 *   - 颜色全部走 `--dsw-alias-*` 主题令牌，亮/暗两套主题都自己跟着变。
 *
 * 关于「重启后水印还在」：
 *   那不是浏览器缓存。水印值持久化在 `guard.json` 里，Host 每次启动都会重新读它
 *   并推给浏览器 —— 这是有意的（危险提示必须活过重启）。唯一在重启后**应该**
 *   消失的是「插件已升级，重启生效」那条：脚本写它时带 `untilRestart: true`，
 *   Host 半在启动时发现 `watermark.at` 早于自己的启动时刻，就把 guard.json 里的
 *   水印清成 null（见 index.js 的 `clearStaleWatermark`）。浏览器这半只负责如实
 *   渲染，不做任何「猜它该不该过期」的判断。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE_URL = '/plugins/dsh-workbuddy-guard/state'
    const POLL_MS = 30_000
    const STYLE_ID = 'dsh-workbuddy-guard:styles'
    /** 退场动画时长；到点再真正卸载卡片。 */
    const LEAVE_MS = 180
    /** 「知道了」之后隔多久重新浮出来（前提：仍有 workbuddy 会话在跑）。 */
    const RESHOW_MS = 1800
    /** 被守卫的 provider 前缀，与 index.js 的 GUARDED_PROVIDERS 保持一致。 */
    const GUARDED_PROVIDERS = ['workbuddy', 'workbuddy-global']

    /**
     * 每种级别对应的强调色。
     *
     * 只用一个「强调色」而不是「底色/前景色」一对：玻璃卡的其余颜色都由它
     * 与背景层、正文标签色混出来，主题切换时不会出现某一块没跟上。
     */
    const ACCENTS = {
      danger: 'var(--dsw-alias-state-error-primary, #e5484d)',
      warning: 'var(--dsw-alias-state-warn-primary, #f76b15)',
      info: 'var(--dsw-alias-state-business-primary, #3b82f6)',
    }

    function accentFor(level) {
      return ACCENTS[level] ?? ACCENTS.danger
    }

    /**
     * 样式表只注入一次。
     *
     * 用 `<style>` 而不是全内联，是为了拿到 `:hover` / `:focus-visible` /
     * `@keyframes` / `prefers-reduced-motion` —— 这些内联样式都表达不了，
     * 而水印里恰好每一样都用得上。
     */
    const CSS = `
.dsh-wbg-root {
  position: absolute;
  /* 两条让位，按顺序叠加：
       --dsh-frame-overlay-top  macOS / Windows 原生标题栏高度（DSH 自己给的）
       --wbg-gap                会话标题栏那一行的高度再加一点呼吸空间。
                                它是 76px 高、压在同一个 overlay 层的最上面，
                                不避开就会盖住会话标题与「对话 / 轨迹」标签。 */
  top: calc(var(--dsh-frame-overlay-top, 0px) + var(--wbg-gap, 84px));
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  pointer-events: none;
  z-index: 2147483000;
  padding: 10px 12px 0;
}
.dsh-wbg-card {
  box-sizing: border-box;
  pointer-events: auto;
  max-width: min(720px, 100%);
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 12px 12px 14px;
  border-radius: 14px;
  /* 逐条「先给退路、再给正式值」：浏览器不认 color-mix 时前面的声明仍然成立 */
  background-color: var(--dsw-alias-bg-layer-2, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .12));
  color: var(--dsw-alias-label-primary, #111111);
  background-color: var(--wbg-glass);
  border-color: var(--wbg-stroke);
  color: var(--wbg-ink);
  background-image:
    linear-gradient(180deg, rgba(255, 255, 255, .16), rgba(255, 255, 255, 0) 58%),
    linear-gradient(var(--wbg-glass), var(--wbg-glass));
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  backdrop-filter: blur(20px) saturate(160%);
  box-shadow:
    0 12px 32px -10px rgba(0, 0, 0, .42),
    0 2px 8px rgba(0, 0, 0, .14),
    inset 0 1px 0 rgba(255, 255, 255, .22);
  font: inherit;
  line-height: 1.45;
  transform-origin: top center;
  animation: dsh-wbg-rise .34s cubic-bezier(.2, .85, .25, 1) both;
}
.dsh-wbg-card.dsh-wbg-leaving {
  animation: dsh-wbg-sink .18s ease-in both;
}
.dsh-wbg-rail {
  flex: none;
  width: 3px;
  align-self: stretch;
  border-radius: 999px;
  background: var(--wbg-accent);
  opacity: .85;
}
.dsh-wbg-body {
  flex: 1 1 auto;
  min-width: 0;
}
.dsh-wbg-title {
  font-weight: 700;
  font-size: 14px;
  letter-spacing: .02em;
  color: var(--wbg-ink, var(--dsw-alias-label-primary, #111111));
}
.dsh-wbg-text {
  margin-top: 2px;
  font-size: 13px;
  white-space: pre-wrap;
  color: var(--dsw-alias-label-secondary, #555555);
}
.dsh-wbg-detail {
  margin-top: 4px;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary, #777777);
  font-variant-numeric: tabular-nums;
}
.dsh-wbg-btn {
  flex: none;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .12));
  background: transparent;
  color: var(--dsw-alias-label-secondary, #555555);
  border-radius: 8px;
  padding: 3px 10px;
  font-size: 12px;
  line-height: 18px;
  font-family: inherit;
  cursor: pointer;
  transition: background-color .15s ease, color .15s ease, border-color .15s ease;
}
.dsh-wbg-btn:hover {
  background: color-mix(in srgb, var(--wbg-accent) 20%, transparent);
  border-color: var(--wbg-accent);
  color: var(--dsw-alias-label-primary, #111111);
}
.dsh-wbg-btn:focus-visible {
  outline: 2px solid var(--wbg-accent);
  outline-offset: 2px;
}
@keyframes dsh-wbg-rise {
  from { opacity: 0; transform: translateY(-14px) scale(.97); filter: blur(6px); }
  to { opacity: 1; transform: none; filter: blur(0); }
}
@keyframes dsh-wbg-sink {
  from { opacity: 1; transform: none; filter: blur(0); }
  to { opacity: 0; transform: translateY(-10px) scale(.98); filter: blur(4px); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-wbg-card { animation: none; }
  .dsh-wbg-card.dsh-wbg-leaving { animation: none; opacity: 0; }
  .dsh-wbg-btn { transition: none; }
}
`

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** 读一个值；失败就是「没有水印」，不抛。 */
    function useGuardState() {
      const [state, setState] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        let timer
        const load = async () => {
          try {
            const res = await fetch(STATE_URL, { cache: 'no-store' })
            if (res.ok) {
              const next = await res.json()
              // 端点出错时保留上一份值，避免网络抖一下水印就闪掉
              if (alive) setState(next)
            }
          } catch { /* 端点没准备好就等下一轮 */ }
        }
        const tick = async () => {
          await load()
          if (alive) timer = setTimeout(tick, POLL_MS)
        }
        void tick()
        // 切回标签页时立刻对一次：重启 DSH 之后回到页面是最常见的场景
        const onVisible = () => { if (document.visibilityState === 'visible') void load() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          if (timer !== undefined) clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])
      return state
    }

    /**
     * 有没有「正在跑的 workbuddy 会话」。
     *
     * 数据直接来自浏览器的会话列表：`running` 是 Host 给的实时状态，
     * `projectionValues.modelSelection` 是该会话当前的 provider。两者都是现成的，
     * 不需要再向 Host 要一个专用接口，也不需要等 15 秒的文件轮询。
     *
     * `next` 优先于 `lastUsed`：刚切过去还没发消息时，`next` 才是「你现在打算用谁」。
     */
    function useGuardedSessionsRunning(sessions) {
      // 拿不到会话服务 → 不知道谁在跑，退回「保守显示」，别让守卫静默失效
      const [running, setRunning] = React.useState(sessions === undefined || sessions === null)
      React.useEffect(() => {
        if (sessions === undefined || sessions === null) return
        const read = () => {
          let found = false
          try {
            const snap = sessions.list.getSnapshot()
            for (const id of snap.ids) {
              const row = snap.byId[id]
              if (row === undefined || row.running !== true) continue
              const selection = row.projectionValues?.modelSelection
              const pick = selection?.next ?? selection?.lastUsed
              if (pick !== undefined && GUARDED_PROVIDERS.includes(pick.provider)) {
                found = true
                break
              }
            }
          } catch { found = false }
          setRunning(found)
        }
        read()
        return sessions.list.subscribe(read)
      }, [sessions])
      return running
    }

    /**
     * 水印的显示状态机。
     *
     * 规则（用户约定）：
     *   - 有 workbuddy 会话在跑 → 显示；没有 → 不显示（哪怕 guard.json 里还留着内容）；
     *   - 「知道了」只是收起来一会儿：只要还有 workbuddy 会话在跑，`RESHOW_MS` 后
     *     带入场动画重新浮出；等没有会话在跑时点，就安静地不再冒出来；
     *   - revision 变化（workbuddy-connect 更新）是复位点。
     *
     * 也就是说，**「知道了」不会永久关掉一个正在发生的风险**，它只负责把眼前这块
     * 玻璃收走一秒半。真正让它停下来的，是风险本身消失（没有 workbuddy 会话在跑）。
     */
    function Watermark({ sessions }) {
      const state = useGuardState()
      const watermark = state?.watermark ?? null
      const revision = state?.revision ?? null
      const running = useGuardedSessionsRunning(sessions)

      /** 被「知道了」暂时收起的那个 revision；null = 没被收起。 */
      const [snoozedRevision, setSnoozedRevision] = React.useState(null)
      const [leaving, setLeaving] = React.useState(false)
      const leaveTimer = React.useRef()
      const reshowTimer = React.useRef()

      /** 当前这条水印被用户收起过、并且还没到该重新出现的时候。 */
      const snoozed = snoozedRevision !== null && snoozedRevision === revision

      // 没有 workbuddy 会话在跑了 → 解除收起，下次再跑起来时重新提示
      React.useEffect(() => {
        if (!running && snoozed) setSnoozedRevision(null)
      }, [running, snoozed])

      // revision 变了（插件更新）→ 一切复位，重新播入场动画
      React.useEffect(() => {
        setSnoozedRevision(null)
        setLeaving(false)
      }, [revision])

      React.useEffect(() => () => {
        if (leaveTimer.current !== undefined) clearTimeout(leaveTimer.current)
        if (reshowTimer.current !== undefined) clearTimeout(reshowTimer.current)
      }, [])

      React.useEffect(() => { ensureStyles() }, [])

      const visible = watermark !== null && running && !snoozed
      if (!visible) return null

      const accent = accentFor(watermark.level)

      /**
       * 玻璃卡的三块颜色都由强调色推出来（全部留在 CSS 变量里，主题切换时
       * 自动重算）：
       *   --wbg-glass  底色：强调色 12% + 背景层 62%（剩下是透明，让模糊透上来）
       *   --wbg-stroke 描边：强调色 42%
       *   --wbg-ink    标题：强调色混正文字色，保证亮主题下也够深
       */
      const vars = {
        '--wbg-accent': accent,
        '--wbg-glass': 'color-mix(in srgb, var(--wbg-accent) 12%, color-mix(in srgb, var(--dsw-alias-bg-layer-1, #ffffff) 62%, transparent))',
        '--wbg-stroke': 'color-mix(in srgb, var(--wbg-accent) 42%, transparent)',
        '--wbg-ink': 'color-mix(in srgb, var(--wbg-accent) 72%, var(--dsw-alias-label-primary, #111111))',
      }

      const onDismiss = () => {
        setLeaving(true)
        leaveTimer.current = setTimeout(() => {
          setSnoozedRevision(revision)
          setLeaving(false)
          // 还有会话在跑 → 过一会儿重新浮出来；没有就不排这一班车
          reshowTimer.current = setTimeout(() => {
            setSnoozedRevision((current) => (current === revision ? null : current))
          }, RESHOW_MS)
        }, LEAVE_MS)
      }

      return h('div', { className: 'dsh-wbg-root' }, h('div', {
        className: leaving ? 'dsh-wbg-card dsh-wbg-leaving' : 'dsh-wbg-card',
        role: 'status',
        'aria-live': 'polite',
        style: vars,
      }, h('div', { className: 'dsh-wbg-rail' }), h('div', { className: 'dsh-wbg-body' },
        h('div', { className: 'dsh-wbg-title' }, watermark.title ?? 'WB 更新了'),
        // 正文里保留换行：脚本写进来的就是带 \n 的一句
        watermark.body
          ? h('div', { className: 'dsh-wbg-text' }, watermark.body)
          : null,
        watermark.detail
          ? h('div', { className: 'dsh-wbg-detail' }, watermark.detail)
          : null,
      ), h('button', {
        type: 'button',
        className: 'dsh-wbg-btn',
        onClick: onDismiss,
        title: '隐藏这条提示（下次版本变化会再次出现）',
      }, '知道了')))
    }

    /** `sessions` 是可选的：拿不到就退回「只看 guard.json」的老行为，不至于白屏。 */
    let clientSessions

    return {
      // `sessions` 用来判断「有没有 workbuddy 会话在跑」；不声明 inject 时 ctx.get 拿不到它
      inject: ['slots', 'sessions'],
      apply(ctx) {
        ensureStyles()
        clientSessions = ctx.get('sessions')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-workbuddy-guard',
          order: 100,
        }, () => h(Watermark, { sessions: clientSessions })))
      },
    }
  },
})
