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

### 峰谷分时计价

DeepSeek 系列**不是全天同价**，而是按北京时间分峰谷：

| 时段 | 输入基准价 | 输出基准价 | 说明 |
|---|---|---|---|
| **峰时** | 0.1 | 0.4 | 工作日 09:00–12:00、14:00–18:00 |
| **谷时** | 0.05 | 0.2 | 其余全部时间 |

谷时的判定规则（按优先级）：

1. **法定节假日**全天按谷时（含调休连休的那几天）
2. **周末**全天按谷时 —— 但**调休上班的周末例外**，按工作日走峰谷
3. 工作日按上面的时段表判峰谷

缓存命中价**跟随峰谷**，一般取输入价的 2%。

插件内置了 **2025 / 2026 两年**的国务院调休日历（`src/peak.js`）。
跨年后需要补一份新表；日历没覆盖到的年份，面板会给出提示。

## 界面位置

- **侧边栏底部图标**：钱包图标，点击打开全屏面板。
- **主面板**：顶部时间窗口切换 + 额度卡 + 五张汇总卡 + 按模型明细表 + 单价编辑区。
- **明细表**里每个模型会显示「峰 N 次 ¥x / 谷 N 次 ¥y」的拆分。

## 配置

`cordis.patch.yml` 里的 `config` 只作为**首次运行的默认值**；面板里改过的价格以
`DSH_HOME/jersey-billing.json` 为准。

| 字段 | 默认 | 说明 |
|---|---|---|
| `currency` | `¥` | 金额符号 |
| `cacheWriteAsRead` | `false` | 为 `true` 时缓存写入按缓存读取单价计 |
| `defaultModel` | `deepseek-v4.1-flash` | 没有单独配置单价的模型回退到它 |
| `models` | 见下 | 首次运行的默认价目表 |

价目记录支持两种写法，可以混用：

```yaml
# 写法一：平铺（不分峰谷，全天同价）
- id: 'some-flat-model'
  inputPerMillion: 0.4
  outputPerMillion: 2.0
  cacheReadPerMillion: 0.02

# 写法二：分峰谷
- id: 'deepseek-v4.1-flash'
  label: 'DeepSeek V4.1 Flash'
  peak:
    inputPerMillion: 0.825
    outputPerMillion: 3.3
    cacheReadPerMillion: 0.0165
  offpeak:
    inputPerMillion: 0.4125
    outputPerMillion: 1.65
    cacheReadPerMillion: 0.00825
```

分峰谷时若某一档缺字段，会先回退到另一档，再回退到平铺字段。

## 单价怎么填（重要）

**填「已含倍率」的最终单价，不要填基准价。**

泽西后台每条记录会标一个倍率（例如「精选模型 **8.25x**」）。面板需要的是
**基准价 × 倍率**之后的结果。峰谷两档都要各自乘倍率。

以 8.25x 倍率为例：

| 项目 | 谷时基准价 | 谷时应填 | 峰时基准价 | 峰时应填 |
|---|---|---|---|---|
| 输入 / 1M | 0.05 | **0.4125** | 0.1 | **0.825** |
| 输出 / 1M | 0.2 | **1.65** | 0.4 | **3.3** |
| 缓存输入 / 1M | 0.001 | **0.00825** | 0.002 | **0.0165** |

### 怎么自查填得对不对

用面板的「今天」数字和泽西后台同期的「用量」对一下：

```
面板总花费 ≈ 后台用量金额
```

**注意后台「Tokens」列显示的是「总输入 / 输出」，而「缓存↓」是其中命中缓存的部分。**
未命中输入 = 总输入 − 缓存读取。插件内部用的 `inputTokens` 已经是未命中输入，
口径与这个公式一致。

实测校准（10-08 工作日，8.25x 倍率，取后台 9 条记录）：

| 时间 | 总输入 | 缓存↓ | 输出 | 后台费用 | 插件算出 | 档 |
|---|---|---|---|---|---|---|
| 08:59:15 | 100582 | 98646 | 247 | 0.00202 | 0.002020 | 谷 |
| 09:00:35 | 102718 | 102286 | 109 | 0.001202 | 0.001202 | 谷 |
| 09:00:57 | 103667 | 102588 | 284 | 0.00352 | 0.003520 | 峰 |
| 09:01:15 | 104062 | 103538 | 260 | 0.002998 | 0.002999 | 峰 |
| 09:01:45 | 161131 | 0 | 519 | 0.134646 | 0.134646 | 峰 |

9 条全部吻合到小数点后 6 位。注意后台的峰谷切换点比整点略晚几十秒
（09:00:04 / 09:00:09 / 09:00:35 三条仍按谷价），插件按整点判定。

### 最可靠的对账法：实时增量对比

后台那个「用量」汇总数字**不一定只统计你选的那个区间**，容易误导。更可靠的做法是
比**增量**：记下当前时刻，用一段时间之后再比。

泽西暴露了 OpenAI 旧版 billing 端点，可以直接读到账号累计用量（单位是**分**）：

```
GET https://zexitongxue.com/v1/dashboard/billing/usage
Authorization: Bearer <你的 key>
→ {"object":"list","total_usage":109532.9986}
```

**这个端点会忽略 `start_date` / `end_date` 参数**，返回的永远是账号历史累计值，
所以它不能用来查「某天花了多少」。但**取两次的差值**就得到这段时间的真实消耗：

```
本段消耗(元) = (total_usage_后 − total_usage_前) / 100
```

拿它和面板的增量对一下。实测 90 秒窗口：

| | 请求数 | 金额 |
|---|---|---|
| 面板（本地日志） | 2 | ¥0.006243 |
| 泽西后台（API 差值） | — | ¥0.006242 |

**比值 1.000，误差在百万分之一元量级。**

另一个佐证：把后台日志列表和本地日志按时间戳逐条对齐，9 条记录一一对应，
后台时间戳固定比本地晚 1–2 秒（后台记的是请求**完成**时刻，本地记的是**开始**时刻）。

### 后台「用量」和面板对不上时

先排除这三件事，再怀疑插件：

1. **区间不同**：后台默认给的是 `00:00 ~ 23:59` 全天，而面板「今天」只统计到当前时刻。
   截图时后台是全天数字、面板是半天数字，天然对不上。
2. **后台汇总可能忽略日期筛选**：和上面那个 API 一样，改日期只影响下面的日志列表，
   不影响顶部的「用量」。想验证就把日期改成一个你肯定没用过的区间（比如上个月某两天），
   如果「用量」还是个差不多的数，就说明它没按区间过滤。
3. **面板只读本机日志**：`DSH_HOME/sessions` 被清理过的会话无法恢复。
   如果别的设备/客户端也在用同一个 key，后台会算进去而面板不会。

## 架构

```
dsh-plugin-jersey-billing/
├── package.json          # dsh.bundle.patch + dsh.client.platform=web
├── cordis.patch.yml      # bundle patch：插入 jersey-billing 一行
├── lib/
│   ├── index.js          # Host 半边：聚合用量 + 价目持久化 + HTTP 路由
│   └── client.js         # 浏览器半边：预构建 __ModuleLoader__ bundle（面板 UI）
└── src/
    ├── index.js          # Host 半边源码
    └── peak.js           # 峰谷时段判定 + 节假日/调休日历
```

**注意 `lib/index.js` 是构建产物**：`package.json` 的 `files` 只分发 `lib/`，
所以 `src/peak.js` 会被**内联**进 `lib/index.js`。改完 `src/` 后必须重新构建：

```powershell
node build.mjs   # 或手工把 peak.js 去掉 export 后内联，见文件内注释
```

### 两半边如何通信

Host 半边通过 `ctx.webServer.register()` 注册一条 `prefix /jersey-billing` 路由，
浏览器半边用 `fetch()` 取数。**没有**使用 `ctx.remote.<namespace>`，因为那需要生成式
Typert Remote 产物（`typert.host.js` / `typert.remote-client.js`），对本插件过重。

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/jersey-billing/summary?window=today&scope=jersey` | 按窗口聚合统计 |
| `GET` | `/jersey-billing/balance?force=1` | 查泽西后台剩余额度 |
| `GET` | `/jersey-billing/prices` | 读取价目表 |
| `POST` | `/jersey-billing/prices` | 写入一条价目 |
| `POST` | `/jersey-billing/prices/delete` | 删除一条价目 |

`scope` 取 `jersey`（默认，只统计 `zexitongxue`）或 `all`（全部 provider）。

### 额度卡

`GET /jersey-billing/balance` 会去调泽西的 OpenAI 兼容 billing 端点：

```
GET https://zexitongxue.com/v1/dashboard/billing/subscription  → { hard_limit_usd }  总额度（元）
GET https://zexitongxue.com/v1/dashboard/billing/usage         → { total_usage }      已用（分）
```

**两者单位不一致**（OpenAI 旧接口的历史遗留，泽西照抄了）：`hard_limit_usd` 是元，
`total_usage` 是**分**。所以 `剩余 = hard_limit_usd - total_usage / 100`。

泽西只暴露这两个**只读**端点，没有充值/改额度接口，插件不能自动充值。
结果缓存 60 秒（失败也缓存），避免中转站挂掉时面板狂重试。

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
