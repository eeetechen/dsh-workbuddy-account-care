/**
 * dsh-workbuddy 账号呵护 —— 浏览器半。
 *
 * 只做两件事：
 *   1. 从 Host 的 `/plugins/dsh-workbuddy-account-care/state` 取「当前该不该有水印、写什么」；
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
  id: 'dsh-workbuddy-account-care',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const STATE_URL = '/plugins/dsh-workbuddy-account-care/state'
    /**
     * 拉取水印的间隔。
     *
     * 这是**三段轮询里最靠近用户的一段**：宿主已经把值准备好了，浏览器晚多久
     * 拉就晚多久看见。原来 30 秒太钝——用户从触发到看见最坏要等 3.75 分钟，
     * 而这一段就占了 30 秒。
     *
     * 5 秒的代价很小：一个 GET、几百字节、命中内存里的值。真正需要省的是
     * 段①（派生 Node 子进程去探 5 个平台的接口），不是这一段。
     *
     * 只在标签页可见时轮询（见下方的 visibilitychange）：后台标签不拉，
     * 所以「用户开着 10 个后台标签」不会变成 10 倍压力。
     */
    const POLL_MS = 5_000
    const STYLE_ID = 'dsh-workbuddy-account-care:styles'
    /** 退场动画时长；到点再真正卸载卡片。 */
    const LEAVE_MS = 180
    /** 「知道了」之后隔多久重新浮出来（前提：仍有 workbuddy 会话在跑）。 */
    const RESHOW_MS = 1800
    /** 用户在这里选「软结束 / 硬结束」时打到 Host 的端点。 */
    const ACTION_URL = '/plugins/dsh-workbuddy-account-care/action'
    /** 被呵护插件的 provider 前缀，与 index.js 的 GUARDED_PROVIDERS 保持一致。 */
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
.dsh-wbg-actions {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: stretch;
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
.dsh-wbg-btn:disabled {
  opacity: .55;
  cursor: default;
}
/* 软结束：描边强调，不填色——它只是「排一条消息」 */
.dsh-wbg-btn--soft {
  border-color: color-mix(in srgb, var(--wbg-accent) 55%, transparent);
  color: var(--wbg-accent);
}
/* 硬结束：填色强调——它会立刻打断正在跑的会话 */
.dsh-wbg-btn--hard {
  background: var(--wbg-accent);
  border-color: var(--wbg-accent);
  color: #ffffff;
}
.dsh-wbg-btn--hard:hover:not(:disabled) {
  background: color-mix(in srgb, var(--wbg-accent) 82%, var(--dsw-alias-label-primary, #111111));
  border-color: var(--wbg-accent);
  color: #ffffff;
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
          // 只在可见时轮询：后台标签页没有任何人看，拉也没有意义，
          // 而且开着多个标签时会把宿主的 /state 打成 N 倍流量。
          // 切回前台由 visibilitychange 立刻补一次，所以看不到「延迟」。
          if (document.visibilityState !== 'hidden') await load()
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
     * 「现在是不是在用 workbuddy」，两个来源任一命中即算：
     *
     *   1. **当前正在看的会话**（`retainedBy.mainView`）**选中**的 provider 是 workbuddy 系
     *      —— 这一条让水印在「刚在菜单里点下 WorkBuddy 模型」的瞬间就浮出来，
     *      不用等发送。`modelSelection.next` 就是 `pending ?? lastUsed`，用户点选会先写
     *      `model/selection` 事件，投影立刻变，浏览器这边一个订阅就收到了。
     *   2. **任何正在跑（running）的会话**用的是 workbuddy 系 —— 后台跑着的会话也算。
     *
     * 为什么只对「当前会话」看选中值、对「其它会话」要求 running：
     * 历史会话的 `lastUsed` 会长期保留 workbuddy，如果对全部会话都只看选中值，
     * 那么只要曾经用过一次 WorkBuddy，水印就会永远亮着——那正是要修掉的问题。
     */
    function useWorkbuddyUsage(sessions) {
      // 拿不到会话服务 → 不知道谁在用，退回「保守显示」，别让呵护插件静默失效
      const [usage, setUsage] = React.useState(
        sessions === undefined || sessions === null ? { running: true, selected: true } : { running: false, selected: false },
      )
      React.useEffect(() => {
        if (sessions === undefined || sessions === null) return
        const guarded = (row) => {
          const selection = row?.projectionValues?.modelSelection
          const pick = selection?.next ?? selection?.lastUsed
          return pick !== undefined && GUARDED_PROVIDERS.includes(pick.provider)
        }
        const read = () => {
          let running = false
          let selected = false
          try {
            const snap = sessions.list.getSnapshot()
            // 1) 当前正在看的会话：选中即提示（刚切过去、还没发送也算）
            const main = Object.values(snap.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0)
            const mainIsWb = main !== undefined && guarded(main)
            if (mainIsWb) selected = true
            /**
             * 2) **后台**会话正在跑 wb。
             *
             * 必须排除「当前正在看的那个会话」：用户眼前这个会话当然也在
             * running（他正在跟它说话），把它算进「后台有任务」会让按钮组合
             * 永远停在「软结束/硬结束」——需求要的是
             * 「只有前台选 provider、没有后台任务 → 关闭插件/知道了」。
             *
             * 判据用 `retainedBy.mainView`：它标记了主视图正在展示哪个会话。
             */
            for (const id of snap.ids) {
              const row = snap.byId[id]
              if (row === undefined || row.running !== true) continue
              if ((row.retainedBy?.mainView ?? 0) > 0) continue
              if (guarded(row)) { running = true; break }
            }
          } catch { running = false; selected = false }
          setUsage((prev) => (prev.running === running && prev.selected === selected ? prev : { running, selected }))
        }
        read()
        return sessions.list.subscribe(read)
      }, [sessions])
      return usage
    }

    /**
     * 水印的显示状态机。
     *
     * 规则（用户约定）：
     *   - 正在用 workbuddy（当前会话选中它，或有会话在跑）→ 显示；
     *     没有 → 不显示（哪怕 guard.json 里还留着内容）；
     *   - 「知道了」只是收起来一会儿：还在用就 `RESHOW_MS` 后带入场动画重新浮出；
     *     已经切走 / 没会话在跑，就安静地不再冒出来；
     *   - revision 变化（workbuddy-connect 更新）是复位点。
     *
     * 也就是说，**「知道了」不会永久关掉一个正在发生的风险**，它只负责把眼前这块
     * 玻璃收走一秒半。真正让它停下来的，是风险本身消失（切走 provider 或停跑）。
     */
    function Watermark({ sessions }) {
      const state = useGuardState()
      const watermark = state?.watermark ?? null
      const revision = state?.revision ?? null
      const usage = useWorkbuddyUsage(sessions)
      /**
       * 显示门控（需求 3）：**只要还在用 workbuddy 就显示**，
       * 三条来源任一命中：
       *
       *   1. 当前正在看的会话选中了 wb provider（切换那一刻就算，不用发消息）
       *   2. 任何后台会话正在跑 wb provider（切到别的界面也照样显示）
       *   3. 已停用后用户强开了插件，且当前会话是 wb（同样被 1 覆盖）
       *
       * 三个都不成立 → 不显示。这正是需求第 25 行要的
       * 「所有 wb 后台结束、且当前会话不是 wb → 自然消失」。
       */
      const gateOpen = usage.running || usage.selected

      /** 被「知道了」暂时收起的那个 revision；null = 没被收起。 */
      const [snoozedRevision, setSnoozedRevision] = React.useState(null)
      /** 正在执行的动作（soft/hard/ack）；非 null 时按钮全部禁用。 */
      const [busy, setBusy] = React.useState(null)
      /** 动作失败的原因，直接显示在卡片里。 */
      const [failed, setFailed] = React.useState(null)
      /**
       * 动作成功时记下「我处理掉的是哪一个 revision」，只压制那一条。
       *
       * 早先这里是个裸布尔：置 true 之后永远不再复位，于是动作做完、你重新开启
       * 插件并选中 WorkBuddy 时，水印被这个残留标记挡住——看起来像浏览器缓存，
       * 其实是组件状态没跟着 revision 走。现在绑到 revision 上，Host 一抬高
       * revision 它就自动失效。
       */
      const [finishedRevision, setFinishedRevision] = React.useState(null)
      const [leaving, setLeaving] = React.useState(false)
      const leaveTimer = React.useRef()
      const reshowTimer = React.useRef()

      /** 当前这条水印被用户收起过、并且还没到该重新出现的时候。 */
      const snoozed = snoozedRevision !== null && snoozedRevision === revision

      /**
       * 收起状态的解除只有一个触发点：workbuddy **重新被用起来**（false → true）。
       *
       * 之前写成「只要不在用就解除」，于是没在跑 workbuddy 时点「知道了」，
       * 下一秒又被解除、卡片立刻弹回来——表现就是「关不掉」。
       * 现在收起是持久的：只有真的又开始用 WorkBuddy（或插件更新）才会重新提示。
       */
      const gateRef = React.useRef(gateOpen)
      const previousGate = React.useRef(gateOpen)
      React.useEffect(() => {
        gateRef.current = gateOpen
        if (gateOpen && !previousGate.current) setSnoozedRevision(null)
        previousGate.current = gateOpen
      }, [gateOpen])

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

      const finished = finishedRevision !== null && finishedRevision === revision
      const visible = watermark !== null && gateOpen && !snoozed && !finished
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
          /**
           * `dismissible: true` 的水印点了之后**永久收起**，不再复活。
           *
           * 这类水印提示的是一件**已经完成**的事（例如「插件已升级，已热生效」），
           * 没有未了的风险，反复弹只会让人烦。而 WB 版本来不及适配那种红牌
           * 不带这个字段——它必须一直提醒到用户真的处理为止。
           */
          if (watermark?.dismissible === true) return
          // 只有「还在用 WorkBuddy」才重新浮出来；没在用就安静地收着
          reshowTimer.current = setTimeout(() => {
            if (!gateRef.current) return
            setSnoozedRevision((current) => (current === revision ? null : current))
          }, RESHOW_MS)
        }, LEAVE_MS)
      }

      /**
       * 软结束 / 硬结束。
       *
       * 这两个动作会真的改 profile，所以按钮在请求期间全部禁用，避免连点。
       * 成功后 Host 会把待确认水印清掉，本地也立刻收起，不用等下一轮轮询。
       */
      const runAction = async (action) => {
        if (busy !== null) return
        if (action === 'ack') { onDismiss(); return }
        setBusy(action)
        setFailed(null)
        try {
          const res = await fetch(ACTION_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          })
          const payload = await res.json().catch(() => ({}))
          if (!res.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${res.status}`)
          /**
           * Host 明确回报「没停用成功」时，**不能**把它当成处理完。
           *
           * 旧版这里只看 HTTP 状态；而 Host 曾无条件把水印改成已处理，于是
           * 停用失败也返回 200，界面收起卡片、用户以为好了，实际 provider 还在。
           * Host 现在会带 `disabledOk`，这里据此判断。
           */
          if (payload.disabledOk === false) {
            const detail = payload.disabled?.error
              ?? payload.disabled?.stderr
              ?? payload.disabled?.result?.result?.reason
              ?? 'bundle 未能停用'
            throw new Error(detail)
          }
          setFinishedRevision(revision)
        } catch (error) {
          setFailed(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      /** 按钮文字：正在执行的那个显示进行时文案。 */
      const label = (action, idle, running) => (busy === action ? running : idle)

      const actions = Array.isArray(watermark.actions) ? watermark.actions : []
      /**
       * **按钮组合在客户端实时计算**，不用宿主写死的那份。
       *
       * 为什么改：宿主 `withLiveActions` 只在 `revision` 变化时才重算，
       * 而会话启停不会改 revision —— 于是按钮永远卡在第一次算出来的那份。
       * 用户看到的就是「明明没有后台任务，却还是软结束/硬结束/知道了」。
       *
       * 客户端这边订阅了 `sessions`，会话一停就立刻重算，天然是实时的。
       *
       * 规则（需求 3）：
       *   有后台 wb 会话在跑        → soft / hard / ack
       *   没有后台任务（仅前台选中） → close / ack
       *
       * 已处理过的水印（`handledBy` 存在）永远用 close/ack 那一套：
       * 它只在用户强开插件后才出现，此时该做的事就是再关掉。
       */
      const isPending = watermark.pendingDisable === true
      const hasBackground = usage.running === true
      const autoActions = watermark.handledBy !== undefined || !isPending
        ? ['close', 'ack']
        : (hasBackground ? ['soft', 'hard', 'ack'] : ['close', 'ack'])
      /**
       * 升级类水印（带 `dismissible` 或 `untilRestart`）保留宿主给的 actions：
       * 它们只有「知道了」一个按钮，与有没有会话无关。
       */
      const isUpgradeCard = watermark.dismissible === true || watermark.untilRestart === true
      const effectiveActions = isUpgradeCard ? actions : autoActions
      /**
       * 按钮表由**宿主**决定（`actions` 字段），客户端只负责画。
       *
       * 需求 3 要求两套形态：
       *   有后台 wb 会话 → soft / hard / ack
       *   没有后台 wb 会话 → close / ack
       *
       * 其中 `close` 与 `hard` 的**效果相同**（都是停用 dsh-workbuddy-connect），
       * 只是文案不同：有会话在跑时说「硬结束」更像在终止什么，没会话在跑时说
       * 「关闭插件」才符合用户脑中的模型。两套实现是刻意的——共用一套代码、
       * 只是把按钮表当数据传下来。
       */
      const BUTTONS = {
        soft: {
          label: '软结束',
          running: '正在结束…',
          className: 'dsh-wbg-btn--soft',
          title: '给正在跑的会话发一条暂停消息，等它停下来再停用插件',
        },
        hard: {
          label: '硬结束',
          running: '正在停用…',
          className: 'dsh-wbg-btn--hard',
          title: '立刻停用 dsh-connect-workbuddy（正在跑的会话会被打断）',
        },
        close: {
          label: '关闭插件',
          running: '正在关闭…',
          className: 'dsh-wbg-btn--hard',
          title: '停用 dsh-connect-workbuddy',
        },
        ack: {
          label: '知道了',
          running: '知道了',
          className: '',
          title: watermark.dismissible === true
            ? '收起这条提示（不再出现）'
            : '先收起这条提示（还在用 WorkBuddy 时它会再次出现）',
        },
      }
      /** 按算出来的顺序画；未知 action 直接忽略。 */
      const visibleActions = effectiveActions.filter((action) => BUTTONS[action] !== undefined)

      return h('div', { className: 'dsh-wbg-root' }, h('div', {
        className: leaving ? 'dsh-wbg-card dsh-wbg-leaving' : 'dsh-wbg-card',
        role: 'status',
        'aria-live': 'polite',
        style: vars,
      },
      h('div', { className: 'dsh-wbg-rail' }),
      h('div', { className: 'dsh-wbg-body' },
        h('div', { className: 'dsh-wbg-title' }, watermark.title ?? 'WB 更新了'),
        // 正文里保留换行：脚本写进来的就是带 \n 的一句
        watermark.body
          ? h('div', { className: 'dsh-wbg-text' }, watermark.body)
          : null,
        watermark.detail
          ? h('div', { className: 'dsh-wbg-detail' }, watermark.detail)
          : null,
        failed === null
          ? null
          : h('div', { className: 'dsh-wbg-detail', style: { color: 'var(--wbg-accent)' } }, `操作失败：${failed}`),
      ),
      h('div', { className: 'dsh-wbg-actions' },
        ...visibleActions.map((action) => {
          const spec = BUTTONS[action]
          return h('button', {
            key: action,
            type: 'button',
            className: `dsh-wbg-btn ${spec.className}`.trim(),
            disabled: busy !== null,
            onClick: () => { void runAction(action) },
            title: spec.title,
          }, label(action, spec.label, spec.running))
        }),
      )))
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
          id: 'dsh-workbuddy-account-care',
          order: 100,
        }, () => h(Watermark, { sessions: clientSessions })))
      },
    }
  },
})
