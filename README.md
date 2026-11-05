# dsh-workbuddy-guard

> **本仓库是 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy) 的配套辅助插件——它不提供任何模型能力，只为那个插件踩刹车。**
>
> **安装本插件之前，请先安装 `dsh-connect-workbuddy`。** 没有它，本插件不产生任何效果。
>
> WorkBuddy 官方接口报的版本号一旦和本地记录的对不上，立刻停用那个插件；它自己在 npm 上有新版，就自动升级并提示重启。
> 全程零模型调用，DSH 不启动就什么都不做。

![WorkBuddy 升级后的红色水印](docs/watermark-updated.png)

---

## ⚠️ 前置条件：先装 `dsh-connect-workbuddy`

**本插件是 `dsh-connect-workbuddy` 的守卫，不是它的替代品，也不能单独工作。**
它没有自己的模型、没有自己的 provider、没有自己的界面入口；它的全部动作都围绕
「那个插件现在安不安全」展开。所以你**必须先装好 `dsh-connect-workbuddy`，再来装本插件**。

请先按这里的说明安装好：

👉 **<https://github.com/dingminhua/dsh-connect-workbuddy>**

```bash
# 1) 先装 dsh-connect-workbuddy（按它自己的 README）
dsh plugin --profile web add dsh-connect-workbuddy

# 2) 确认它已被选中、且模型选择器里能看到 WorkBuddy 的模型
#    然后才装本守卫
dsh plugin --profile web add dsh-workbuddy-guard
```

**没装就完全不动。** 守卫每次检查前先确认 `dsh-connect-workbuddy` 真的在
`node_modules` 里；不在就整轮跳过——不停用、不升级、不挂水印、不碰 profile，
连基线都不写（只留一行日志说明为什么跳过）。

这条不是礼貌，是必需的：本守卫的一项动作是「自动升级
`dsh-connect-workbuddy`」。在没有装它的机器上，那个动作会变成**凭空安装一个
你没要求过的插件**。所以未安装时它必须彻底安静。

## 它解决什么

`dsh-connect-workbuddy` 靠 **WorkBuddy 客户端的私有接口**工作（伪装客户端、
复用本机登录态），客户端一更新，那些接口随时可能变。这个守卫把风险面收窄成两条规则：

| 事件 | 动作 |
|---|---|
| **WorkBuddy 版本号与基线不一致** | 红色水印 + 让你选怎么结束（软结束 / 硬结束）+ 桌面通知 |
| **`dsh-connect-workbuddy` 在 npm 上有新版** | 自动升级 + 橙色水印提示重启 DSH |
| 什么都没有 | 静默，只写一行日志 |

判断依据只有一个数字：**接口报的版本号 ≠ 本地记录的基线版本号**。规则很硬，
没有「可能」、「大概」、「指纹相近」——对不上就是变了，对上就什么都不做。
而这个版本号本身取自**两处**：接口字段、安装包文件名，取高者（见下）。

## 判定数据源

整个守卫只读**一个**外部数据源：

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

从这条响应里取**两个**版本号：

| # | 来源 | 例子 |
|---|---|---|
| 1 | `productVersion`（没有时退回 `version`） | `5.9.3.42398134` |
| 2 | `url` 的**文件名**里的版本号 | `WorkBuddy-darwin-x64-5.9.3.42398134-d4692421.dmg` → `5.9.3.42398134` |

两者取**高的那个**，再与 `state.json` 的 `baseline.version` 做**字符串比较**：
不等就报一次「版本不一致」。

链接按平台给，脚本只按本机平台去解析文件名，格式是稳定的一段：

```
…/workbuddy/saas/darwin-x64/WorkBuddy-darwin-x64-5.9.3.42398134-d4692421.dmg
                                  └── 平台 ──┘ └─── 版本 ───┘ └ 构建 ┘ └扩展┘
```

`.dmg` / `.zip` 是同一版本的两个包（其它平台是 `.deb` / `.exe` / `.AppImage`），
所以**扩展名不参与判定**，版本号才参与。同一版本号有 4 段数字，最后一段是构建号；
构建哈希（`d4692421`）是十六进制、不含点，不会被误认成版本。

> **只解析，不下载。** 这个守卫每 3 分钟跑一次，为了一句「没看错」去拖 180MB
> 的安装包显然不合理。解析是纯字符串操作：拆 URL、取最后一段、跑一条正则。
> 它也不会对链接发 HEAD 或任何请求。

**两处不一致时取高者，不投票。** 发布是不同步的——清单先改、CDN 上的文件名
晚几分钟跟上（或者反过来）是常态。要求两者一致，等于每次发版都要白等一个检查
周期；取高者的含义很直接：**谁先说新版本，就按谁算**。低的那一路只记一条
`warn` 日志，`--status` 的 `lastJudge.versionGap` 里也能看到，方便排查。

**刻意不读本机安装。** 早先的版本靠在客户端的安装目录里翻 `app.asar` 的
`package.json`、内置插件的 build id、`cli/product.json` 的 commit，拼成一个指纹。
那样做有两个问题：安装布局每个平台都不一样（deb 在 `/opt/WorkBuddy`，
macOS 在 `/Applications/WorkBuddy.app/Contents`），漏读就静默降级；而且
「同版本重装、`app.asar` 大小变了一点」这种与版本无关的改动也会触发。

代价必须说清楚：**读不到接口就无法判定**。请求超时、404、断网时，脚本这一轮
什么都不做——不报警、不推进基线、不改配置，只在日志里记一行。它不会拿上次的
结果硬猜，也不会把「读不到」当成「变了」。

升级后想恢复：

```bash
npx dsh-workbuddy-guard check --enable
```

## 安装

```bash
# 从目录/压缩包
dsh plugin --profile web add /path/to/dsh-workbuddy-guard

# 然后重启 DSH，或刷新 Web 页面
```

**没有定时器要装。** 插件自带定时（每 3 分钟），不需要 systemd、cron、launchd，
也不需要 DSH 的「自动化任务」。

装完之后可以这样确认它在工作：

```bash
npx dsh-workbuddy-guard status    # 守卫状态：目标插件版本 / 启用与否 / 水印 / 检查次数
npx dsh-workbuddy-guard where     # 各条路径 + 当前定时来源
```

`status` 里 `plugin on` 指的是 **`dsh-connect-workbuddy`** 是否仍被选中——
本守卫自己始终是启用的，它不守卫自己。

> DSH 的「自动化任务」是**按计划给会话发一条消息**——每触发一次就是一次完整
> 的模型回合。3 分钟一次等于一天 480 个回合，去换 480 句「无变化」。这件事
> 没有任何需要模型判断的地方，所以定时器放在进程里，不经过模型。

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

### 检测到更新：先问你，再动手

**默认不再自动停用。** 检测到接口版本与基线不一致之后，守卫会：

1. 先看**有没有正在运行的 workbuddy 会话**——没有就不打扰；有才在界面顶部挂提示；
2. 等你在提示上选一个结束方式。

提示上有三个按钮：

| 按钮 | 行为 |
|---|---|
| **软结束** | 给正在跑的 workbuddy 会话发「本机 provider 已更新，本条消息由监控插件自动发送，收到后暂停你的所有任务, 等待重启 agent 工具」，等它们真的停下来（最多 120 秒），再停用插件 |
| **硬结束** | 立刻停用插件（正在跑的会话会被打断，provider 立即从模型选择器里消失） |
| **知道了** | 只把提示收起来；会话还没停就再次浮出来，停了就安静收着 |

水印在动作完成后**不会被删掉**，只是换成不带按钮的「已停用」版本：这样你之后强开
插件时，它还能继续跟着 provider 选择出现/消失。

停用之后 `dsh-connect-workbuddy` 只是从 `dsh.profile.bundles` 里摘掉，`dependencies`
保留，一条 `--enable` 就能恢复。

> 为什么默认不自动停用：一个正在跑的任务被悄悄中止，代价比晚几秒停用大得多。
> 需要无人值守时，把 `~/.dsh/workbuddy-update-watch/config.json` 的
> `autoDisable` 设成 `true`，就回到旧行为（检测到即停用）。

### 水印跟随 provider：切模型的那一刻就出现

水印**不再是无条件常驻**，也不会等到你按下发送才出现。下面任一条件成立就画出来：

> 1. **当前正在看的会话**（`retainedBy.mainView`）**选中**的 provider 是 workbuddy 系；
> 2. 任何**正在运行**（`running`）的会话用的是 workbuddy 系。

第 1 条就是「切模型即提示」：在模型菜单里点下 WorkBuddy 的模型，**还没发送**，
水印就已经浮出来了。这条能成立，是因为 `modelSelection` 投影的 `next` 是
`pending ?? lastUsed`——点选先写 `model/selection` 事件，投影立刻变，浏览器这边
的订阅一个帧内就收到，不用等下一轮对话。

| 操作 | 水印 |
|---|---|
| 在模型菜单里选中 WorkBuddy 模型（未发送） | **立即浮出**（红色 / 橙色，看级别） |
| 切回 DeepSeek 等其它 provider | 立即收回 |
| 后台有 workbuddy 会话在跑 | 保持显示 |
| 插件被停用、你强开 `dsh-connect-workbuddy` 继续用 | 再次浮出来 |

为什么「当前会话看选中值、其它会话要求 running」：历史会话的 `lastUsed` 会长期
保留 workbuddy，若对所有会话都只看选中值，只要用过一次 WorkBuddy，水印就会永远
亮着——那正是要修掉的问题。

**两个阶段的门控不一样**，这是刻意的：

| 阶段 | 什么时候显示 |
|---|---|
| **待确认**（插件还开着，等你选软结束/硬结束） | 只有**有 workbuddy 会话正在跑**时才显示 |
| **已处理 / 你强开了插件** | **跟随 provider 选择**：选中 workbuddy 就出现，切走就消失 |

**「知道了」不会永久关掉一个正在发生的风险。** 它只把眼前这块玻璃收起来：

- 还在用 workbuddy（选中或在跑）→ 1.8 秒后带入场动画重新浮出（先消失、再出现）；
- 已经切走 / 没有会话在跑 → 安静地不再冒出来；
- workbuddy-connect 更新（`revision` 变化）→ 一切复位。

这样做的理由很直接：一个「你正在用它、而它可能已经坏了」的提示，被一次点击永久
关掉是不合理的；真正的解除条件应该是风险消失，而不是用户点了一下。

### 水印的**内容**什么时候消失（不是浏览器缓存）

上面讲的是「显不显示」；这里讲的是「内容还在不在」。水印的值**持久化在
`guard.json` 里**，Host 每次启动都会重新读它并推给浏览器——所以「重启后提示还在」
从来不是缓存没清，而是这条记录本来就该留着。两类水印的内容生命周期不同：

| 水印 | 什么时候消失 |
|---|---|
| 🔴 `WB 更新了`（危险，插件已停用） | **一直留着**，直到你 `check --enable` 或 `check --clear-watermark`。它必须活过重启——重启不等于你知道了。 |
| 🟠 `插件已升级，重启生效` | **重启后自动消失**。脚本写它时带 `untilRestart: true` 与 `at`；插件启动后第一次轮询发现 `at` 早于自己的启动时刻，就把 `guard.json` 里的水印清成 `null` 并抬高 revision，浏览器半下一次轮询（≤30 秒）就会把它撤掉。 |

清除优先于发布：清除串在第一次发布之前，所以不会出现「先闪出旧卡片再消失」。
另外切回标签页时浏览器半会立刻补拉一次状态，不用等 30 秒的轮询周期。

想立刻手动清掉当前那条：`npx dsh-workbuddy-guard check --clear-watermark`。

## 工作方式

只有一条定时链，全部在 DSH 进程内：

```
dsh-workbuddy-guard（Host 半）
  ├─ 每 3 分钟 spawn 一次 scripts/watch.mjs
  │     ├─ 前置检查：dsh-connect-workbuddy 装了吗？没装 → 直接退出
  │     ├─ 读 WorkBuddy 官方接口 /v2/update，取出两路版本号
  │     │   ├─ productVersion
  │     │   ├─ url 文件名里的版本号（只解析，不下载）
  │     │   └─ 取高者 = 判定版本
  │     ├─ 读 npm 上 dsh-connect-workbuddy 的 latest
  │     ├─ 判定版本 ≠ 基线 → 写 guard.json（水印，等你选软结束/硬结束）
  │     │                    基线随即推进，同一版本不会反复弹
  │     └─ npm 有新版本 → dsh plugin add 升级它，写「重启生效」水印
  │
  └─ 每 15 秒读一次 guard.json
        ├─ 水印 → 经 HTTP 端点给浏览器半，由它在 shell.overlay 里画
        └─ 软结束指令 → cancel 正在跑的轮次 + followup 一条「本机 provider 已更新…」
```

水印的生命周期分在两半，各管一段：

```
scripts/watch.mjs                  index.js（Host 半）                 client.js（浏览器半）
  ├─ 写 watermark{at}              ├─ 首次 poll 先判过期：             ├─ 每 30 秒 / 切回标签页拉一次
  ├─ 危险水印：不带 untilRestart   │   untilRestart 且 at < 启动时刻    ├─ 玻璃卡在 shell.overlay 里淡入
  └─ 升级水印：带 untilRestart     │   → 清成 null、revision +1        └─ 「知道了」按 revision 记 localStorage
                                   └─ 之后每 15 秒读 guard.json
```

**为什么停用由脚本做而不是插件自己做**：派生出去的是独立进程，即使插件因为
别的原因半死不活，它照样能把危险的 bundle 关掉。判断只有一个执行者（脚本），
呈现只有一个执行者（插件），不重叠。

## 软结束会话

只针对**正在跑**（`status === 'running'`）且**确实在用 WorkBuddy**（投影
`modelSelection`、`agent.options`、日志里最后一条 assistant 消息，三路任一命中）
的会话：

1. `agent.cancel({ kind: 'hook' }, { keepInbox: true })` —— 中止当前轮，保留收件箱；
2. `agent.followup(...)` —— 排一条「本机 provider 已更新，本条消息由监控插件自动发送，收到后暂停你的所有任务, 等待重启 agent 工具」

先 cancel 再 followup 是有意的：那条说明才会成为下一轮的唯一输入，而不是被
这次中止一起丢掉。已经软结束过的会话不会重复插入（收件箱里有
「本条消息由监控插件自动发送」这句话就跳过），空闲会话不动。

## 命令

```bash
npx dsh-workbuddy-guard status    # 守卫状态：版本、启用与否、水印、检查次数
npx dsh-workbuddy-guard where     # 各条路径 + 当前定时来源
npx dsh-workbuddy-guard check     # 立刻跑一次检查
```

`check` 可透传：

```bash
npx dsh-workbuddy-guard check --dry-run            # 演练，不落盘
npx dsh-workbuddy-guard check --check              # 只检查，绝不改 profile
npx dsh-workbuddy-guard check --enable             # 恢复被停用的插件
npx dsh-workbuddy-guard check --clear-watermark    # 只清界面水印
npx dsh-workbuddy-guard check --no-upgrade         # 跳过自动升级
npx dsh-workbuddy-guard check --status             # 机器可读 JSON
```

也可以直接跑脚本：

```bash
node node_modules/dsh-workbuddy-guard/scripts/watch.mjs
```

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖，改完重启 DSH：

```yaml
- id: dsh-workbuddy-guard
  name: dsh-workbuddy-guard
  config:
    intervalMinutes: 3      # 内置定时间隔，分钟
    selfSchedule: true      # false = 关掉内置定时（此时不会有任何自动检查）
    notify: true            # false = 不弹桌面通知
    pollMs: 15000           # 读指令文件的轮询间隔
```

策略文件 `~/.dsh/workbuddy-update-watch/config.json`：

```json
{ "autoDisable": false }
```

| 键 | 含义 |
|---|---|
| `autoDisable` | `false`（**默认**）= 检测到先挂提示，由你在界面上选；`true` = 检测到就当场停用（无人值守） |
| `disableOn` | 旧键，为兼容保留。`"never"` 仍然有效（命中只挂提示、永不自动改 profile）；其它值都等同于默认 |

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH 主目录 |
| `DSH_PROFILE` | `web` | 目标 profile |
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

## 已知边界

- **DSH 不在跑就不检查。** 刻意如此：没有 DSH 进程，就没有任何请求会发出去，
  那时检查没有意义。
- **版本对不上就算变了，不区分升级还是降级**。降级（客户端被回滚到旧构建）
  同样可能打破插件假设，所以不分方向。
- **接口读不到就不判定**。断网 / 接口 404 / 超时那一轮什么都不做：不报警、
  不推进基线、不改配置。宁可晚一轮，也不拿「读不到」当「变了」。
- **基线即上次接口值**。所以在同一版本上只弹一次；想重新落基点，删掉
  `state.json` 里的 `baseline`（下一轮静默重建，不报警）。`--check` 也**不**推进
  基线——它只是「看一眼」，跑一次不该把这次变化消费掉。
- **基线是旧格式时静默重锚一次**。从「本机指纹」规则切过来的机器，旧基线
  （如 `5.9.2.42136757`）与新判据（接口版本 `5.9.3.42398134`）不是一个体系，
  直接比会凭空弹一次；所以脚本把它当「没有基线」处理，直接落新基点，
  在 `watch.log` 里留一行说明。
- **Host 插件改代码要重启 DSH**：HMR 不会重新加载已装载的 Host 模块。
  浏览器半（`client.js`）不一样：`client-hmr` 会盯着它的构建产物，文件一变
  页面自己就重新加载。
- **水印文案写死在脚本里**（`updateWatermark()`），改文案改脚本即可。
- **过期判定依据时间戳**：`untilRestart` 水印靠 `at` 与本进程启动时刻比较。
  系统时钟被往回调时，该过期的那条可能多留一会儿；判不出来时一律不清，
  宁可多留一条提示，也不误删危险水印。
- **升级不会自动重启 DSH**：升级一路只挂「重启生效」水印，不动用户进程。
- **停用只是取消选中**：`dependencies` 保留，`--enable` 一条命令恢复。

## 许可

MIT
