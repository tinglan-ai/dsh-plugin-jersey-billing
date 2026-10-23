# Znb 计费统计插件

按模型单价与实时用量统计 DSH **全部会话**在 Znb API 中转站（`znbcode.com`）的花费，
支持 **今天 / 本周 / 本月 / 全部** 四个时间窗口切换，单价可在面板内直接编辑并持久化。

> **同事安装请看 [INSTALL.md](INSTALL.md)** —— 那里只有安装和使用的步骤。

## 统计范围（硬编码，没有开关）

只统计 **provider = `znb-gongsi`** 的调用。

本机在 `znbcode.com` 上配了两个账号，插件只认其中计费的那个：

| provider | 是否统计 | 说明 |
|---|---|---|
| `znb-gongsi` | **统计** | 走公司额度，本插件唯一统计对象 |
| `znbcode` | 不统计 | 同一站点上的另一个账号 |
| 其他所有 provider | 不统计 | 泽西、官方账号、别的中转站，一律不计 |

这条规则写死在 Host 半边（`ZNB_PROVIDER`），面板上没有开关可以改。
被排除的 provider 会在面板顶部列出来，方便你确认没算错东西。

同理，**没有配置单价的模型也整条跳过**，不会回退到别的模型的价格去估算。

## 功能

- **全会话统计**：扫描 `DSH_HOME/sessions` 下所有会话日志，不限于当前会话。
- **精确 token 口径**：区分未命中输入、缓存读取、缓存写入、输出四类 token。
- **按模型计价**：路由取自 `request/header` 或 `assistant/message` 的 source，所以每个模型单独一行计价。
- **时间窗口**：今天 / 本周 / 本月 / 全部，默认今天，每 15 秒自动刷新。
- **可视化改价**：面板内增删改模型单价，写入 `DSH_HOME/znb-billing.json`，重启后保留。
- **删除会话不丢账**：用量按天存进 `DSH_HOME/znb-billing-ledger.json`，删掉会话历史花费仍然保留。

## 计价口径

与 DSH 内置用量面板一致：

```
费用 = 未命中输入 / 1M × 输入单价
     + 缓存读取   / 1M × 缓存读取单价
     + 缓存写入   / 1M × 缓存写入单价
     + 输出       / 1M × 输出单价
```

单价单位是**每百万 token**（CNY）。统计时若某次请求的 usage 不完整（缺字段或数值非法），
该次请求不计入，而不是猜一个值。

### Znb 的默认单价

Znb **不分峰谷**，全天单一价，缓存写入不收费：

| 项目 | 单价（¥ / 1M tokens） |
|---|---|
| 输入（未命中缓存） | **0.30** |
| 输出 | **1.20** |
| 缓存读取 | **0.006**（输入价的 2%） |
| 缓存写入 | **0**（不收费） |

这几个值是 `cordis.patch.yml` 里的默认价目，只用于首次运行。之后以面板里改过的为准，
存在 `DSH_HOME/znb-billing.json`。

> 早期版本支持 DeepSeek 官方的「峰时 / 谷时」两档单价。Znb 是单一价，
> 那套分峰谷逻辑已经整块移除，旧配置里的 `peak` / `offpeak` 字段会被忽略。

## 界面位置

- **侧边栏底部图标**：钱包图标「Znb 计费」，点击打开全屏面板。
- **主面板**：顶部时间窗口切换 + 五张汇总卡 + 按模型明细表 + 单价编辑区。
- **明细表**里每个模型会显示它当前用的输入 / 输出单价，方便核对。

## 配置

`cordis.patch.yml` 里的 `config` 只作为**首次运行的默认值**；面板里改过的价格以
`DSH_HOME/znb-billing.json` 为准。

| 字段 | 默认 | 说明 |
|---|---|---|
| `currency` | `¥` | 金额符号 |
| `models` | 见下 | 首次运行的默认价目表 |

价目记录只支持一种写法（平铺，全天同价）：

```yaml
models:
  - id: 'deepseek-v4.1-flash'
    label: 'DeepSeek V4.1 Flash'
    inputPerMillion: 0.3
    outputPerMillion: 1.2
    cacheReadPerMillion: 0.006
    cacheWritePerMillion: 0
```

`cacheWritePerMillion` 可以省略，省略时按 0 计。

## 架构

```
dsh-plugin-jersey-billing/
├── package.json          # dsh.bundle.patch + dsh.client.platform=web
├── cordis.patch.yml      # bundle patch：插入 znb-billing 一行
├── build.mjs             # 把 src/index.js 同步到 lib/index.js（带自检）
├── lib/
│   ├── index.js          # Host 半边：聚合用量 + 价目持久化 + HTTP 路由
│   └── client.js         # 浏览器半边：预构建 __ModuleLoader__ bundle（面板 UI）
└── src/
    └── index.js          # Host 半边源码
```

包名保持 `dsh-plugin-jersey-billing` 没改（改包名要连带改 GitHub 仓库与所有安装路径，
不值得）。**插件在 DSH 里的显示名、cordis id、路由前缀、数据文件全部是 `znb-billing`。**

`lib/index.js` 是 `src/index.js` 的完整副本 —— `package.json` 的 `files` 只分发 `lib/`，
安装后没有 `src/`。改完 `src/` 后必须重新构建：

```powershell
node build.mjs
```

### 两半边如何通信

Host 半边通过 `ctx.webServer.register()` 注册一条 `prefix /znb-billing` 路由，
浏览器半边用 `fetch()` 取数。**没有**使用 `ctx.remote.<namespace>`，因为那需要生成式
Typert Remote 产物（`typert.host.js` / `typert.remote-client.js`），对本插件过重。

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/znb-billing/summary?window=today` | 按窗口聚合统计 |
| `GET` | `/znb-billing/prices` | 读取价目表 |
| `POST` | `/znb-billing/prices` | 写入一条价目 |
| `POST` | `/znb-billing/prices/delete` | 删除一条价目 |

### 为什么没有额度卡

泽西那套 [OI] 兼容 billing 端点（`/v1/dashboard/billing/subscription`、
`/v1/dashboard/billing/usage`）在 Znb 上**不存在**，实测返回 404：

```
GET https://znbcode.com/v1/dashboard/billing/subscription  → 404 page not found
GET https://znbcode.com/v1/dashboard/billing/usage         → 404 page not found
```

`/v1/models` 是通的，但没有任何额度查询接口。所以这个版本把额度卡整块移除了 ——
与其显示一个永远报错的卡片，不如不放。

### 计费账本

会话日志会被用户删除（DSH 的会话管理里删掉就没了），而中转站后台的账单不会跟着消失。
如果只读磁盘日志，删一个会话，那部分计费就从面板上凭空蒸发，永远对不上账。

所以每个会话的折叠结果按**北京日期**存进账本：

```
{ version, sessions: { <sessionId>: { seenAt, days: { <YYYY-MM-DD>: { <桶键>: 桶 } } } } }
```

- 每次聚合前先刷新账本，**日志是权威**（同一天的桶直接覆盖，日志只会变多不会变少）；
- 聚合**只从账本读数**，所以日志被删的会话在账本里原样保留；
- 账本存的是按天聚合后的桶，不是原始事件 —— 跑一年也就几百 KB。

### 为什么不用 ctx.storageDomain

`ctx.storageDomain.open(spec)` 需要 `defineDomain` / `domainTable`（来自
`@deepseek-ai/dsh-storage-domain`）和 `zod`。这两个包只存在于 `app.asar` 内，
已安装插件从 profile 目录**解析不到**它们。价目表和账本都是很小的纯数据，直接写
`DSH_HOME/` 下的 JSON 文件（临时文件 + rename 原子替换）更稳。

### 浏览器半边的约束

`lib/client.js` 不是普通 ES 模块，而是手写的 `window.__ModuleLoader__.load({id, factory})`
工厂式 CJS bundle。`require` 只能取平台种子表里的模块：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

bundle 的 `id` 必须等于包名 `dsh-plugin-jersey-billing`。

## 安装

```powershell
# 1. 安装（在 profile 目录执行）
node <pnpm.mjs> add "file:E:\\工作文件夹\\DSH插件\\dsh-plugin-jersey-billing"

# 2. 启用 bundle（也可用 plugin_manager 工具或 Web 插件页）
#    plugin_manager action=set_bundle target=dsh-plugin-jersey-billing enabled=true
```

## 数据来源与实测结论

插件**直接扫描磁盘日志**：`DSH_HOME/sessions/<工作区编码>/<session-id>/session.v4.jsonl.zstd`，
逐帧解压后提取用量与路由。

### 关键：会话日志是多帧 zstd

单个日志文件是**多个 zstd 帧顺序追加**的（实测一个 844KB 的文件里有 **852 帧**）。
`zlib.zstdDecompressSync(buffer)` 一次**只解第一帧** —— 那唯一一行是 `session` 头，
所以会误以为「日志里没有用量」。

必须按 zstd 魔数 `28 b5 2f fd` 切分，逐帧解压：

```js
const offsets = []
let cursor = 0
while (cursor < buffer.length) {
  const at = buffer.indexOf(ZSTD_MAGIC, cursor)
  if (at === -1) break
  offsets.push(at)
  cursor = at + ZSTD_MAGIC.length
}
offsets.push(buffer.length)
```

### 为什么不用 ctx.sessionQuery.readSession()

它会对每个会话做**完整 replay 校验**。97 个会话实测**超过 90 秒直接超时**，
面板永远停在「正在统计…」。直接读磁盘只要 **0.3 秒**。

| 方式 | 97 个会话耗时 |
|---|---|
| `sessionQuery.readSession()` 串行 | **>90 秒（超时）** |
| `sessionQuery.readSession()` 8 并发 | ~0.8 秒 |
| **直接多帧解压磁盘日志** | **~0.3 秒** |

### 事件形状

- 用量在 **`assistant/message.data.usage`**：
  `{ inputTokens, outputTokens, totalTokens, cacheReadTokens?, cacheWriteTokens? }`
- 也兼容 `assistant/attempt.data.stream` 里的 `{ type: 'chunk', chunk: { type: 'usage', usage } }`
- 路由（provider/model）有两个来源：
  - `request/header.data.header.config`（正常会话）
  - `assistant/message.data.message.source`（导入型日志，如 `codex-sync`）

### 浏览器半边最大的坑（已修复）

jsx-runtime 的签名是 **`jsx(type, props, key)`** —— children 必须写在 `props` 里，
**第三位是 key，不是子节点**。写成 `jsx(type, props, child1, child2)` 会把子节点
**静默丢弃**，渲染成一片空白（图标正常、面板全空）。所有元素构造必须用
`{ children: ... }` 形式。

## 已知限制

- **改代码后必须重启 DSH 进程**。profile 是 `patchReload: live`，但那只重载配置；
  **替换包代码需要重启进程**才能加载新的 JavaScript 模块代。
- **路由不在 `/api` 前缀下**，因此不走 `dsh-client-connection` 的 Host/Origin 信任栅栏。
  统计与改价都只在本机回环地址上暴露；若把 webserver 绑到 `0.0.0.0`，这条路由会一并暴露。
- **`request/header` 是「最近一次生效」语义**：它只在请求头变化时写入，所以一次
  请求归属的模型是当时生效的那个。中途切模型会正确分到不同桶。
- **统计的是本地日志，不是服务端账单**：日志被清理、或某次请求未落盘时会偏少。
- **只统计日志里有 usage 的请求**：导入型会话（如 `codex-sync`）没有 usage，
  会计为 0 而不是估算。
- **活跃会话的最后一批事件可能尚未落盘**：DSH 按批追加帧，正在进行的对话
  最新几条可能还没写进文件。
- **没有额度查询**：Znb 不提供 billing 接口（见上文），面板显示不了剩余额度。
