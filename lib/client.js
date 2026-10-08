/**
 * 泽西计费统计插件 —— 浏览器半边（预构建 bundle）。
 *
 * 这份文件不是普通 ES 模块：client-modules 只接受已经构建好的
 * `window.__ModuleLoader__.load({ id, factory })` 工厂式 CJS bundle。
 * `require` 只能取平台种子表里的模块：
 *   react, react/jsx-runtime, react-dom, react-dom/client,
 *   @deepseek-ai/cordis, @deepseek-ai/dsh-client-store,
 *   @deepseek-ai/dsh-client-ui-slots,
 *   @deepseek-ai/dsh-client-ui-primitives,
 *   @deepseek-ai/dsh-client-ui-dockkit
 *
 * 重要：jsx-runtime 的签名是 `jsx(type, props, key)` —— children 必须写在
 * props 里（`{ children: ... }`），第三位是 key 而不是子节点。写成
 * `jsx(type, props, child1, child2)` 会把子节点静默丢掉，渲染成空白。
 *
 * 数据经 Host 半边注册的 `/jersey-billing` 路由读取。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-jersey-billing',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 元素构造器：children 一律走 props.children。 */
    const h = jsxRuntime.jsx
    const hs = jsxRuntime.jsxs
    const Fragment = jsxRuntime.Fragment

    /** 面板 id：同时作为 sidebar.panellist 的 id 与 main 的 key。 */
    const PANEL_ID = 'jersey-billing'
    /** 取数路由前缀（与 Host 半边一致）。 */
    const ROUTE = '/jersey-billing'
    /** 自动刷新间隔。 */
    const REFRESH_MS = 15000

    // ── 样式 ─────────────────────────────────────────────────────────
    const CSS = `
.jbScroll{height:100%;width:100%;overflow-y:auto;overflow-x:hidden;box-sizing:border-box}
.jbRoot{display:flex;flex-direction:column;gap:16px;padding:20px 24px 40px;max-width:1080px;margin:0 auto;color:var(--dsw-alias-label-primary);box-sizing:border-box;width:100%}
.jbHead{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.jbTitle{margin:0;font-size:18px;font-weight:600;line-height:26px}
.jbSub{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.jbHeadActions{display:flex;align-items:center;gap:8px}
.jbCards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.jbCard{border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:4px;min-width:0}
.jbCardLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.jbCardValue{font-size:20px;line-height:28px;font-weight:600;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.jbCardHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.jbSection{display:flex;flex-direction:column;gap:8px}
.jbSectionHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.jbSectionTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}
.jbTableWrap{border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.jbTable{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
.jbTable th{text-align:right;font-weight:500;color:var(--dsw-alias-label-secondary);padding:8px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l1);white-space:nowrap;background:var(--dsw-alias-bg-layer-2)}
.jbTable th:first-child,.jbTable td:first-child{text-align:left}
.jbTable td{text-align:right;padding:8px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums;white-space:nowrap}
.jbTable tr:last-child td{border-bottom:0}
.jbModel{display:flex;flex-direction:column;gap:1px;min-width:0}
.jbModelName{font-weight:500;overflow-wrap:anywhere}
.jbModelProv{font-size:11px;color:var(--dsw-alias-label-secondary)}
.jbCost{font-weight:600}
.jbUnpriced{color:var(--dsw-alias-state-warn-primary)}
.jbEmpty{padding:22px 14px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}
.jbNotice{border-radius:8px;padding:9px 12px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.jbNoticeWarn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}
.jbNoticeError{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.jbForm{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;align-items:end}
.jbField{display:flex;flex-direction:column;gap:4px;min-width:0}
.jbFieldLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.jbFieldInput{box-sizing:border-box;width:100%;border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:6px 8px}
.jbFieldInput:focus{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}
.jbFormActions{display:flex;gap:8px;align-items:center;margin-top:2px}
.jbFootnote{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.jbRows{display:flex;flex-direction:column;gap:10px;padding:12px 14px}
.jbBalance{border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.jbBalanceTop{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.jbBalanceMain{display:flex;align-items:baseline;gap:10px;min-width:0}
.jbBalanceLabel{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.jbBalanceValue{font-size:22px;line-height:30px;font-weight:600;font-variant-numeric:tabular-nums}
.jbBalanceMeta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.jbBar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.jbBarFill{height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.jbBarFillWarn{background:var(--dsw-alias-state-warn-primary)}
.jbBarFillError{background:var(--dsw-alias-state-error-primary)}
.jbToggle{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
.jbToggle input{cursor:pointer;margin:0}
.jbFormTop{display:grid;grid-template-columns:minmax(160px,1fr) auto;gap:10px 12px;align-items:end}
.jbTiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}
.jbTier{border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:8px 10px;display:flex;flex-direction:column;gap:8px}
.jbTierHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.jbTierTitle{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}
.jbTierHint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.jbTierFields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.jbTierTag{display:inline-block;font-size:11px;line-height:16px;padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.jbTierTagPeak{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base)}
.jbSplit{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
`

    const tagId = 'dsh-plugin-jersey-billing/panel.css'
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-jersey-billing'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ── 数据访问 ──────────────────────────────────────────────────────
    /** GET 一个 JSON 端点。 */
    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /** POST 一个 JSON 端点。 */
    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    // ── 格式化 ────────────────────────────────────────────────────────
    /** 千分位整数。 */
    function formatCount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toLocaleString('zh-CN')
    }

    /** 紧凑 token 数（1.2M / 34.5K）。 */
    function formatCompact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`
      return String(value)
    }

    /** 金额：小额多留小数，避免显示成 0.00。 */
    function formatMoney(value, currency) {
      const symbol = typeof currency === 'string' ? currency : '¥'
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${symbol}—`
      const decimals = value !== 0 && Math.abs(value) < 0.01 ? 6 : Math.abs(value) < 1 ? 4 : 2
      return `${symbol}${value.toFixed(decimals)}`
    }

    /** 窗口起点的可读时间。 */
    function formatSince(since, range) {
      if (range === 'all') return '全部历史'
      if (typeof since !== 'number' || since <= 0) return ''
      const date = new Date(since)
      return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} 起`
    }

    const WINDOW_OPTIONS = [
      { value: 'today', label: '今天' },
      { value: 'week', label: '本周' },
      { value: 'month', label: '本月' },
      { value: 'all', label: '全部' },
    ]

    /** 表格列定义。 */
    const COLUMNS = ['模型', '请求', '未命中输入', '缓存读取', '缓存写入', '输出', '花费']

    // ── 图标 ──────────────────────────────────────────────────────────
    /** 侧边栏面板图标：一枚钱包轮廓。 */
    function PanelIcon({ size }) {
      return h('svg', {
        width: size ?? 18,
        height: size ?? 18,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        children: [
          h('path', { key: 'a', d: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1' }),
          h('path', { key: 'b', d: 'M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2' }),
          h('path', { key: 'c', d: 'M21 9h-5a2.5 2.5 0 0 0 0 5h5V9Z' }),
          h('circle', {
            key: 'd',
            cx: '16.5',
            cy: '11.5',
            r: '0.9',
            fill: 'currentColor',
            stroke: 'none',
          }),
        ],
      })
    }

    // ── 价目编辑行 ────────────────────────────────────────────────────
    /**
     * 从一条价目记录里取出某个时段档位的值。
     *
     * 兼容两种写法：分峰谷（`peak` / `offpeak` 子对象）与平铺。
     * 分峰谷时若该档缺失，回退到另一档，再回退到平铺字段。
     */
    function tierOf(model, tier) {
      const other = tier === 'peak' ? 'offpeak' : 'peak'
      const own = model[tier]
      const fallback = model[other]
      const source =
        own !== null && typeof own === 'object'
          ? own
          : fallback !== null && typeof fallback === 'object'
            ? fallback
            : model
      return {
        inputPerMillion: source.inputPerMillion ?? model.inputPerMillion ?? 0,
        outputPerMillion: source.outputPerMillion ?? model.outputPerMillion ?? 0,
        cacheReadPerMillion: source.cacheReadPerMillion ?? model.cacheReadPerMillion ?? 0,
      }
    }

    /** 一行价目：模型 id + 峰谷两套单价 + 保存/删除。 */
    function PriceRow({ model, currency, onSave, onDelete, busy }) {
      /** 把一条价目摊平成表单草稿。 */
      const draftOf = (source) => {
        const peak = tierOf(source, 'peak')
        const offpeak = tierOf(source, 'offpeak')
        return {
          model: source.id,
          peakInput: String(peak.inputPerMillion),
          peakOutput: String(peak.outputPerMillion),
          peakCache: String(peak.cacheReadPerMillion),
          offInput: String(offpeak.inputPerMillion),
          offOutput: String(offpeak.outputPerMillion),
          offCache: String(offpeak.cacheReadPerMillion),
        }
      }

      const [draft, setDraft] = React.useState(() => draftOf(model))

      React.useEffect(() => {
        setDraft(draftOf(model))
      }, [model])

      /** 一个数字输入字段。 */
      const numberField = (name, label) =>
        h('label', {
          key: name,
          className: 'jbField',
          children: [
            h('span', { key: 'l', className: 'jbFieldLabel', children: label }),
            h('input', {
              key: 'i',
              className: 'jbFieldInput',
              type: 'number',
              min: '0',
              step: '0.01',
              value: draft[name],
              onChange: (event) => setDraft((prev) => ({ ...prev, [name]: event.target.value })),
            }),
          ],
        })

      /** 一组三个字段（输入/输出/缓存输入），带一个小标题。 */
      const tierGroup = (tier, title, hint) =>
        hs('div', {
          key: tier,
          className: 'jbTier',
          children: [
            hs('div', {
              key: 'head',
              className: 'jbTierHead',
              children: [
                h('span', { key: 't', className: 'jbTierTitle', children: title }),
                h('span', { key: 'h', className: 'jbTierHint', children: hint }),
              ],
            }),
            hs('div', {
              key: 'fields',
              className: 'jbTierFields',
              children: [
                numberField(
                  tier === 'peak' ? 'peakInput' : 'offInput',
                  `输入 / 1M（${currency}）`,
                ),
                numberField(
                  tier === 'peak' ? 'peakOutput' : 'offOutput',
                  `输出 / 1M（${currency}）`,
                ),
                numberField(
                  tier === 'peak' ? 'peakCache' : 'offCache',
                  `缓存输入 / 1M（${currency}）`,
                ),
              ],
            }),
          ],
        })

      return hs('div', {
        className: 'jbForm',
        children: [
          hs('div', {
            key: 'top',
            className: 'jbFormTop',
            children: [
              h('label', {
                key: 'model',
                className: 'jbField',
                children: [
                  h('span', { key: 'l', className: 'jbFieldLabel', children: '模型 ID' }),
                  h('input', {
                    key: 'i',
                    className: 'jbFieldInput',
                    type: 'text',
                    value: draft.model,
                    onChange: (event) => setDraft((prev) => ({ ...prev, model: event.target.value })),
                  }),
                ],
              }),
              h('div', {
                key: 'actions',
                className: 'jbFormActions',
                children: [
                  h(primitives.Button, {
                    key: 'save',
                    variant: 'primary',
                    size: 'sm',
                    disabled: busy === true,
                    onClick: () =>
                      onSave({
                        model: draft.model.trim(),
                        peak: {
                          inputPerMillion: Number(draft.peakInput) || 0,
                          outputPerMillion: Number(draft.peakOutput) || 0,
                          cacheReadPerMillion: Number(draft.peakCache) || 0,
                        },
                        offpeak: {
                          inputPerMillion: Number(draft.offInput) || 0,
                          outputPerMillion: Number(draft.offOutput) || 0,
                          cacheReadPerMillion: Number(draft.offCache) || 0,
                        },
                      }),
                    children: '保存',
                  }),
                  h(primitives.Button, {
                    key: 'delete',
                    variant: 'ghost',
                    size: 'sm',
                    disabled: busy === true,
                    onClick: () => onDelete(model.id),
                    children: '删除',
                  }),
                ],
              }),
            ],
          }),
          hs('div', {
            key: 'tiers',
            className: 'jbTiers',
            children: [
              tierGroup('peak', '峰时', '工作日 09:00–12:00、14:00–18:00'),
              tierGroup('offpeak', '谷时', '其余时间、周末、法定节假日'),
            ],
          }),
        ],
      })
    }

    /**
     * 泽西额度卡：直接读中转站后台的剩余额度。
     *
     * 数据来自 Host 半边的 `/jersey-billing/balance`，它去调泽西的
     * OpenAI 兼容 billing 接口（`hard_limit_usd` 总额度 - `total_usage`/100 已用）。
     */
    function BalanceCard({ balance, currency, onRefresh, busy }) {
      const ok = balance !== undefined && balance.ok === true
      const remaining = ok ? balance.remaining : undefined
      const ratio =
        ok && balance.total > 0 ? Math.max(0, Math.min(1, balance.remaining / balance.total)) : 0
      const fillClass =
        ratio <= 0.1 ? 'jbBarFill jbBarFillError' : ratio <= 0.25 ? 'jbBarFill jbBarFillWarn' : 'jbBarFill'

      return hs('div', {
        className: 'jbBalance',
        children: [
          hs('div', {
            key: 'top',
            className: 'jbBalanceTop',
            children: [
              hs('div', {
                key: 'main',
                className: 'jbBalanceMain',
                children: [
                  h('span', { key: 'l', className: 'jbBalanceLabel', children: '泽西额度' }),
                  h('span', {
                    key: 'v',
                    className: 'jbBalanceValue',
                    children: ok ? formatMoney(remaining, currency) : '—',
                  }),
                  h('span', {
                    key: 'm',
                    className: 'jbBalanceMeta',
                    children: ok
                      ? `剩余 / 总额 ${formatMoney(balance.total, currency)} · 已用 ${formatMoney(balance.used, currency)}`
                      : balance === undefined
                        ? '读取中…'
                        : balance.error,
                  }),
                ],
              }),
              h(primitives.Button, {
                key: 'refresh',
                variant: 'ghost',
                size: 'sm',
                disabled: busy === true,
                onClick: onRefresh,
                children: '刷新额度',
              }),
            ],
          }),
          h('div', {
            key: 'bar',
            className: 'jbBar',
            children: h('div', {
              className: fillClass,
              style: { width: `${(ratio * 100).toFixed(2)}%` },
            }),
          }),
        ],
      })
    }

    /** 一张汇总卡。 */
    function Card({ label, value, hint }) {      return hs('div', {
        className: 'jbCard',
        children: [
          h('span', { key: 'l', className: 'jbCardLabel', children: label }),
          h('span', { key: 'v', className: 'jbCardValue', children: value }),
          hint === undefined || hint === ''
            ? null
            : h('span', { key: 'h', className: 'jbCardHint', children: hint }),
        ],
      })
    }

    // ── 面板主体 ──────────────────────────────────────────────────────
    /** 泽西计费统计面板。 */
    function BillingPanel() {
      const [range, setRange] = React.useState('today')
      const [scope, setScope] = React.useState('jersey')
      const [summary, setSummary] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [loading, setLoading] = React.useState(true)
      const [prices, setPrices] = React.useState(undefined)
      const [balance, setBalance] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [newModel, setNewModel] = React.useState('')

      /** 拉取汇总。 */
      const loadSummary = React.useCallback(async (target, which) => {
        try {
          const data = await getJson(
            `${ROUTE}/summary?window=${encodeURIComponent(target)}&scope=${encodeURIComponent(which)}`,
          )
          if (data.ok === false) {
            setError(data.error ?? '统计失败')
            setSummary(undefined)
          } else {
            setSummary(data)
            setError(undefined)
          }
        } catch (cause) {
          setError(`无法读取统计数据：${String(cause)}`)
        } finally {
          setLoading(false)
        }
      }, [])

      /** 拉取泽西额度。 */
      const loadBalance = React.useCallback(async (force) => {
        try {
          const data = await getJson(`${ROUTE}/balance${force === true ? '?force=1' : ''}`)
          setBalance(data)
        } catch (cause) {
          setBalance({ ok: false, error: `无法读取额度：${String(cause)}` })
        }
      }, [])

      /** 拉取价目表。 */
      const loadPrices = React.useCallback(async () => {
        try {
          const data = await getJson(`${ROUTE}/prices`)
          if (data.ok !== false) setPrices(data)
        } catch {
          /* 价目表读取失败不覆盖主错误 */
        }
      }, [])

      React.useEffect(() => {
        setLoading(true)
        loadSummary(range, scope)
        const timer = setInterval(() => loadSummary(range, scope), REFRESH_MS)
        return () => clearInterval(timer)
      }, [range, scope, loadSummary])

      React.useEffect(() => {
        loadPrices()
        loadBalance(false)
        // 额度变化慢，5 分钟拉一次即可。
        const timer = setInterval(() => loadBalance(true), 300000)
        return () => clearInterval(timer)
      }, [loadPrices, loadBalance])

      /** 保存一条价目。 */
      const savePrice = async (input) => {
        if (input.model.length === 0) return
        setBusy(true)
        try {
          await postJson(`${ROUTE}/prices`, input)
          await Promise.all([loadPrices(), loadSummary(range, scope)])
        } catch (cause) {
          setError(`保存价目失败：${String(cause)}`)
        } finally {
          setBusy(false)
        }
      }

      /** 删除一条价目。 */
      const deletePrice = async (model) => {
        setBusy(true)
        try {
          await postJson(`${ROUTE}/prices/delete`, { model })
          await Promise.all([loadPrices(), loadSummary(range, scope)])
        } catch (cause) {
          setError(`删除价目失败：${String(cause)}`)
        } finally {
          setBusy(false)
        }
      }

      const currency = summary?.currency ?? prices?.currency ?? '¥'
      const total = summary?.total
      const rows = summary?.rows ?? []
      const models = prices?.models ?? []

      /** 汇总卡区块。 */
      const cards = hs('div', {
        className: 'jbCards',
        children: [
          h(Card, {
            key: 'cost',
            label: '总花费',
            value: formatMoney(total?.cost ?? 0, currency),
            hint:
              summary === undefined
                ? ''
                : `${summary.attempts} 次请求 · ${summary.sessionCount} 个会话`,
          }),
          h(Card, {
            key: 'in',
            label: '未命中输入',
            value: formatCount(total?.inputTokens ?? 0),
            hint: formatCompact(total?.inputTokens ?? 0),
          }),
          h(Card, {
            key: 'cr',
            label: '缓存读取',
            value: formatCount(total?.cacheReadTokens ?? 0),
            hint: formatCompact(total?.cacheReadTokens ?? 0),
          }),
          h(Card, {
            key: 'cw',
            label: '缓存写入',
            value: formatCount(total?.cacheWriteTokens ?? 0),
            hint: formatCompact(total?.cacheWriteTokens ?? 0),
          }),
          h(Card, {
            key: 'out',
            label: '输出',
            value: formatCount(total?.outputTokens ?? 0),
            hint: formatCompact(total?.outputTokens ?? 0),
          }),
        ],
      })

      /** 明细表。 */
      const table =
        rows.length === 0
          ? h('div', {
              className: 'jbEmpty',
              children: loading ? '正在统计…' : '这个时间范围内还没有产生用量。',
            })
          : hs('table', {
              className: 'jbTable',
              children: [
                h('thead', {
                  key: 'head',
                  children: h('tr', {
                    children: COLUMNS.map((label) => h('th', { key: label, children: label })),
                  }),
                }),
                h('tbody', {
                  key: 'body',
                  children: rows.map((row) =>
                    hs('tr', {
                      key: `${row.provider}\u0000${row.model}`,
                      children: [
                        h('td', {
                          key: 'model',
                          children: hs('div', {
                            className: 'jbModel',
                            children: [
                              h('span', { key: 'n', className: 'jbModelName', children: row.model }),
                              h('span', {
                                key: 'p',
                                className: 'jbModelProv',
                                children: row.provider,
                              }),
                              row.peakAttempts + row.offpeakAttempts > 0
                                ? hs('span', {
                                    key: 's',
                                    className: 'jbSplit',
                                    children: [
                                      h('span', {
                                        key: 'pk',
                                        className: 'jbTierTag jbTierTagPeak',
                                        title: `峰时单价 ${formatMoney(row.tiers?.peak?.unitInput ?? 0, currency)} / 1M 输入`,
                                        children: `峰 ${row.peakAttempts} 次 ${formatMoney(row.peakCost, currency)}`,
                                      }),
                                      h('span', {
                                        key: 'op',
                                        className: 'jbTierTag',
                                        title: `谷时单价 ${formatMoney(row.tiers?.offpeak?.unitInput ?? 0, currency)} / 1M 输入`,
                                        children: `谷 ${row.offpeakAttempts} 次 ${formatMoney(row.offpeakCost, currency)}`,
                                      }),
                                    ],
                                  })
                                : null,
                            ],
                          }),
                        }),
                        h('td', { key: 'a', children: formatCount(row.attempts) }),
                        h('td', { key: 'i', children: formatCount(row.inputTokens) }),
                        h('td', { key: 'cr', children: formatCount(row.cacheReadTokens) }),
                        h('td', { key: 'cw', children: formatCount(row.cacheWriteTokens) }),
                        h('td', { key: 'o', children: formatCount(row.outputTokens) }),
                        h('td', {
                          key: 'c',
                          className: row.priced ? 'jbCost' : 'jbCost jbUnpriced',
                          children: formatMoney(row.cost, currency),
                        }),
                      ],
                    }),
                  ),
                }),
              ],
            })

      /** 单价编辑区。 */
      const editor = hs('div', {
        className: 'jbRows',
        children: [
          ...models.map((model) =>
            h(PriceRow, {
              key: model.id,
              model,
              currency,
              busy,
              onSave: savePrice,
              onDelete: deletePrice,
            }),
          ),
          models.length === 0
            ? h('div', {
                key: 'empty',
                className: 'jbFootnote',
                children: '还没有配置任何模型单价，请在下面添加。',
              })
            : null,
          hs('div', {
            key: 'add',
            className: 'jbFormActions',
            children: [
              h('input', {
                key: 'input',
                className: 'jbFieldInput',
                style: { maxWidth: '260px' },
                type: 'text',
                placeholder: '新增模型 ID，例如 deepseek-v4.1-flash',
                value: newModel,
                onChange: (event) => setNewModel(event.target.value),
              }),
              h(primitives.Button, {
                key: 'button',
                variant: 'ghost',
                size: 'sm',
                disabled: busy || newModel.trim().length === 0,
                onClick: () => {
                  const id = newModel.trim()
                  if (id.length === 0) return
                  setNewModel('')
                  savePrice({
                    model: id,
                    inputPerMillion: 0,
                    outputPerMillion: 0,
                    cacheReadPerMillion: 0,
                  })
                },
                children: '添加模型',
              }),
            ],
          }),
        ],
      })

      return h('div', {
        className: 'jbScroll',
        children: hs('div', {
          className: 'jbRoot',
          children: [
          hs('div', {
            key: 'head',
            className: 'jbHead',
            children: [
              hs('div', {
                key: 'title',
                children: [
                  h('h2', { key: 'h', className: 'jbTitle', children: '泽西计费统计' }),
                  h('p', {
                    key: 'p',
                    className: 'jbSub',
                    children: `${summary?.scope === 'jersey' ? '仅统计泽西（zexitongxue）' : '统计 DSH 全部会话'}的实时用量 · ${formatSince(summary?.since, summary?.window ?? range)}`,
                  }),
                ],
              }),
              hs('div', {
                key: 'actions',
                className: 'jbHeadActions',
                children: [
                  h('label', {
                    key: 'scope',
                    className: 'jbToggle',
                    title: '不勾选时统计全部 provider（含 DeepSeek 官方账号等）',
                    children: [
                      h('input', {
                        key: 'i',
                        type: 'checkbox',
                        checked: scope === 'jersey',
                        onChange: (event) => setScope(event.target.checked ? 'jersey' : 'all'),
                      }),
                      h('span', { key: 't', children: '只统计泽西' }),
                    ],
                  }),
                  h(primitives.SegmentedControl, {
                    key: 'range',
                    id: 'jersey-billing-window',
                    value: range,
                    options: WINDOW_OPTIONS,
                    onChange: setRange,
                    label: '统计时间范围',
                  }),
                  h(primitives.Button, {
                    key: 'refresh',
                    variant: 'ghost',
                    size: 'sm',
                    disabled: loading,
                    onClick: () => {
                      setLoading(true)
                      Promise.all([loadSummary(range, scope), loadPrices(), loadBalance(true)])
                    },
                    children: '刷新',
                  }),
                ],
              }),
            ],
          }),

          error === undefined
            ? null
            : h('div', { key: 'error', className: 'jbNotice jbNoticeError', children: error }),

          h(BalanceCard, {
            key: 'balance',
            balance,
            currency,
            busy,
            onRefresh: () => loadBalance(true),
          }),

          summary?.unpriced !== undefined && summary.unpriced.length > 0
            ? h('div', {
                key: 'unpriced',
                className: 'jbNotice jbNoticeWarn',
                children: `以下模型没有配置单价，已按默认模型「${summary.defaultModel}」计价：${summary.unpriced.join('、')}`,
              })
            : null,

          summary?.scope === 'jersey' &&
          summary?.skippedProviders !== undefined &&
          summary.skippedProviders.length > 0
            ? h('div', {
                key: 'skipped',
                className: 'jbNotice',
                children: `已排除非泽西的调用：${summary.skippedProviders.join('、')}（取消勾选「只统计泽西」可一并统计）`,
              })
            : null,

          h('div', { key: 'cards', children: cards }),

          hs('div', {
            key: 'detail',
            className: 'jbSection',
            children: [
              h('h3', { key: 't', className: 'jbSectionTitle', children: '按模型明细' }),
              h('div', { key: 'wrap', className: 'jbTableWrap', children: table }),
            ],
          }),

          hs('div', {
            key: 'pricing',
            className: 'jbSection',
            children: [
              hs('div', {
                key: 'head',
                className: 'jbSectionHead',
                children: [
                  h('h3', { key: 't', className: 'jbSectionTitle', children: '计费模型与单价' }),
                  h('span', {
                    key: 'n',
                    className: 'jbFootnote',
                    children:
                      prices?.persistent === false
                        ? '存储不可用：改动仅本次运行有效'
                        : '单价为每百万 token 价格，修改后立即生效',
                  }),
                ],
              }),
              h('div', {
                key: 'peakHint',
                className: 'jbFootnote',
                children:
                  'DeepSeek 系列按北京时间分峰谷：峰时（工作日 09:00–12:00、14:00–18:00）与谷时（其余时间、周末、法定节假日）单价不同。'
                  + '填「基准价 × 中转站倍率」的最终价，缓存输入价一般取输入价的 2%。'
                  + (summary?.calendarCovered === false
                    ? '⚠ 当前年份不在内置调休日历范围内，节假日判定可能不准。'
                    : ''),
              }),
              h('div', { key: 'wrap', className: 'jbTableWrap', children: editor }),
            ],
          }),
        ],
        }),
      })
    }

    // ── 插件入口 ──────────────────────────────────────────────────────
    /** 需要的浏览器服务。 */
    const inject = ['slots']

    /**
     * 注册侧边栏图标与主面板。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      // 侧边栏图标：点击后 layout.selectPanel('jersey-billing')。
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 40,
            label: () => '泽西计费',
          },
          PanelIcon,
        ),
      )

      // 主面板：key 必须与上面的 id 一致。
      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
          },
          BillingPanel,
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
