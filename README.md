# 泽西计费统计插件

按模型单价与实时用量统计 DSH **全部会话**在泽西 API 中转站的花费，支持
**今天 / 本周 / 本月 / 全部** 四个时间窗口切换，单价可在面板内直接编辑并持久化。

> **同事安装请看 [INSTALL.md](INSTALL.md)** —— 那里只有安装和使用的步骤。

## 功能

- **全会话统计**：扫描 `DSH_HOME/sessions` 下所有会话日志，不限于当前会话。
- **精确 token 口径**：区分未命中输入、缓存读取、缓存写入、输出四类 token。
- **按模型计价**：路由取自 `request/header` 或 `assistant/message` 的 source，
  所以每个模型单独一行计价。
- **时间窗口**：今天 / 本周 / 本月 / 全部，默认今天，每 15 秒自动刷新。
- **可视化改价**：面板内增删改模型单价，写入 `DSH_HOME/jersey-billing.json`，重启后保留。
- **未配置单价提示**：没有单价的模型会回退到 `defaultModel` 的单价，并在面板顶部列出。

## 计价口径

与 DSH 内置用量面板一致：

```
费用 = 未命中输入 / 1M × 输入单价
     + 缓存读取   / 1M × 缓存读取单价
     + 缓存写入   / 1M × 缓存写入单价（未单独配置时回退输入单价）
     + 输出       / 1M × 输出单价
```

单价单位是**每百万 token**（CNY）。统计时若某次请求的 usage 不完整（缺字段或数值非法），
该次请求不计入，而不是猜一个值。

## 界面位置

- **侧边栏底部图标**：钱包图标，点击打开全屏面板。
- **主面板**：顶部时间窗口切换 + 五张汇总卡 + 按模型明细表 + 单价编辑区。

## 配置

`cordis.patch.yml` 里的 `config` 只作为**首次运行的默认值**；面板里改过的价格以
`DSH_HOME/jersey-billing.json` 为准。

| 字段 | 默认 | 说明 |
|---|---|---|
| `currency` | `¥` | 金额符号 |
| `cacheWriteAsRead` | `false` | 为 `true` 时缓存写入按缓存读取单价计 |
| `defaultModel` | `deepseek-v4.1-flash` | 没有单独配置单价的模型回退到它 |
| `models` | 见下 | 首次运行的默认价目表 |

```yaml
- id: jersey-billing
  name: 'dsh-plugin-jersey-billing'
  config:
    currency: '¥'
    cacheWriteAsRead: false
    defaultModel: 'deepseek-v4.1-flash'
    models:
      - id: 'deepseek-v4.1-flash'
        label: 'DeepSeek V4.1 Flash'
        inputPerMillion: 0
        outputPerMillion: 0
        cacheReadPerMillion: 0
```

## 架构

```
dsh-plugin-jersey-billing/
├── package.json          # dsh.bundle.patch + dsh.client.platform=web
├── cordis.patch.yml      # bundle patch：插入 jersey-billing 一行
├── lib/
│   ├── index.js          # Host 半边：聚合用量 + 价目持久化 + HTTP 路由
│   └── client.js         # 浏览器半边：预构建 __ModuleLoader__ bundle（面板 UI）
└── src/
    └── index.js          # Host 半边源码（与 lib/index.js 逐字节一致）
```

### 两半边如何通信

Host 半边通过 `ctx.webServer.register()` 注册一条 `prefix /jersey-billing` 路由，
浏览器半边用 `fetch()` 取数。**没有**使用 `ctx.remote.<namespace>`，因为那需要生成式
Typert Remote 产物（`typert.host.js` / `typert.remote-client.js`），对本插件过重。

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/jersey-billing/summary?window=today` | 按窗口聚合统计 |
| `GET` | `/jersey-billing/prices` | 读取价目表 |
| `POST` | `/jersey-billing/prices` | 写入一条价目 |
| `POST` | `/jersey-billing/prices/delete` | 删除一条价目 |

### 为什么不用 ctx.storageDomain

`ctx.storageDomain.open(spec)` 需要 `defineDomain` / `domainTable`（来自
`@deepseek-ai/dsh-storage-domain`）和 `zod`。这两个包只存在于 `app.asar` 内，
已安装插件从 profile 目录**解析不到**它们。价目表是很小的纯数据，直接写
`DSH_HOME/jersey-billing.json`（临时文件 + rename 原子替换）更稳。

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

已在 desktop profile 安装并启用：

```powershell
# 1. 安装（在 profile 目录执行）
node <pnpm.mjs> add "file:E:\工作文件夹\DSH插件\dsh-plugin-jersey-billing"

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
// 逐帧 zstdDecompressSync(buffer.subarray(offsets[i], offsets[i+1]))
```

多帧解压后，同一个文件有 **1473 个事件、263 个带 `usage`**。

### 为什么不用 `ctx.sessionQuery.readSession()`

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
- 也兼容 `assistant/attempt.data.stream` 里的
  `{ type: 'chunk', chunk: { type: 'usage', usage } }`
- 路由（provider/model）有两个来源：
  - `request/header.data.header.config`（正常会话）
  - `assistant/message.data.message.source`（导入型日志，如 `codex-sync`）
- 窗口过滤用**文件 mtime 预筛**：mtime 早于窗口起点就整个跳过，不解压。

### 浏览器半边最大的坑（已修复）

jsx-runtime 的签名是 **`jsx(type, props, key)`** —— children 必须写在 `props` 里，
**第三位是 key，不是子节点**。写成 `jsx(type, props, child1, child2)` 会把子节点
**静默丢弃**，渲染成一片空白（图标正常、面板全空）。所有元素构造必须用
`{ children: ... }` 形式。

## 已知限制

- **改代码后必须重启 DSH 进程**。profile 是 `patchReload: live`，但那只重载配置；
  **替换包代码需要重启进程**才能加载新的 JavaScript 模块代。改动后若报错行号与
  磁盘文件对不上，就是进程还在跑旧模块。
- **路由不在 `/api` 前缀下**，因此不走 `dsh-client-connection` 的 Host/Origin 信任栅栏。
  统计与改价都只在本机回环地址上暴露；若把 webserver 绑到 `0.0.0.0`，这条路由会一并暴露。
- **`request/header` 是「最近一次生效」语义**：它只在请求头变化时写入，所以一次
  请求归属的模型是当时生效的那个。中途切模型会正确分到不同桶。
- **统计的是本地日志，不是服务端账单**：日志被清理、或某次请求未落盘时会偏少。
  要「以泽西服务端账单为准」需要调泽西的账单 API，本插件不做这件事。
- **只统计日志里有 usage 的请求**：导入型会话（如 `codex-sync`）没有 usage，
  会计为 0 而不是估算。
- **活跃会话的最后一批事件可能尚未落盘**：DSH 按批追加帧，正在进行的对话
  最新几条可能还没写进文件。
