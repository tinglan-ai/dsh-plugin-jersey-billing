# API 中转站计费统计插件

按模型单价与实时用量统计 DSH **全部会话**在指定 API 中转站上的花费，支持
**今天 / 本周 / 本月 / 全部** 四个时间窗口切换，单价可在面板内直接编辑并持久化。

> **同事安装请看 [INSTALL.md](INSTALL.md)** —— 那里只有安装和使用的步骤。

## 统计范围：一个 provider，可配置

插件只统计 **一个 provider**，由 `cordis.patch.yml` 里的 `config.provider` 决定：

```yaml
config:
  provider: 'itkk'   # ← 只统计这一个
```

当前配置：

| provider | 是否统计 | 说明 |
|---|---|---|
| `itkk` | **统计** | 走 `https://itkk.lol/v1`，插件唯一统计对象 |
| 其他所有 provider | 不统计 | 泽西、Znb、官方账号、别的中转站，一律不计 |

这条规则写死在 Host 半边，面板上没有开关。**换统计对象只改 `provider` 这一行，不用改代码，
也不用换数据文件。** 换过几次都是这样改的：

| 时期 | provider |
|---|---|
| 2026-10 之前 | `zexitongxue`（泽西） |
| 2026-10-23 ~ 10-28 | `znb-gongsi`（Znb） |
| 2026-10-23 起 | `itkk` |

同理，**没有配置单价的模型也整条跳过**，不会回退到别的模型的价格去估算。

## 功能

- **全会话统计**：扫描 `DSH_HOME/sessions` 下所有会话日志，不限于当前会话。
- **精确 token 口径**：区分未命中输入、缓存读取、缓存写入、输出四类 token。
- **按模型计价**：路由取自 `request/header` 或 `assistant/message` 的 source，每个模型单独一行。
- **时间窗口**：今天 / 本周 / 本月 / 全部，默认今天，每 15 秒自动刷新。
- **可视化改价**：面板内增删改模型单价，写入 `DSH_HOME/billing-prices.json`，重启后保留。
- **删除会话不丢账**：用量按天存进 `DSH_HOME/billing-ledger.json`，删掉会话历史花费仍然保留。

## 计价口径

与 DSH 内置用量面板一致：

```
费用 = 未命中输入 / 1M × 输入单价
     + 缓存读取   / 1M × 缓存读取单价
     + 缓存写入   / 1M × 缓存写入单价
     + 输出       / 1M × 输出单价
```

单价单位是**每百万 token**（CNY）。若某次请求的 usage 不完整（缺字段或数值非法），
该次请求不计入，而不是猜一个值。

### 当前单价（itkk / deepseek-v4.1-flash-1017）

| 项目 | 单价（¥ / 1M tokens） |
|---|---|
| 输入（未命中缓存） | **0.1** |
| 输出 | **0.4** |
| 缓存读取 | **0.002** |
| 缓存写入 | **0**（不收费） |

这几个值是 `cordis.patch.yml` 里的默认价目，只用于首次运行。之后以面板里改过的为准，
存在 `DSH_HOME/billing-prices.json`。

> 早期版本支持过 DeepSeek 官方的「峰时 / 谷时」两档单价，那套逻辑已整块移除；
> 旧配置里的 `peak` / `offpeak` 字段会被忽略。

## 界面位置

- **侧边栏底部图标**：「计费统计」，点击打开全屏面板。
- **面板标题**：`<provider> 计费统计`，副标题写明「仅统计谁」。
- **主面板**：时间窗口切换 + 五张汇总卡 + 按模型明细表 + 单价编辑区。
- **明细表**里每个模型会显示它当前用的输入 / 输出单价，方便核对。

## 配置

`cordis.patch.yml` 里的 `config` 只作为**首次运行的默认值**；面板里改过的价格以
`DSH_HOME/billing-prices.json` 为准。

| 字段 | 默认 | 说明 |
|---|---|---|
| `provider` | `itkk` | 唯一计入统计的 provider id |
| `currency` | `¥` | 金额符号 |
| `models` | 见下 | 首次运行的默认价目表 |

价目记录只支持一种写法（平铺，全天同价）：

```yaml
models:
  - id: 'deepseek-v4.1-flash-1017'
    label: 'DeepSeek V4.1 Flash 1017'
    inputPerMillion: 0.1
    outputPerMillion: 0.4
    cacheReadPerMillion: 0.002
    cacheWritePerMillion: 0
```

`cacheWritePerMillion` 可以省略，省略时按 0 计。

## 换统计对象怎么做

1. 改 `cordis.patch.yml` 里 `config.provider` 成新 provider id（要和日志里
   `request/header.data.header.config.provider` 的值完全一致）；
2. 把 `config.models` 换成新站点的模型与单价；
3. `node build.mjs` 重新构建 `lib/index.js`；
4. 重新安装到 profile（见 INSTALL.md），重启 DSH。

数据文件不用改名 —— 账本只存当前 provider 的桶，换 provider 后账本会自然重建。

## 架构

```
dsh-plugin-jersey-billing/
├── package.json          # dsh.bundle.patch + dsh.client.platform=web
├── cordis.patch.yml      # bundle patch：插入 llm-billing 一行 + 价目
├── build.mjs             # 把 src/index.js 同步到 lib/index.js（带自检）
├── lib/
│   ├── index.js          # Host 半边：聚合用量 + 价目持久化 + HTTP 路由
│   └── client.js         # 浏览器半边：预构建 __ModuleLoader__ bundle（面板 UI）
└── src/
    └── index.js          # Host 半边源码
```

包名保持 `dsh-plugin-jersey-billing` 没改（改包名要连带改 GitHub 仓库与所有安装路径，
不值得）。插件在 DSH 里的 cordis id、路由前缀是 `llm-billing`，与具体中转站无关。

`lib/index.js` 是 `src/index.js` 的完整副本 —— `package.json` 的 `files` 只分发 `lib/`，
安装后没有 `src/`。改完 `src/` 后必须重新构建：

```powershell
node build.mjs
```

### 两半边如何通信

Host 半边通过 `ctx.webServer.register()` 注册一条 `prefix /llm-billing` 路由，
浏览器半边用 `fetch()` 取数。**没有**使用 `ctx.remote.<namespace>`，因为那需要生成式
Typert Remote 产物（`typert.host.js` / `typert.remote-client.js`），对本插件过重。

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/llm-billing/summary?window=today` | 按窗口聚合统计 |
| `GET` | `/llm-billing/prices` | 读取价目表 |
| `POST` | `/llm-billing/prices` | 写入一条价目 |
| `POST` | `/llm-billing/prices/delete` | 删除一条价目 |

### 没有额度卡

OpenAI 旧版 billing 端点（`/v1/dashboard/billing/subscription`、`/usage`）在中转站上
普遍不完整 —— 泽西实现了但单位混乱（元 vs 分），Znb 直接 404。所以面板不显示剩余额度，
只统计花费。

### 计费账本

会话日志会被用户删除（DSH 的会话管理里删掉就没了），而中转站后台的账单不会跟着消失。
如果只读磁盘日志，删一个会话，那部分计费就从面板上凭空蒸发，永远对不上账。

所以每个会话的折叠结果按**北京日期**存进账本：

```
{ version, sessions: { <sessionId>: { seenAt, days: { <YYYY-MM-DD>: { <桶键>: 桶 } } } } }
```

- 每次聚合前先刷新账本，**日志是权威**（同一天的桶直接覆盖，日志只会变多不会变少）；
- 聚合**只从账本读数**，所以日志被删的会话在账本里原样保留；
- 折叠时只保留 `config.provider` 的桶，账本里不会堆永远不统计的数据。

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

# 2. 确认 profile 的 package.json bundles 里有 dsh-plugin-jersey-billing
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
