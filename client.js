/**
 * WorkBuddy 版本守卫 —— 浏览器半。
 *
 * 只做一件事：在 `shell.overlay` 里画一条持久水印。值来自 Host 的
 * `/plugins/dsh-workbuddy-guard/state`，轮询间隔比 Host 那边松（30 秒）——
 * 水印晚 30 秒出现没有任何代价，而每分钟多打两次请求是看得见的。
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
    const DISMISS_KEY = 'dsh-workbuddy-guard:dismissed'
    const STYLE_ID = 'dsh-workbuddy-guard:styles'
    /** 退场动画时长；到点再真正卸载卡片。 */
    const LEAVE_MS = 180

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
     * 「知道了」只对**同一条**水印有效：把 revision 记进 localStorage，
     * revision 一变就重新显示。用户关掉的是这条消息，不是这个能力。
     */
    function useDismissed(revision) {
      const [dismissed, setDismissed] = React.useState(false)
      React.useEffect(() => {
        if (revision === undefined || revision === null) { setDismissed(false); return }
        try {
          setDismissed(window.localStorage.getItem(DISMISS_KEY) === String(revision))
        } catch { setDismissed(false) }
      }, [revision])
      const dismiss = React.useCallback(() => {
        try { window.localStorage.setItem(DISMISS_KEY, String(revision)) } catch { /* 隐私模式 */ }
        setDismissed(true)
      }, [revision])
      return [dismissed, dismiss]
    }

    function Watermark() {
      const state = useGuardState()
      const watermark = state?.watermark ?? null
      const revision = state?.revision ?? null
      const [dismissed, dismiss] = useDismissed(watermark === null ? null : revision)
      const [leaving, setLeaving] = React.useState(false)
      const leaveTimer = React.useRef()

      // 新的水印（revision 变了）重新播一次入场动画
      React.useEffect(() => { setLeaving(false) }, [revision])
      React.useEffect(() => () => {
        if (leaveTimer.current !== undefined) clearTimeout(leaveTimer.current)
      }, [])

      React.useEffect(() => { ensureStyles() }, [])

      if (watermark === null || dismissed) return null

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
        leaveTimer.current = setTimeout(() => { dismiss() }, LEAVE_MS)
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

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyles()
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-workbuddy-guard',
          order: 100,
        }, Watermark))
      },
    }
  },
})
