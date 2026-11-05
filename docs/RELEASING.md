# 发布与迁移

这份文档写给**维护者**，不是使用者。使用者在 README 的「安装」一节就够了。

## 不变式：三处必须是同一份东西

一次合格的发布，下面三个东西指的是同一个字节流：

| 位置 | 值 |
|---|---|
| git tag | `v0.0.3` → 提交 `04e0f24` |
| GitHub Release 资产 | `dsh-workbuddy-account-care-0.0.3.tgz` |
| npm 上的包 | `dsh-workbuddy-account-care@0.0.3` |

校验方式：`npm pack` 是可复现的，同一份工作区反复打包得到的 sha256 相同。

```bash
npm pack --pack-destination /tmp/p
shasum -a 256 /tmp/p/*.tgz dist/*.tgz   # 两行必须一致
```

所以**发布之后不要再动 `package.json`**（哪怕只是加个字段）。真要改，就升版本重来。

## 发一版

```bash
cd ~/github.com/dsh-workbuddy-account-care

# 1) 改版本（0.0.3 → 0.0.4），提交，打 tag
npm version patch --no-git-tag-version     # 只改 package.json 的 version
git add package.json && git commit -m "0.0.4"
git tag -a v0.0.4 -m "v0.0.4"
git push origin main && git push origin v0.0.4

# 2) 打产物（同时用于 npm 与 Release）
mkdir -p dist && npm pack --pack-destination dist
shasum -a 256 dist/*.tgz > dist/SHA256SUMS

# 3) 发布到 npm（凭据见下文）
~/.dsh/npm/publish.sh status
~/.dsh/npm/publish.sh dry-run
~/.dsh/npm/publish.sh publish

# 4) GitHub Release：网页上选 tag、贴说明、上传 dist 里的 tgz
```

`npm publish` **必须显式指定 registry**：本机 `~/.npmrc` 默认指向
`registry.npmmirror.com`，那是只读镜像，往它发会 403。`publish.sh` 已经处理了这件事。

## 凭据放在哪

**绝不进仓库。** 这个仓库是 public 的。凭据住在仓库外：

```
~/.dsh/npm/
├── publish.sh          # status / backup / restore / dry-run / publish
├── publish.env.example # 模板
├── publish.env         # 真 token，chmod 600
└── README.md           # 迁移说明
```

两层备份：

```bash
~/.dsh/npm/publish.sh backup    # publish.env → macOS Keychain
~/.dsh/npm/publish.sh restore   # Keychain → publish.env
```

token 类型选 **Automation**：2FA 账号下 Class​ic/Publish token 每次发布都要
`--otp`，Automation 可以在脚本里免交互。

## 迁移到新机器

1. `mkdir -p ~/.dsh/npm && chmod 700 ~/.dsh/npm`
2. 拷 `publish.sh`、`publish.env.example`、`README.md`（都是非密的，或从本仓库重建）
3. 取回 token，二选一：
   - 旧机器上 `security find-generic-password -s npm:dsh-workbuddy-account-care -w`
     取值，新机器上 `security add-generic-password -s npm:dsh-workbuddy-account-care -a "$USER" -w '<token>' -U`
   - 或者去 npm 网站吊销旧 token、生成新的，填进 `publish.env`
4. `~/.dsh/npm/publish.sh status` 应当打印 `npm 认这个 token，身份：<用户名>`

## 账号本身（不只是 token）

token 是钥匙，账号是锁。要重建账号，只需要记住三样：

| 项 | 从哪查 |
|---|---|
| npm 用户名 | `npm whoami`，或 `publish.env` 的 `NPM_USER` |
| 绑定邮箱 | npm 网站 Settings → 或 `publish.env` 的 `NPM_EMAIL` |
| 包名 | `dsh-workbuddy-account-care` |

**包名是稀缺资源。** 名字一旦被发布过，即使账号丢了也放不出来（除非
`npm unpublish`，而它只在发布后 72 小时内、且无人依赖时可用）。所以：

- 用**专用账号**（如 `dsh-workbuddy-bot`）而不是私人主账号 —— 吊销一次不牵连别的包
- 账号一建好就把邮箱验证完，并开启 2FA
- 第一时间把 Automation token 存进 Keychain，别只留在聊天记录里

万一账号真的丢了，退路是换名发布（`@yourscope/dsh-workbuddy-account-care`），
而不是等旧名回笼。

## 本机安装（发布之后自测）

```bash
dsh plugin --profile web add dsh-workbuddy-account-care --registry=https://registry.npmjs.org
```

刚发布时镜像（npmmirror）还没同步，所以要 `--registry` 直连；同步之后可以去掉。
