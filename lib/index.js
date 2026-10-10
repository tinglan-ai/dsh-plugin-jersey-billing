/**
 * 泽西计费统计插件 —— Host 半边。
 *
 * 职责：
 *  1. 读取 DSH_HOME/sessions 下**全部会话**的日志；
 *  2. 从 `assistant/message.data.usage` 取出精确 token 用量
 *     （inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens）；
 *  3. 从 `request/header` 或 `assistant/message.data.message.source`
 *     取出该次请求实际使用的 provider / model；
 *  4. 按面板配置的单价（每百万 token）算出花费；
 *  5. 把价目表持久化到 DSH_HOME/jersey-billing.json；
 *  6. 通过 `ctx.webServer` 注册一条只读 JSON 路由，供浏览器半边取数。
 *
 * 为什么直接读磁盘而不用 `ctx.sessionQuery.readSession()`：
 * 会话日志是 **多个 zstd 帧顺序追加**的（实测单个文件 852 帧），
 * `readSession()` 会对每个会话做完整 replay 校验，97 个会话会超时（>90s）。
 * 直接多帧解压全部日志只需约 0.3 秒。
 *
 * 计价口径（与 DSH 内置用量面板一致）：
 *   总输入 = inputTokens(未命中缓存) + cacheReadTokens + cacheWriteTokens
 *   费用   = 未命中输入/1M × 输入单价
 *          + 缓存读取/1M × 缓存读取单价
 *          + 缓存写入/1M × 缓存写入单价（缺省回退输入单价）
 *          + 输出/1M × 输出单价
 *
 * @module dsh-plugin-jersey-billing
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// ── 以下为 src/peak.js 的内联副本（安装包只分发 lib/，故必须内联）──
// 勿手工编辑这一段；改 src/peak.js 后重新跑 node build.mjs。
/**
 * 峰谷时段判定 —— DeepSeek 系列模型的错峰计价日历。
 *
 * 规则（北京时间 UTC+8）：
 *  - 峰时（标准价）：工作日 09:00–12:00、14:00–18:00
 *  - 谷时（空闲价）：其余全部时间
 *  - 周末全天按谷时
 *  - 法定节假日全天按谷时
 *  - **调休上班的周末按峰时**（国务院办公厅每年发布调休安排）
 *
 * 为什么把日历硬编码进代码：
 * 调休安排由国务院办公厅在**前一年 11 月左右**发布，一年一份，无法推算。
 * 因此这里内置 2025 / 2026 两年的完整安排，跨年后需要补一份新表。
 * 表里只列「放假的日期」和「调休上班的周末」，其余按常规周末规则判定。
 *
 * @module dsh-plugin-jersey-billing/peak
 */

/** 北京时间相对 UTC 的偏移（分钟）。 */
const BEIJING_OFFSET_MINUTES = 8 * 60

/** 峰时区间（北京时间，小时；左闭右开）。 */
const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

/**
 * 法定节假日（含调休连休）——这些日期全天按谷时计费。
 * 键为 `YYYY-MM-DD`。
 */
const HOLIDAYS = new Set([
  // ── 2025 ────────────────────────────────────────────────────────────
  // 元旦
  '2025-01-01',
  // 春节（1/28 除夕 ~ 2/4）
  '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31',
  '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
  // 清明（4/4 ~ 4/6）
  '2025-04-04', '2025-04-05', '2025-04-06',
  // 劳动节（5/1 ~ 5/5）
  '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
  // 端午（5/31 ~ 6/2）
  '2025-05-31', '2025-06-01', '2025-06-02',
  // 国庆 + 中秋（10/1 ~ 10/8）
  '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04',
  '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',

  // ── 2026 ────────────────────────────────────────────────────────────
  // 元旦（1/1 ~ 1/3）
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节（2/15 除夕 ~ 2/22）
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18',
  '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  // 清明（4/4 ~ 4/6）
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动节（5/1 ~ 5/5）
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午（6/19 ~ 6/21）
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋（9/25 ~ 9/27）
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆（10/1 ~ 10/7）
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

/**
 * 调休上班的周末 —— 这些日期虽然是周六/周日，但按工作日（峰谷规则）计费。
 * 键为 `YYYY-MM-DD`。
 */
const MAKEUP_WORKDAYS = new Set([
  // ── 2025 ────────────────────────────────────────────────────────────
  '2025-01-26', // 春节前调休（周日）
  '2025-02-08', // 春节后调休（周六）
  '2025-04-27', // 劳动节前调休（周日）
  '2025-09-28', // 国庆前调休（周日）
  '2025-10-11', // 国庆后调休（周六）

  // ── 2026 ────────────────────────────────────────────────────────────
  '2026-02-14', // 春节前调休（周六）
  '2026-02-28', // 春节后调休（周六）
  '2026-05-09', // 劳动节后调休（周六）
  '2026-09-19', // 中秋前调休（周六）
  '2026-10-10', // 国庆后调休（周六）
])

/** 把毫秒时间戳转成北京时间的日期部件。 */
function beijingParts(timeMs) {
  const shifted = new Date(timeMs + BEIJING_OFFSET_MINUTES * 60_000)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    // getUTCDay(): 0=周日 … 6=周六
    weekday: shifted.getUTCDay(),
  }
}

/** 补零成两位。 */
function pad2(value) {
  return value < 10 ? `0${value}` : String(value)
}

/** 拼出 `YYYY-MM-DD`。 */
function dateKey(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

/**
 * 判断某个时刻是否处于峰时（标准价）。
 *
 * @param timeMs - 事件毫秒时间戳（UTC 基准，本地时区无关）。
 * @returns 峰时返回 true，谷时返回 false。
 */
function isPeakTime(timeMs) {
  if (!Number.isFinite(timeMs)) return false
  const parts = beijingParts(timeMs)
  const key = dateKey(parts)

  // 法定节假日：全天谷时。
  if (HOLIDAYS.has(key)) return false

  const isWeekend = parts.weekday === 0 || parts.weekday === 6
  // 调休上班的周末：按工作日走峰谷。
  if (isWeekend && !MAKEUP_WORKDAYS.has(key)) return false

  for (const [from, to] of PEAK_HOURS) {
    if (parts.hour >= from && parts.hour < to) return true
  }
  return false
}

/** 峰谷标签，供面板显示。 */
const PEAK_LABEL = '峰时'
const OFF_PEAK_LABEL = '谷时'

/** 日历覆盖的年份范围（用于面板提示「日历已过期」）。 */
const CALENDAR_YEARS = [2025, 2026]

/** 日历是否覆盖某个时刻。 */
function isCalendarCovered(timeMs) {
  return CALENDAR_YEARS.includes(beijingParts(timeMs).year)
}

/** 统计窗口：今天 / 本周 / 本月 / 全部。 */
const WINDOWS = ['today', 'week', 'month', 'all']

/** 每百万 token 的换算基数。 */
const PER_MILLION = 1_000_000

/** 浏览器半边取数的路由前缀。 */
const ROUTE_PATH = '/jersey-billing'

/** 泽西中转站的 provider id（面板默认只统计它）。 */
const JERSEY_PROVIDER = 'zexitongxue'

/** 泽西余额查询：baseURL 与 OpenAI 兼容的 billing 端点。 */
const JERSEY_BASE_URL = 'https://zexitongxue.com'
const BILLING_SUBSCRIPTION = '/v1/dashboard/billing/subscription'
const BILLING_USAGE = '/v1/dashboard/billing/usage'

/** 余额缓存时长：避免每次刷新都打中转站。 */
const BALANCE_TTL_MS = 60_000

/** 峰时区间（北京时间），仅供面板展示。 */
const PEAK_HOURS_DISPLAY = [
  { from: 9, to: 12 },
  { from: 14, to: 18 },
]

/**
 * 归一化 Loader 传入的 config。
 * 刻意不引入 schemastery / zod：本插件是纯统计，少一个依赖少一处失败点。
 * @param config - 原始 config。
 */
function resolveConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const models = Array.isArray(raw.models) ? raw.models : []
  return {
    currency: typeof raw.currency === 'string' && raw.currency.length > 0 ? raw.currency : '¥',
    cacheWriteAsRead: raw.cacheWriteAsRead === true,
    defaultModel:
      typeof raw.defaultModel === 'string' && raw.defaultModel.length > 0
        ? raw.defaultModel
        : 'deepseek-v4.1-flash',
    models: models
      .filter(
        (model) =>
          model !== null &&
          typeof model === 'object' &&
          typeof model.id === 'string' &&
          model.id.length > 0,
      )
      .map((model) => ({
        id: model.id,
        ...(typeof model.label === 'string' && model.label.length > 0 ? { label: model.label } : {}),
        ...normalizePriceShape(model),
      })),
  }
}

/**
 * 把一条价目记录归一化。
 *
 * 支持两种形状：
 *   平铺：`{ inputPerMillion, outputPerMillion, cacheReadPerMillion }`
 *   分峰谷：`{ peak: {...}, offpeak: {...} }`
 *
 * 两种可以混用：分峰谷时若某一档缺字段，回退到平铺字段（见 `tierPrice`）。
 *
 * @param raw - 原始记录。
 * @returns 归一化后的记录（只含合法字段）。
 */
function normalizePriceShape(raw) {
  const out = {}
  const flat = {
    inputPerMillion: toPrice(raw.inputPerMillion),
    outputPerMillion: toPrice(raw.outputPerMillion),
    cacheReadPerMillion: toPrice(raw.cacheReadPerMillion),
  }
  // 平铺字段只在「确实提供了」时写入，避免把分峰谷记录污染成平铺。
  if (raw.inputPerMillion !== undefined) out.inputPerMillion = flat.inputPerMillion
  if (raw.outputPerMillion !== undefined) out.outputPerMillion = flat.outputPerMillion
  if (raw.cacheReadPerMillion !== undefined) out.cacheReadPerMillion = flat.cacheReadPerMillion
  if (raw.cacheWritePerMillion !== undefined && raw.cacheWritePerMillion !== null) {
    out.cacheWritePerMillion = toPrice(raw.cacheWritePerMillion)
  }
  for (const tier of ['peak', 'offpeak']) {
    const source = raw[tier]
    if (source === null || typeof source !== 'object') continue
    const slot = {}
    if (source.inputPerMillion !== undefined) slot.inputPerMillion = toPrice(source.inputPerMillion)
    if (source.outputPerMillion !== undefined) {
      slot.outputPerMillion = toPrice(source.outputPerMillion)
    }
    if (source.cacheReadPerMillion !== undefined) {
      slot.cacheReadPerMillion = toPrice(source.cacheReadPerMillion)
    }
    if (source.cacheWritePerMillion !== undefined && source.cacheWritePerMillion !== null) {
      slot.cacheWritePerMillion = toPrice(source.cacheWritePerMillion)
    }
    out[tier] = slot
  }
  return out
}

/** 把任意输入转成非负有限价格。 */
function toPrice(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

/** 安全计数：有限非负安全整数。 */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * 从 `assistant/attempt` 事件的 `stream` 取出 usage。
 * stream 是 StreamChunk 数组，`usage` 至多出现一次。
 */
function streamUsage(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (record === null || typeof record !== 'object') continue
    // AssistantStreamRecord 有两种形态：聚合的 text/reasoning/tool-call-chunks，
    // 以及逐块原样保存的 { type: 'chunk', time, chunk }。usage 只在后者里。
    const chunk = record.type === 'chunk' ? record.chunk : record
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') return chunk.usage
  }
  return undefined
}

/** 归一化 usage；任何不完整都返回 undefined（不猜）。 */
function normalizeUsage(usage) {
  if (usage === null || typeof usage !== 'object') return undefined
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheReadTokens ?? 0,
    cacheWriteTokens: cacheWriteTokens ?? 0,
  }
}

/**
 * 窗口起始毫秒（本地时区）。`all` 返回 0。
 * @param window - today | week | month | all
 * @param now - 当前毫秒。
 */
function windowStart(window, now) {
  const date = new Date(now)
  if (window === 'today') {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  }
  if (window === 'week') {
    // 以周一为一周开始。
    const weekday = date.getDay() === 0 ? 7 : date.getDay()
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() - (weekday - 1)).getTime()
  }
  if (window === 'month') {
    return new Date(date.getFullYear(), date.getMonth(), 1).getTime()
  }
  return 0
}

/**
 * 折叠一个会话的事件日志，得到**按北京日期分组**的用量桶。
 *
 * 路由来自 `request/header`（仅在请求头变化时写入，故为「最近一次生效」语义），
 * 用量来自 `assistant/attempt`，两者按事件顺序配对。
 *
 * 为什么按日期分组：会话日志会被用户删除，而中转站账单不会。
 * 折叠结果要按天存进账本，删了日志也能从账本里把历史捞回来。
 *
 * @param events - 该会话的 durable 事件。
 * @param since - 起始毫秒；0 表示不限。
 * @returns `Map<YYYY-MM-DD, Map<桶键, 桶>>`
 */
function foldSession(events, since) {
  const byDay = new Map()
  let route
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue

    // 路由来源一：request/header（每次请求头变化时写入）。
    if (event.type === 'request/header') {
      const config = event.data?.header?.config
      if (
        config !== null &&
        typeof config === 'object' &&
        typeof config.provider === 'string' &&
        typeof config.model === 'string'
      ) {
        route = { provider: config.provider, model: config.model }
      }
      continue
    }

    // 路由来源二：assistant/message 自带 message.source（导入型日志只有它）。
    if (event.type === 'assistant/message') {
      const source = event.data?.message?.source
      if (
        source !== null &&
        typeof source === 'object' &&
        typeof source.provider === 'string' &&
        typeof source.model === 'string'
      ) {
        route = { provider: source.provider, model: source.model }
      }
    }

    // 用量来源：assistant/attempt 的 stream 里，或 assistant/message 的 usage 字段。
    let usage
    if (event.type === 'assistant/attempt') {
      usage = normalizeUsage(streamUsage(event.data?.stream))
    } else if (event.type === 'assistant/message') {
      usage = normalizeUsage(event.data?.usage)
      // 有些日志把 usage 也留在 stream 里。
      if (usage === undefined) usage = normalizeUsage(streamUsage(event.data?.stream))
    } else {
      continue
    }
    if (usage === undefined) continue
    if (typeof event.time !== 'number') continue
    if (since > 0 && event.time < since) continue

    const provider = route?.provider ?? 'unknown'
    const model = route?.model ?? 'unknown'
    // 峰谷分桶：泽西的 deepseek 系列按请求发生的北京时间分峰/谷两档单价。
    // 桶键里带上 tier，聚合时两档分别计价再相加。
    const tier = isPeakTime(event.time) ? 'peak' : 'offpeak'
    const key = `${provider}\u0000${model}\u0000${tier}`
    const day = beijingDayKey(event.time)
    let buckets = byDay.get(day)
    if (buckets === undefined) {
      buckets = new Map()
      byDay.set(day, buckets)
    }
    const bucket = buckets.get(key) ?? {
      provider,
      model,
      tier,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      attempts: 0,
      lastTime: 0,
    }
    bucket.inputTokens += usage.inputTokens
    bucket.outputTokens += usage.outputTokens
    bucket.cacheReadTokens += usage.cacheReadTokens
    bucket.cacheWriteTokens += usage.cacheWriteTokens
    bucket.attempts += 1
    if (event.time > bucket.lastTime) bucket.lastTime = event.time
    buckets.set(key, bucket)
  }
  return byDay
}

/**
 * 从 DSH 凭据文件里取泽西的 API key。
 *
 * 位置：DSH_HOME/.credentials.yaml 里的 `ZEXITONGXUE_API_KEY: sk-...`。
 * 刻意不引入 YAML 解析库：只做一行正则，够用且零依赖。
 *
 * @returns API key，取不到时 undefined。
 */
function readJerseyApiKey() {
  // 环境变量优先，方便用户覆盖。
  const fromEnv = process.env.ZEXITONGXUE_API_KEY
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv

  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  let text
  try {
    text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  } catch {
    return undefined
  }
  const matched = text.match(/ZEXITONGXUE_API_KEY:\s*["']?([A-Za-z0-9_\-]+)["']?/)
  return matched === null ? undefined : matched[1]
}

/**
 * 查询泽西中转站的额度。
 *
 * 泽西实现了 OpenAI 旧版 billing 端点：
 *   GET /v1/dashboard/billing/subscription → { hard_limit_usd }  总额度（元）
 *   GET /v1/dashboard/billing/usage        → { total_usage }      已用（**分**）
 *
 * 注意两者单位不一致（这是 OpenAI 旧接口的历史遗留，泽西照抄了）：
 * `hard_limit_usd` 是元，`total_usage` 是分。剩余额度 = 总额度 - 已用/100。
 *
 * @returns 额度快照；失败时返回带 error 的对象（不抛）。
 */
async function fetchJerseyBalance() {
  const key = readJerseyApiKey()
  if (key === undefined) {
    return { ok: false, error: '没有找到泽西 API key（DSH_HOME/.credentials.yaml 里的 ZEXITONGXUE_API_KEY）' }
  }

  const call = async (path) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(`${JERSEY_BASE_URL}${path}`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  try {
    const [subscription, usage] = await Promise.all([
      call(BILLING_SUBSCRIPTION),
      call(BILLING_USAGE),
    ])
    const total = Number(subscription?.hard_limit_usd)
    const usedCents = Number(usage?.total_usage)
    if (!Number.isFinite(total) || !Number.isFinite(usedCents)) {
      return { ok: false, error: '泽西返回的额度字段无法解析' }
    }
    const used = usedCents / 100
    return {
      ok: true,
      provider: JERSEY_PROVIDER,
      total,
      used,
      remaining: total - used,
      checkedAt: Date.now(),
    }
  } catch (error) {
    return { ok: false, error: `查询泽西额度失败：${String(error)}` }
  }
}

/**
 * 会话日志根目录。
 * DSH_HOME/sessions/<工作区编码>/<session-id>/session.v4.jsonl.zstd
 */
function sessionsRoot() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  return join(home, 'sessions')
}

/** 递归找出所有会话日志文件。 */
function findLogFiles(root) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (entry.name.endsWith('.jsonl.zstd')) {
        found.push(full)
      }
    }
  }
  walk(root, 0)
  return found
}

/** zstd 帧魔数：28 b5 2f fd。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解压一个会话日志。
 *
 * 文件是**多个 zstd 帧顺序拼接**的（每写一批事件追加一帧），
 * `zstdDecompressSync` 一次只解第一帧，所以必须按魔数切分逐帧解。
 *
 * @param file - 日志文件路径。
 * @returns 解析后的事件数组（无法解析的行被跳过）。
 */
function readSessionEvents(file) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return []
  }
  if (buffer.length === 0) return []

  // 找所有帧起始位置。
  const offsets = []
  let cursor = 0
  while (cursor < buffer.length) {
    const at = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (at === -1) break
    offsets.push(at)
    cursor = at + ZSTD_MAGIC.length
  }
  if (offsets.length === 0) return []
  offsets.push(buffer.length)

  const events = []
  for (let index = 0; index < offsets.length - 1; index += 1) {
    let text
    try {
      text = zstdDecompressSync(buffer.subarray(offsets[index], offsets[index + 1])).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      try {
        const event = JSON.parse(line)
        if (event !== null && typeof event === 'object') events.push(event)
      } catch {
        /* 半行或损坏行：跳过 */
      }
    }
  }
  return events
}

/**
 * 取某个模型在某个时段档位下的单价。
 *
 * 价目表支持两种写法：
 *   1. 平铺（不分峰谷）：`{ inputPerMillion, outputPerMillion, cacheReadPerMillion }`
 *   2. 分峰谷：`{ peak: {...}, offpeak: {...} }`
 *
 * 分峰谷时，缺失的档位回退到另一档；两档都缺则回退到平铺字段。
 *
 * @param price - 价目表里的一条记录。
 * @param tier - `peak` | `offpeak`。
 */
function tierPrice(price, tier) {
  if (price === undefined || price === null) return undefined
  const other = tier === 'peak' ? 'offpeak' : 'peak'
  const own = price[tier]
  const fallback = price[other]
  const source =
    own !== null && typeof own === 'object'
      ? own
      : fallback !== null && typeof fallback === 'object'
        ? fallback
        : price
  return {
    inputPerMillion: source.inputPerMillion ?? price.inputPerMillion ?? 0,
    outputPerMillion: source.outputPerMillion ?? price.outputPerMillion ?? 0,
    cacheReadPerMillion: source.cacheReadPerMillion ?? price.cacheReadPerMillion ?? 0,
    cacheWritePerMillion: source.cacheWritePerMillion ?? price.cacheWritePerMillion,
  }
}

/** 按单价算一条 bucket 的费用明细。 */
function priceBucket(bucket, price, options) {
  const tiered = tierPrice(price, bucket.tier ?? 'offpeak')
  const input = tiered?.inputPerMillion ?? 0
  const output = tiered?.outputPerMillion ?? 0
  const cacheRead = tiered?.cacheReadPerMillion ?? 0
  const cacheWrite =
    options.cacheWriteAsRead === true ? cacheRead : tiered?.cacheWritePerMillion ?? input

  const uncachedCost = (bucket.inputTokens / PER_MILLION) * input
  const cacheReadCost = (bucket.cacheReadTokens / PER_MILLION) * cacheRead
  const cacheWriteCost = (bucket.cacheWriteTokens / PER_MILLION) * cacheWrite
  const outputCost = (bucket.outputTokens / PER_MILLION) * output

  return {
    ...bucket,
    priced: price !== undefined,
    unitInput: input,
    unitOutput: output,
    unitCacheRead: cacheRead,
    unitCacheWrite: cacheWrite,
    uncachedCost,
    cacheReadCost,
    cacheWriteCost,
    outputCost,
    cost: uncachedCost + cacheReadCost + cacheWriteCost + outputCost,
  }
}

/**
 * 价目表持久化。
 *
 * 这里刻意不走 `ctx.storageDomain`：那需要 `defineDomain` / `zod` 两个
 * 只在 asar 内的包，已安装插件从 profile 目录解析不到它们。
 * 价目表是一份很小的纯数据，直接写 DSH_HOME 下的 JSON 文件最稳。
 */
/** 价目表文件路径。 */
function pricesFile() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  return join(home, 'jersey-billing.json')
}

/** 读取持久化的价目表；任何异常都当作「还没有存过」。 */
function loadStoredPrices() {
  try {
    const parsed = JSON.parse(readFileSync(pricesFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

/** 原子写入价目表。 */
function saveStoredPrices(table) {
  const target = pricesFile()
  const temp = `${target}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(temp, JSON.stringify(table, null, 2), 'utf8')
  renameSync(temp, target)
}

/**
 * 计费账本。
 *
 * 为什么需要它：会话日志会被用户删除（DSH 的会话管理里删掉就没了），
 * 而中转站后台的账单不会跟着消失。如果只读磁盘日志，删一个会话，
 * 那部分计费就从面板上凭空蒸发，永远对不上账。
 *
 * 所以每个会话的折叠结果按**北京日期**存进账本：
 *   { version, sessions: { <sessionId>: { seenAt, days: { <YYYY-MM-DD>: { <桶键>: 桶 } } } } }
 *
 * 按日期存是为了让「今天 / 本周 / 本月 / 全部」四个窗口都能从账本里筛出来。
 * 峰谷档位在折叠时已经定好，所以桶键里带 tier。
 */
/** 账本文件路径。 */
function ledgerFile() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  return join(home, 'jersey-billing-ledger.json')
}

/** 读取账本；任何异常都当作「还没有账本」。 */
function loadLedger() {
  try {
    const parsed = JSON.parse(readFileSync(ledgerFile(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return { version: 1, sessions: {} }
    if (parsed.sessions === null || typeof parsed.sessions !== 'object') {
      return { version: 1, sessions: {} }
    }
    return { version: 1, sessions: parsed.sessions }
  } catch {
    return { version: 1, sessions: {} }
  }
}

/** 原子写入账本（不缩进：账本是机器读的，缩进会让文件大好几倍）。 */
function saveLedger(ledger) {
  const target = ledgerFile()
  const temp = `${target}.tmp`
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(temp, JSON.stringify(ledger), 'utf8')
  renameSync(temp, target)
}

/** 把一个毫秒时间戳换算成北京时间的 `YYYY-MM-DD`。 */
function beijingDayKey(timeMs) {
  const shifted = new Date(timeMs + 8 * 60 * 60 * 1000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 取会话 id：优先读日志里的 session 头，其次用所在目录名。 */
function sessionIdOf(events, file) {
  for (const event of events) {
    if (event.type === 'session' && typeof event.id === 'string' && event.id.length > 0) {
      return event.id
    }
  }
  const parts = String(file).split(/[\\/]/)
  const dir = parts[parts.length - 2]
  return typeof dir === 'string' && dir.length > 0 ? dir : undefined
}

/** 写一个 JSON 响应。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读一个 JSON 请求体（上限 64 KiB）。 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${String(error)}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Host 半边入口。
 * @param ctx - Host 插件上下文。
 * @param config - Loader 传入的插件 config。
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  /** config 声明的价目表：作为持久化域的空缺兜底。 */
  const seed = new Map()
  for (const model of resolved.models) {
    const { id, ...price } = model
    seed.set(id, price)
  }

  /**
   * 持久化的价目表（模型 id → 单价）。
   * 首次运行从文件读；文件不存在时用 config 种子。
   */
  const stored = loadStoredPrices()
  const overrides = new Map()
  if (stored !== undefined) {
    for (const [id, price] of Object.entries(stored)) {
      if (price === null || typeof price !== 'object') continue
      overrides.set(id, {
        ...normalizePriceShape(price),
        ...(typeof price.label === 'string' && price.label.length > 0 ? { label: price.label } : {}),
      })
    }
  }
  /** 是否已经存在持久化文件（决定面板上的提示文案）。 */
  let persistent = stored !== undefined

  /** 把当前价目表落盘。 */
  function persist() {
    try {
      saveStoredPrices(Object.fromEntries(overrides))
      persistent = true
      return true
    } catch (error) {
      ctx.logger?.warn?.(`jersey-billing: 价目表写入失败：${String(error)}`)
      return false
    }
  }

  /** 读取当前价目表：持久化记录优先，其次 config 种子。 */
  function readPrices() {
    const table = new Map(seed)
    for (const [id, price] of overrides) table.set(id, price)
    return table
  }

  /**
   * 扫描磁盘日志，把每个会话的用量按天写进账本。
   *
   * 这一步是「增量累积」：每次聚合都先刷新账本，然后**只从账本读数**。
   * 这样用户删掉会话后，那部分历史仍然留在账本里，计费不会凭空消失。
   *
   * 只对「日志还在」的会话做刷新；日志已删除的会话在账本里原样保留。
   *
   * @returns `{ ledger, aliveIds }`：账本对象，以及当前磁盘上还存在日志的会话 id 集合。
   */
  function refreshLedger() {
    const ledger = loadLedger()
    const files = findLogFiles(sessionsRoot())
    const aliveIds = new Set()
    let dirty = false

    for (const file of files) {
      const events = readSessionEvents(file)
      if (events.length === 0) continue
      const sessionId = sessionIdOf(events, file)
      if (sessionId === undefined) continue
      aliveIds.add(sessionId)

      // 折叠整个会话（since=0），按天分组。
      const byDay = foldSession(events, 0)
      if (byDay.size === 0) continue

      let entry = ledger.sessions[sessionId]
      if (entry === null || typeof entry !== 'object') {
        entry = { seenAt: 0, days: {} }
        ledger.sessions[sessionId] = entry
      }
      if (entry.days === null || typeof entry.days !== 'object') entry.days = {}

      for (const [day, buckets] of byDay) {
        const plain = {}
        for (const [key, bucket] of buckets) plain[key] = bucket
        // 日志是权威：同一天的桶直接覆盖（日志只会变多，不会变少）。
        entry.days[day] = plain
        dirty = true
      }
      entry.seenAt = Date.now()
    }

    if (dirty) {
      try {
        saveLedger(ledger)
      } catch (error) {
        ctx.logger?.warn?.(`jersey-billing: 账本写入失败：${String(error)}`)
      }
    }
    return { ledger, aliveIds }
  }

  /**
   * 聚合全部会话的用量。
   *
   * 数据源是**账本**而不是磁盘日志：日志会被用户删除，账本不会。
   * 每次聚合前先刷新账本（把日志里的新用量累积进去），再从账本按窗口筛选。
   *
   * @param window - today | week | month | all
   * @param scope - jersey（只统计泽西）| all（全部 provider）
   */
  async function aggregate(window, scope) {
    const now = Date.now()
    const since = windowStart(WINDOWS.includes(window) ? window : 'today', now)
    const prices = readPrices()
    // 默认只统计泽西：面板叫「泽西计费统计」，混入官方账号的调用会误导对账。
    const onlyJersey = scope !== 'all'
    const skippedProviders = new Set()

    // 先刷新账本，再从账本读数。
    const { ledger, aliveIds } = refreshLedger()

    const totals = new Map()
    let sessionCount = 0
    let attempts = 0
    let sessionTotal = 0
    let deletedSessions = 0

    for (const [sessionId, entry] of Object.entries(ledger.sessions)) {
      if (entry === null || typeof entry !== 'object') continue
      const days = entry.days
      if (days === null || typeof days !== 'object') continue
      sessionTotal += 1
      // 账本里有、磁盘上没有 → 这个会话已被删除，但用量仍保留。
      if (!aliveIds.has(sessionId)) deletedSessions += 1
      let used = false
      for (const [day, plain] of Object.entries(days)) {
        // 窗口过滤：按北京日期筛。`all` 时 since=0，全部保留。
        if (since > 0) {
          const dayStart = Date.parse(`${day}T00:00:00+08:00`)
          if (!Number.isFinite(dayStart) || dayStart + 86_400_000 <= since) continue
        }
        if (plain === null || typeof plain !== 'object') continue
        for (const bucket of Object.values(plain)) {
          if (bucket === null || typeof bucket !== 'object') continue
          // provider 过滤：只统计泽西时，其他 provider 的用量整桶丢弃。
          if (onlyJersey && bucket.provider !== JERSEY_PROVIDER) {
            skippedProviders.add(bucket.provider)
            continue
          }
          used = true
          const key = `${bucket.provider}\u0000${bucket.model}\u0000${bucket.tier}`
          const existing = totals.get(key) ?? {
            provider: bucket.provider,
            model: bucket.model,
            tier: bucket.tier,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            attempts: 0,
          }
          existing.inputTokens += bucket.inputTokens ?? 0
          existing.outputTokens += bucket.outputTokens ?? 0
          existing.cacheReadTokens += bucket.cacheReadTokens ?? 0
          existing.cacheWriteTokens += bucket.cacheWriteTokens ?? 0
          existing.attempts += bucket.attempts ?? 0
          totals.set(key, existing)
          attempts += bucket.attempts ?? 0
        }
      }
      if (used) sessionCount += 1
    }

    const rows = []
    const unpriced = new Set()
    let grandTotal = 0

    // 先把「provider+model+tier」的桶按模型合并，再计价：
    // 峰谷两档单价不同，所以合并时要保留两档各自的 token 数。
    const merged = new Map()
    for (const bucket of totals.values()) {
      const key = `${bucket.provider}\u0000${bucket.model}`
      const row = merged.get(key) ?? {
        provider: bucket.provider,
        model: bucket.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        attempts: 0,
        tiers: {},
      }
      row.inputTokens += bucket.inputTokens
      row.outputTokens += bucket.outputTokens
      row.cacheReadTokens += bucket.cacheReadTokens
      row.cacheWriteTokens += bucket.cacheWriteTokens
      row.attempts += bucket.attempts
      const tier = bucket.tier ?? 'offpeak'
      const slot = row.tiers[tier] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        attempts: 0,
      }
      slot.inputTokens += bucket.inputTokens
      slot.outputTokens += bucket.outputTokens
      slot.cacheReadTokens += bucket.cacheReadTokens
      slot.cacheWriteTokens += bucket.cacheWriteTokens
      slot.attempts += bucket.attempts
      row.tiers[tier] = slot
      merged.set(key, row)
    }

    for (const row of merged.values()) {
      const exact = prices.get(row.model)
      const price = exact ?? prices.get(resolved.defaultModel)
      if (exact === undefined) unpriced.add(row.model)

      // 两档分别计价后相加。
      let cost = 0
      const tierDetail = {}
      for (const [tier, slot] of Object.entries(row.tiers)) {
        const priced = priceBucket({ ...slot, tier }, price, resolved)
        cost += priced.cost
        tierDetail[tier] = {
          inputTokens: slot.inputTokens,
          outputTokens: slot.outputTokens,
          cacheReadTokens: slot.cacheReadTokens,
          cacheWriteTokens: slot.cacheWriteTokens,
          attempts: slot.attempts,
          unitInput: priced.unitInput,
          unitOutput: priced.unitOutput,
          unitCacheRead: priced.unitCacheRead,
          cost: priced.cost,
        }
      }

      const offpeak = tierDetail.offpeak
      const peak = tierDetail.peak
      rows.push({
        provider: row.provider,
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        attempts: row.attempts,
        priced: exact !== undefined,
        tiers: tierDetail,
        peakCost: peak?.cost ?? 0,
        offpeakCost: offpeak?.cost ?? 0,
        peakAttempts: peak?.attempts ?? 0,
        offpeakAttempts: offpeak?.attempts ?? 0,
        cost,
      })
      grandTotal += cost
    }
    rows.sort((a, b) => b.cost - a.cost)

    return {
      ok: true,
      window: WINDOWS.includes(window) ? window : 'today',
      scope: onlyJersey ? 'jersey' : 'all',
      jerseyProvider: JERSEY_PROVIDER,
      skippedProviders: [...skippedProviders],
      since,
      now,
      currency: resolved.currency,
      cacheWriteAsRead: resolved.cacheWriteAsRead,
      defaultModel: resolved.defaultModel,
      persistent,
      // 峰谷计价的元信息：面板据此显示「峰时/谷时」标签与日历提示。
      peakHours: PEAK_HOURS_DISPLAY,
      peakLabel: PEAK_LABEL,
      offPeakLabel: OFF_PEAK_LABEL,
      calendarCovered: isCalendarCovered(now),
      sessionCount,
      // 账本里记录过、但日志已被删除的会话数（面板据此提示「已保留历史」）。
      deletedSessions,
      ledgerSessions: sessionTotal,
      attempts,
      unpriced: [...unpriced],
      rows,
      total: {
        inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
        outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
        cacheReadTokens: rows.reduce((sum, row) => sum + row.cacheReadTokens, 0),
        cacheWriteTokens: rows.reduce((sum, row) => sum + row.cacheWriteTokens, 0),
        cost: grandTotal,
      },
    }
  }

  /** 读取价目表（面板用）。 */
  async function listPrices() {
    const prices = readPrices()
    return {
      ok: true,
      currency: resolved.currency,
      defaultModel: resolved.defaultModel,
      persistent,
      models: [...prices.entries()].map(([id, price]) => ({ id, ...price })),
    }
  }

  /** 写入一条价目。 */
  async function savePrice(input) {
    const model = input?.model
    if (typeof model !== 'string' || model.length === 0) return { ok: false, error: '缺少模型 id' }
    const price = {
      ...normalizePriceShape(input),
      ...(typeof input.label === 'string' && input.label.length > 0 ? { label: input.label } : {}),
    }
    overrides.set(model, price)
    return { ok: true, persistent: persist() }
  }

  /** 删除一条价目。 */
  async function deletePrice(input) {
    const model = input?.model
    if (typeof model !== 'string' || model.length === 0) return { ok: false, error: '缺少模型 id' }
    seed.delete(model)
    overrides.delete(model)
    return { ok: true, persistent: persist() }
  }

  /**
   * 泽西额度快照，带 60 秒缓存。
   * 中转站的 billing 接口有速率限制，面板 15 秒刷新一次不能次次都打过去。
   */
  let balanceCache
  async function jerseyBalance(force) {
    const now = Date.now()
    if (force !== true && balanceCache !== undefined && now - balanceCache.at < BALANCE_TTL_MS) {
      return balanceCache.value
    }
    const value = await fetchJerseyBalance()
    // 查询失败也缓存，避免中转站挂掉时面板疯狂重试。
    balanceCache = { at: now, value }
    return value
  }

  // ── 浏览器半边取数路由 ──────────────────────────────────────────────
  // 只读统计走 GET，改价目表走 POST（同源页面发起）。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const action = url.pathname.slice(ROUTE_PATH.length).replace(/^\//, '') || 'summary'

            if (req.method === 'GET' && action === 'summary') {
              sendJson(
                res,
                200,
                await aggregate(
                  url.searchParams.get('window') ?? 'today',
                  url.searchParams.get('scope') ?? 'jersey',
                ),
              )
              return
            }
            if (req.method === 'GET' && action === 'balance') {
              sendJson(res, 200, await jerseyBalance(url.searchParams.get('force') === '1'))
              return
            }
            if (req.method === 'GET' && action === 'prices') {
              sendJson(res, 200, await listPrices())
              return
            }
            if (req.method === 'POST' && action === 'prices') {
              const body = await readJson(req)
              sendJson(res, 200, await savePrice(body))
              return
            }
            if (req.method === 'POST' && action === 'prices/delete') {
              const body = await readJson(req)
              sendJson(res, 200, await deletePrice(body))
              return
            }
            sendJson(res, 404, { ok: false, error: `未知操作：${req.method} ${action}` })
          } catch (error) {
            sendJson(res, 400, { ok: false, error: String(error) })
          }
        },
      }),
    'jersey-billing: data route',
  )
}

/** Loader 行可见的插件名。 */
export const name = 'jersey-billing'

/**
 * 硬依赖的 Host 服务。
 * Cordis 要求先声明 inject 才能访问 ctx.<service>。
 * 统计走磁盘日志，只需要 webServer 注册取数路由。
 */
export const inject = ['webServer']
