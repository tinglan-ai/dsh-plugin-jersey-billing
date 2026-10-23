/**
 * Znb 计费统计插件 —— Host 半边。
 *
 * 统计对象：provider = `znb-gongsi`（znbcode.com 的中转账号）的调用。
 * 同一个站点上的 `znbcode` 等其他 provider、以及本机其他所有中转站，
 * 一律**不计入**——这是硬编码的，面板里没有开关。
 *
 * 职责：
 *  1. 读取 DSH_HOME/sessions 下**全部会话**的日志；
 *  2. 从 `assistant/message.data.usage` 或 `assistant/attempt` 的 stream
 *     取出精确 token 用量（inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens）；
 *  3. 从 `request/header` 或 `assistant/message.data.message.source`
 *     取出该次请求实际使用的 provider / model；
 *  4. 按面板配置的单价（每百万 token）算出花费；
 *  5. 把价目表持久化到 DSH_HOME/znb-billing.json；
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
 *          + 缓存写入/1M × 缓存写入单价（Znb 不收，默认 0）
 *          + 输出/1M × 输出单价
 *
 * @module dsh-plugin-jersey-billing
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 统计窗口：今天 / 本周 / 本月 / 全部。 */
const WINDOWS = ['today', 'week', 'month', 'all']

/** 每百万 token 的换算基数。 */
const PER_MILLION = 1_000_000

/** 浏览器半边取数的路由前缀。 */
const ROUTE_PATH = '/znb-billing'

/**
 * 唯一计入统计的 provider id。
 *
 * 本机在 znbcode.com 上配了两个账号：`znbcode` 与 `znb-gongsi`。
 * 只有后者是本插件要统计的那个；同站另一个账号以及别家中转站的调用
 * 都按「不统计」处理，避免面板数字和实际付费账号对不上。
 */
const ZNB_PROVIDER = 'znb-gongsi'

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
 * 把一条价目记录归一化成平铺结构。
 *
 * 结构：`{ inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion }`
 *
 * 只认平铺写法。早期版本支持过 peak / offpeak 分峰谷子对象，Znb 不分峰谷，
 * 那套字段已经移除；旧配置文件里若还留着 peak/offpeak，会被忽略。
 *
 * @param raw - 原始记录。
 * @returns 归一化后的记录（只含合法字段）。
 */
function normalizePriceShape(raw) {
  const out = {}
  if (raw.inputPerMillion !== undefined) out.inputPerMillion = toPrice(raw.inputPerMillion)
  if (raw.outputPerMillion !== undefined) out.outputPerMillion = toPrice(raw.outputPerMillion)
  if (raw.cacheReadPerMillion !== undefined) {
    out.cacheReadPerMillion = toPrice(raw.cacheReadPerMillion)
  }
  if (raw.cacheWritePerMillion !== undefined && raw.cacheWritePerMillion !== null) {
    out.cacheWritePerMillion = toPrice(raw.cacheWritePerMillion)
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
 * 用量来自 `assistant/attempt` / `assistant/message`，两者按事件顺序配对。
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
    const key = `${provider}\u0000${model}`
    const day = beijingDayKey(event.time)
    let buckets = byDay.get(day)
    if (buckets === undefined) {
      buckets = new Map()
      byDay.set(day, buckets)
    }
    const bucket = buckets.get(key) ?? {
      provider,
      model,
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

/** 按单价算一条桶的费用明细。 */
function priceBucket(bucket, price) {
  const input = price?.inputPerMillion ?? 0
  const output = price?.outputPerMillion ?? 0
  const cacheRead = price?.cacheReadPerMillion ?? 0
  const cacheWrite = price?.cacheWritePerMillion ?? 0

  const uncachedCost = (bucket.inputTokens / PER_MILLION) * input
  const cacheReadCost = (bucket.cacheReadTokens / PER_MILLION) * cacheRead
  const cacheWriteCost = (bucket.cacheWriteTokens / PER_MILLION) * cacheWrite
  const outputCost = (bucket.outputTokens / PER_MILLION) * output

  return {
    ...bucket,
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
  return join(home, 'znb-billing.json')
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
 */
/** 账本文件路径。 */
function ledgerFile() {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  return join(home, 'znb-billing-ledger.json')
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
      ctx.logger?.warn?.(`znb-billing: 价目表写入失败：${String(error)}`)
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
        ctx.logger?.warn?.(`znb-billing: 账本写入失败：${String(error)}`)
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
   * 过滤规则（硬编码，没有开关）：
   *   1. 只保留 provider = `znb-gongsi` 的桶；
   *   2. 只保留价目表里**明确配置了单价**的模型，未定价的整桶丢弃。
   *      不再回退到某个默认模型的价格——那会把不该统计的用量算成钱。
   *
   * @param window - today | week | month | all
   */
  async function aggregate(window) {
    const now = Date.now()
    const since = windowStart(WINDOWS.includes(window) ? window : 'today', now)
    const prices = readPrices()
    const skippedProviders = new Set()
    const skippedModels = new Set()

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
          // provider 过滤：只有 znb-gongsi 计入，其他一律丢弃。
          if (bucket.provider !== ZNB_PROVIDER) {
            skippedProviders.add(bucket.provider)
            continue
          }
          // 模型过滤：没有配置单价的模型不计费、也不计入总量。
          if (!prices.has(bucket.model)) {
            skippedModels.add(bucket.model)
            continue
          }
          used = true
          const key = `${bucket.provider}\u0000${bucket.model}`
          const existing = totals.get(key) ?? {
            provider: bucket.provider,
            model: bucket.model,
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
    let grandTotal = 0
    for (const bucket of totals.values()) {
      const priced = priceBucket(bucket, prices.get(bucket.model))
      rows.push({
        provider: bucket.provider,
        model: bucket.model,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
        attempts: bucket.attempts,
        unitInput: priced.unitInput,
        unitOutput: priced.unitOutput,
        unitCacheRead: priced.unitCacheRead,
        unitCacheWrite: priced.unitCacheWrite,
        cost: priced.cost,
      })
      grandTotal += priced.cost
    }
    rows.sort((a, b) => b.cost - a.cost)

    return {
      ok: true,
      window: WINDOWS.includes(window) ? window : 'today',
      provider: ZNB_PROVIDER,
      skippedProviders: [...skippedProviders],
      skippedModels: [...skippedModels],
      since,
      now,
      currency: resolved.currency,
      persistent,
      sessionCount,
      // 账本里记录过、但日志已被删除的会话数（面板据此提示「已保留历史」）。
      deletedSessions,
      ledgerSessions: sessionTotal,
      attempts,
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
              sendJson(res, 200, await aggregate(url.searchParams.get('window') ?? 'today'))
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
    'znb-billing: data route',
  )
}

/** Loader 行可见的插件名。 */
export const name = 'znb-billing'

/**
 * 硬依赖的 Host 服务。
 * Cordis 要求先声明 inject 才能访问 ctx.<service>。
 * 统计走磁盘日志，只需要 webServer 注册取数路由。
 */
export const inject = ['webServer']
