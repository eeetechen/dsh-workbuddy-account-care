# dsh-workbuddy 账号呵护

> `dsh-workbuddy-account-care` —— WorkBuddy 账号的看门人。
>
> **本仓库是 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy) 的配套辅助插件——它不提供任何模型能力，只为那个插件踩刹车。**
>
> **安装本插件之前，请先安装 `dsh-connect-workbuddy`。** 没有它，本插件不产生任何效果。
>
> WorkBuddy 官方接口报的版本号一旦和本地记录的对不上，立刻停用那个插件；它自己在 npm 上有新版，就自动升级并提示重启。
> 全程零模型调用，DSH 不启动就什么都不做。

![WorkBuddy 升级后的红色水印](docs/watermark-updated.png)

---

## ⚠️ 前置条件：先装 `dsh-connect-workbuddy`

**本插件是 `dsh-connect-workbuddy` 的配套插件，不是它的替代品，也不能单独工作。**
它没有自己的模型、没有自己的 provider、没有自己的界面入口；它的全部动作都围绕
「那个插件现在安不安全」展开。所以你**必须先装好 `dsh-connect-workbuddy`，再来装本插件**。

请先按这里的说明安装好：

👉 **<https://github.com/dingminhua/dsh-connect-workbuddy>**

```bash
# 1) 先装 dsh-connect-workbuddy（按它自己的 README）
dsh plugin --profile web add dsh-connect-workbuddy

# 2) 确认它已被选中、且模型选择器里能看到 WorkBuddy 的模型
#    然后才装本插件
dsh plugin --profile web add dsh-workbuddy-account-care
```

**没装就完全不动。** 本插件每次检查前先确认 `dsh-connect-workbuddy` 真的在
`node_modules` 里；不在就整轮跳过——不停用、不升级、不挂水印、不碰 profile，
连基线都不写（只留一行日志说明为什么跳过）。

这条不是礼貌，是必需的：本插件的一项动作是「自动升级
`dsh-connect-workbuddy`」。在没有装它的机器上，那个动作会变成**凭空安装一个
你没要求过的插件**。所以未安装时它必须彻底安静。

## 它解决什么

`dsh-connect-workbuddy` 靠 **WorkBuddy 客户端的私有接口**工作（伪装客户端、
复用本机登录态），客户端一更新，那些接口随时可能变。这个插件把风险面收窄成两条规则：

| 事件 | 动作 |
|---|---|
| **WorkBuddy 版本号与基线不一致** | 红色水印 + 让你选怎么结束（软结束 / 硬结束）+ 桌面通知(防止伤害到你的账号的鳞片) |
| **`dsh-connect-workbuddy` 在 npm 上有新版** | 自动升级 + 橙色水印提示重启 DSH |
| 什么都没有 | 静默，只写一行日志 |

判断依据只有一个数字：**接口报的版本号 ≠ 本地记录的基线版本号**。规则很硬，
没有「可能」、「大概」、「指纹相近」——对不上就是变了，对上就什么都不做。
而这个版本号本身取自**两处**：接口字段、安装包文件名，取高者（见下）。

## 判定数据源

整个插件只读**一个**外部数据源：

```
GET https://www.workbuddy.cn/v2/update?platform=workbuddy-darwin-x64
```

```json
{
  "version": "5.9.3.42398134",
  "productVersion": "5.9.3.42398134",
  "url": "https://download.codebuddy.cn/workbuddy/saas/…-5.9.3.42398134-d4692421.zip",
  "sha256hash": "e093e214…",
  "timestamp": 1793121334
}
```

每轮探 **5 个平台**，只有 3 个参与判定：

| 角色 | platform | 参与判定 |
|---|---|---|
| 判定 | `workbuddy-darwin-x64` / `-arm64` / `workbuddy-win32-x64-user` | ✅ 三者取高者 |
| 记录 | `workbuddy-linux-x64-deb` / `-arm64-deb` | ❌ 只写日志与 `--status` |

**为什么把 Linux 摘出去**：实测它整线滞后一个大版本段（`5.6.2` vs `5.9.3`），
算进「取高者」只会制造噪声。等官方三端对齐了，把它加回
`PLATFORMS_JUDGE` 即可，代码里就一个数组。

每个平台从响应里取**两个**版本号：

| # | 来源 | 例子 |
|---|---|---|
| 1 | `productVersion`（没有时退回 `version`） | `5.9.3.42398134` |
| 2 | `url` 的**文件名**里的版本号 | `WorkBuddy-darwin-x64-5.9.3.42398134-d4692421.dmg` → `5.9.3.42398134` |

单个平台内部，两者取高；三个判定平台之间，再取高者，得到**判定版本**。
最后与 `state.json` 的 `baseline.version` 做**字符串比较**：不等就报一次
「版本不一致」。

链接按平台给，脚本按**各自的平台**分别解析文件名，格式是稳定的一段：

```
…/workbuddy/saas/darwin-x64/WorkBuddy-darwin-x64-5.9.3.42398134-d4692421.dmg
                                     └── 平台 ──┘ └─── 版本 ───┘ └ 构建 ┘ └扩展┘
```

`.dmg` / `.zip` 是同一版本的两个包（其它平台是 `.deb` / `.exe` / `.AppImage`），
所以**扩展名不参与判定**，版本号才参与。同一版本号有 4 段数字，最后一段是构建号；
构建哈希（`d4692421`）是十六进制、不含点，不会被误认成版本。

> **只解析，不下载。** 这个插件每次检查只读几百字节，为了一句「没看错」去拖 180MB
> 的安装包显然不合理。解析是纯字符串操作：拆 URL、取最后一段、跑一条正则。
> 它也不会对链接发 HEAD 或任何请求。

**两处不一致时取高者，不投票。** 发布是不同步的——清单先改、CDN 上的文件名
晚几分钟跟上（或者反过来）是常态。要求两者一致，等于每次发版都要白等一个检查
周期；取高者的含义很直接：**谁先说新版本，就按谁算**。低的那一路只记一条
`warn` 日志，`--status` 的 `lastJudge.versionGap` 里也能看到，方便排查。

## 安装

三种都行，装完都要**重启 DSH**——Host 半只有重启才会换。

```bash
# 1) 直接指向本地目录（开发时最方便，改完只需重启 Host）
dsh plugin --profile web add link:/path/to/dsh-workbuddy-account-care

# 2) 装 GitHub Release 里的 tarball（推荐给使用者）
dsh plugin --profile web add /path/to/dsh-workbuddy-account-care-0.0.6.tgz

# 3) 如果以后发到了 npm
dsh plugin --profile web add dsh-workbuddy-account-care
```

浏览器半（`client.js`）改完刷新页面即可，不用重启进程。

**没有定时器要装。** 插件自带定时：**加载完立即跑第一次**，之后每 3 分钟一次，
不需要 systemd、cron、launchd，也不需要 DSH 的「自动化任务」。

> `0.0.6` 起，首次检查不再等一个间隔；并且把**用户能感知的那两段**轮询收紧到秒级。
>
> **从触发到看见水印，要经过三段轮询**：
>
> | 段 | 做什么 | 旧 | 新 |
> |---|---|---|---|
> | ① | 派生 `watch.mjs` 探官方版本接口 | 3 分钟 | 3 分钟（**后台检查，用户无感**） |
> | ② | 宿主读 `guard.json` 并发布水印 | 15 秒 | **2 秒**（脚本跑完还会立刻同步一次） |
> | ③ | 浏览器拉 `/plugins/…/state` | 30 秒 | **5 秒**（仅标签页可见时） |
>
> 段① 刻意保持 3 分钟：它是后台探测，多等两分钟用户不会有任何感觉；
> 真正会被察觉的是 ②③ 那两段「已经知道了却还没显示出来」的延迟，所以只收紧它们。
>
> 各时机的行为：
>
> | 时机 | 行为 |
> |---|---|
> | DSH 启动、bundle 加载完成 | `startupDelayMs`（默认 **3 秒**，只用来躲开 profile 收敛）后立刻检查 |
> | 运行中安装 / 卸载 / 改启用状态 | 收到 `plugin-manager/changed` 后 **1 秒**内补跑一次 |
> | `dsh-connect-workbuddy` 一时读不到 | 先按 **15 秒**重试，最多 4 次，再回到常规节奏 |
> | 其余 | 每 `intervalMinutes`（默认 **3 分钟**）一次 |

装完之后可以这样确认它在工作：

```bash
npx dsh-workbuddy-account-care status    # 插件状态：目标插件版本 / 启用与否 / 水印 / 检查次数
npx dsh-workbuddy-account-care where     # 各条路径 + 当前定时来源
```

`status` 里 `plugin on` 指的是 **`dsh-connect-workbuddy`** 是否仍被选中——
本插件自己始终是启用的，它不守自己。


## 界面

**WorkBuddy 版本不一致时**（红色，等你选软结束 / 硬结束）：

![升级水印](docs/watermark-updated.png)

**插件自身升级后**（橙色，提示重启）：

![插件升级水印](docs/watermark-upgraded.png)

- 水印挂在 `shell.overlay`（frame 级浮层），切会话、滚页面都不会带走。
- **玻璃感浮层**：半透明底色 + `backdrop-filter` 模糊 + 极细描边 + 顶部高光，
  像浮在页面之上的一层玻璃，而不是一块实心色条；入场 340ms 从上方淡入浮起，
  关闭 180ms 淡出下沉。
- 容器 `pointer-events: none`，不吃点击，不挡对话。
- 颜色跟随主题令牌（`--dsw-alias-*`），亮/暗自动适配；`prefers-reduced-motion` 时动画全关。

## 工作方式

只有一条定时链，全部在 DSH 进程内：

```
dsh-workbuddy-account-care（Host 半）
  ├─ 加载完 → 3 秒后立刻 spawn 一次 scripts/watch.mjs
  ├─ 运行中装/卸插件（plugin-manager/changed）→ 1 秒后补跑一次
  ├─ 之后每 3 分钟 spawn 一次 scripts/watch.mjs
  │     ├─ 前置检查：dsh-connect-workbuddy 装了吗？没装 → 直接退出
  │     │   （插件侧读不到时先 15 秒 × 4 次短重试，避免把「还在收敛」误判成未安装）
  │     ├─ 探 5 个平台（mac×2 + win 判定，linux×2 只记录）
  │     │   ├─ 每个平台：productVersion ↔ url 文件名版本，取高
  │     │   └─ 三个判定平台之间再取高 = 判定版本
  │     ├─ 读 npm 上 dsh-connect-workbuddy 的 latest
  │     ├─ 判定版本 ≠ 基线 → 写 guard.json（水印，等你选软结束/硬结束）
  │     │                    基线随即推进，同一版本不会反复弹
  │     └─ npm 有新版本 → 写 guard.json 的 upgrade 指令
  │
  │   （升级不由脚本执行：脚本是 node 派生的独立进程，
  │     在 Desktop 里没有 dsh 命令可用，见下节）
  │
  ├─ 脚本退出时立刻同步一次（不等下一轮轮询）
  └─ 每 2 秒读一次 guard.json
        ├─ 水印 → 经 HTTP 端点给浏览器半，由它在 shell.overlay 里画
        ├─ upgrade 指令 → 按环境挑一条路执行安装，结果回写 guard.json
        └─ 软结束指令 → cancel 正在跑的轮次 + followup 一条「本机 provider 已更新…」
```

### 升级 `dsh-connect-workbuddy` 的三条路

这个插件同时活在两种宿主里，而它们**没有共同的可执行入口**，所以按环境挑一条：

| 顺序 | 方式 | 适用 | 说明 |
|---|---|---|---|
| 1 | `host-service` | DSH Desktop（Electron）、任何装了 `dsh-plugin-manager` 的 profile | 用 `ctx.get('pluginManager')` 调 `installBundle`。与界面里点「更新」同一条 pnpm 路径，装完自动 reconcile `dsh.profile.bundles`，HMR 下可热生效。**不需要 `dsh` 在 PATH 上** |
| 2 | `dsh-cli` | 命令行启动的 Harness（`dsh web`） | 调 `dsh plugin --profile <p> add <spec>`。Windows 上经 `cmd.exe /c` 调用 `.cmd` |
| 3 | `none` | 两者都没有 | 只记录、不改动，把结论写进日志与 `--status`，由你手动升 |

**为什么不能只用 CLI**：`scripts/watch.mjs` 是 `node` 派生的独立子进程，它继承的是
**宿主进程的 PATH**。DSH Desktop 的宿主里没有 `dsh` 命令——安装目录下只有
`dsh.cmd`，而 Node 从 18.20/20.12/21.7 起修 CVE-2024-27980，**拒绝**在不带 shell
时 spawn `.cmd`/`.bat`：

```
execFileSync('dsh', …)              → ENOENT   （PATHEXT 不参与解析）
execFileSync('…\dsh.cmd', …)        → EINVAL   （防注入保护）
```

所以 0.0.5 及更早在桌面端的自动升级是 100% 失败的（日志里只有一条
`spawnSync dsh ENOENT`）。0.0.6 起改为「脚本判定、宿主执行」：桌面端走第 1 条，
命令行端走第 2 条。

升级指令写在 `guard.json` 的 `upgrade` 字段，宿主每 15 秒读一次。执行结果回写为
`done` / `failed`，`--status` 可以直接看到当前卡在哪一步：

```bash
npx dsh-workbuddy-account-care check --status
# → "upgrade": {"status":"done","method":"host-service","application":"applied", …}
```

同一个 `from → to` 只会下发一次；失败后最多重试 2 次（防每轮无限重试）。

水印的生命周期分在两半，各管一段：

```
scripts/watch.mjs                  index.js（Host 半）                 client.js（浏览器半）
  ├─ 写 watermark{at}              ├─ 首次 poll 先判过期：             ├─ 每 5 秒 / 切回标签页拉一次
  ├─ 危险水印：不带 untilRestart   │   untilRestart 且 at < 启动时刻    ├─ 玻璃卡在 shell.overlay 里淡入
  └─ 升级水印：带 untilRestart     │   → 清成 null、revision +1        └─ 「知道了」按 revision 记 localStorage
                                   ├─ 脚本退出后立刻同步一次
                                   └─ 之后每 2 秒读 guard.json
```

## 首次执行时机

检查由 Host 半自己排期，所以「什么时候跑第一次」完全是插件的行为，与 DSH
的自动化任务无关。`0.0.6` 的行为：

```
bundle 加载
   │  startupDelayMs（默认 3000ms）—— 只为躲开 profile 收敛，不是等一个间隔
   ▼
第一次检查 ──► 之后每 intervalMinutes（默认 3 分钟）
   ▲
   │  以下任一情况会把下一次检查**提前**到秒级：
   │    · plugin-manager/changed（运行中安装 / 卸载 / 改启用状态）→ 1 秒
   │    · 目标插件一时读不到（profile 还在收敛）→ 15 秒重试，最多 4 次
```

为什么不是「apply 里同步跑」：`apply()` 执行时 Cordis 的 loader 树可能还没收敛，
此时问 `pluginManager.listBundles()` 会短暂看不到 `dsh-connect-workbuddy`，
这一轮就会被误判成「目标未安装」而跳过。3 秒足够绝大多数机器走完收敛，又短到
用户感觉不到；嫌慢可以设 `startupDelayMs: 0`。

首次执行也会走完整的判定链路（探接口、比基线、升级插件），不是一次「预热」。
如果目标插件确实未安装，脚本按既有规则整轮跳过、不写任何状态。

对应的回归用例：`test/startup-check.test.mjs`（排期逻辑）、
`test/e2e-startup.test.mjs`（用假 ctx 真跑一遍 `apply()`，观察脚本被派生的时刻）。

## 软结束会话

只针对**正在跑**（`status === 'running'`）且**确实在用 WorkBuddy**的会话，
「在用」只认**会话投影 `modelSelection`**——它和界面上的模型选择器读的是同一份
数据（`next = pending ?? lastUsed`），所以不会出现「界面没提示、会话却被停用」。

> 以前还把 `agent.options.provider` 当独立证据，那是会话**创建时**的配置，中途
> 换 provider 不会更新。结果一条一直在用 deepseek 的会话（只是在对话里聊到
> WorkBuddy）被软结束了。现在它只在投影服务整个不可用时才参与，而且要与最后
> 一条 assistant 消息的 provider 同时命中才算。`test/uses-workbuddy.test.mjs`
> 锁住了这个行为。

具体动作：

1. `agent.cancel({ kind: 'hook' }, { keepInbox: true })` —— 中止当前轮，保留收件箱；
2. `agent.followup(...)` —— 排一条「本机 provider 已更新，本条消息由监控插件自动发送，收到后暂停你的所有任务, 等待重启 agent 工具」

先 cancel 再 followup 是有意的：那条说明才会成为下一轮的唯一输入，而不是被
这次中止一起丢掉。已经软结束过的会话不会重复插入（收件箱里有
「本条消息由监控插件自动发送」这句话就跳过），空闲会话不动。

## 命令

```bash
npx dsh-workbuddy-account-care status    # 插件状态：版本、启用与否、水印、检查次数
npx dsh-workbuddy-account-care where     # 各条路径 + 当前定时来源
npx dsh-workbuddy-account-care check     # 立刻跑一次检查
```

`check` 可透传：

```bash
npx dsh-workbuddy-account-care check --dry-run            # 演练，不落盘
npx dsh-workbuddy-account-care check --check              # 只检查，绝不改 profile
npx dsh-workbuddy-account-care check --enable             # 恢复被停用的插件
npx dsh-workbuddy-account-care check --clear-watermark    # 只清界面水印
npx dsh-workbuddy-account-care check --no-upgrade         # 跳过自动升级
npx dsh-workbuddy-account-care check --status             # 机器可读 JSON
```

也可以直接跑脚本：

```bash
node node_modules/dsh-workbuddy-account-care/scripts/watch.mjs
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖，改完重启 DSH：

```yaml
- id: dsh-workbuddy-account-care
  name: dsh-workbuddy-account-care
  config:
    intervalMinutes: 3      # 内置定时间隔，分钟
    selfSchedule: true      # false = 关掉内置定时（此时不会有任何自动检查）
    startupDelayMs: 3000    # 加载后多久跑第一次；0 = 立刻（默认就是秒级，不是等一个间隔）
    notify: true            # false = 不弹桌面通知
    pollMs: 15000           # 读指令文件的轮询间隔
    profile: desktop        # 目标 profile（强烈建议显式写，见下）
```

### ⚠️ 请显式配置 `profile`

**这一项建议每个用户都显式写上**，尤其是用 **DSH Desktop（Electron 客户端）** 的：

```yaml
    profile: desktop        # Desktop 用户
    # profile: web          # 命令行 `dsh web` 用户（这也是不写时的默认候选首位）
```

**为什么必须显式配**：本插件的检测脚本需要知道「去哪个 profile 里找 `dsh-connect-workbuddy`」。
它读的是 `config.profile` → 环境变量 `DSH_PROFILE` → 默认值。但 **DSH Desktop 是 Electron
应用，宿主进程从托盘/快捷方式启动时不带 `DSH_PROFILE` 环境变量**，于是取值回落到默认，
而用户实际用的往往不是那个 profile。结果是脚本去错的目录里找目标插件，报
「未安装」，然后**整轮静默跳过**——看起来像插件没工作，实际是查错了地方。

排查这种「什么都没发生」时，先看 `--status` 的 `profileResolution.source`：
`detected-miss` 配 `pluginInstalled: null` 基本就是这个原因。

**不配也能工作**（0.0.6 起）：没给 `--profile`、没给 `config.profile`、也没有 `DSH_PROFILE`
时，脚本会**按候选顺序串行探测**，第一个真正装了 `dsh-connect-workbuddy` 的 profile 胜出。
默认候选顺序是 `desktop` → `web`（Desktop 优先，因为那是 Electron 用户最常见的形态）。

三种输入，优先级从高到低：

| 顺序 | 来源 | 行为 |
|---|---|---|
| 1 | `--profile-dir <目录>` | 目录说了算，名字只用于日志 |
| 2 | `--profile <名字>` / `config.profile` | **只认它，不回退**（显式即精确，便于排障） |
| 3 | 都没有 | 按候选顺序探测；全都没装则回落到候选首位，走「未安装则完全静默」路径 |

候选顺序也可以显式覆盖：

```jsonc
// ~/.dsh/workbuddy-update-watch/config.json 里
{ "profile": "desktop" }              // 等价于 config.profile，但不必重启 DSH
```

命令行临时指定：

```bash
node scripts/watch.mjs --profile desktop --check    # 只查这一个，不回退
node scripts/watch.mjs --profiles web,desktop --check   # 自定义探测顺序
```

> 探测是**串行**的，不是并行：脚本用 `run.lock` 做全局互斥，并行会互相抢锁。
> 单次探测只读一个 `package.json`，串行代价可以忽略。

策略文件 `~/.dsh/workbuddy-update-watch/config.json`：

```json
{ "autoDisable": false }
```

| 键 | 含义 |
|---|---|
| `autoDisable` | `false`（**默认**）= 检测到先挂提示，由你在界面上选；`true` = 检测到就当场停用（无人值守） |
| `disableOn` | 旧键，为兼容保留。`"never"` 仍然有效（命中只挂提示、永不自动改 profile）；其它值都等同于默认 |
| `profile` | 目标 profile 名（等价于 `config.profile`，改完不必重启 DSH） |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 主目录 |
| `DSH_PROFILE` | 未设 → 按候选探测 | 目标 profile。**Desktop 客户端通常不设这个变量**，所以更推荐用 `config.profile`（见上） |
| `WORKBUDDY_WATCH_PLATFORM` | 按平台猜 | 版本接口的 platform 标识（`workbuddy-darwin-x64`、`workbuddy-linux-x64-deb`、`workbuddy-win32-x64-user`） |
| `WORKBUDDY_WATCH_UPSTREAM` | 官网 `/v2/update` | 覆盖版本接口（自建镜像、内网代理时用） |
| `WORKBUDDY_WATCH_DISABLE_ON_UPSTREAM` | 未设 | 兼容旧配置；设为 `1` 仍表示「命中即算停用条件」 |

## 状态文件

都在 `$DSH_HOME/workbuddy-update-watch/`：

| 文件 | 内容 |
|---|---|
| `state.json` | 基线版本（`baseline.version` / `source` / `linkFile`）、最近一次两路判定（`lastJudge`）、已见版本、事件去重 |
| `guard.json` | 给插件的指令（水印 + 软结束），插件回写 `handled` |
| `watch.log` | 每次检查一行 |
| `config.json` | 策略（可选） |
| `run.lock` | 多执行器互斥（手动跑与定时跑撞车时用） |
| `package.json.bak-*` | 每次改 profile 前的备份 |

## 许可

MIT
