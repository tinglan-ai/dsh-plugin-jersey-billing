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
.jbRoot{display:flex;flex-direction:column;gap:16px;padding:20px 24px 40px;max-width:1080px;color:var(--dsw-alias-label-primary);box-sizing:border-box;width:100%}
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
    /** 一行价目：模型 id + 三个单价 + 保存/删除。 */
    function PriceRow({ model, currency, onSave, onDelete, busy }) {
      const [draft, setDraft] = React.useState({
        model: model.id,
        inputPerMillion: String(model.inputPerMillion ?? 0),
        outputPerMillion: String(model.outputPerMillion ?? 0),
        cacheReadPerMillion: String(model.cacheReadPerMillion ?? 0),
      })

      React.useEffect(() => {
        setDraft({
          model: model.id,
          inputPerMillion: String(model.inputPerMillion ?? 0),
          outputPerMillion: String(model.outputPerMillion ?? 0),
          cacheReadPerMillion: String(model.cacheReadPerMillion ?? 0),
        })
      }, [model.id, model.inputPerMillion, model.outputPerMillion, model.cacheReadPerMillion])

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

      return hs('div', {
        className: 'jbForm',
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
          numberField('inputPerMillion', `输入 / 1M（${currency}）`),
          numberField('outputPerMillion', `输出 / 1M（${currency}）`),
          numberField('cacheReadPerMillion', `缓存输入 / 1M（${currency}）`),
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
                    inputPerMillion: Number(draft.inputPerMillion) || 0,
                    outputPerMillion: Number(draft.outputPerMillion) || 0,
                    cacheReadPerMillion: Number(draft.cacheReadPerMillion) || 0,
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
      })
    }

    /** 一张汇总卡。 */
    function Card({ label, value, hint }) {
      return hs('div', {
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
      const [summary, setSummary] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [loading, setLoading] = React.useState(true)
      const [prices, setPrices] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [newModel, setNewModel] = React.useState('')

      /** 拉取汇总。 */
      const loadSummary = React.useCallback(async (target) => {
        try {
          const data = await getJson(`${ROUTE}/summary?window=${encodeURIComponent(target)}`)
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
        loadSummary(range)
        const timer = setInterval(() => loadSummary(range), REFRESH_MS)
        return () => clearInterval(timer)
      }, [range, loadSummary])

      React.useEffect(() => {
        loadPrices()
      }, [loadPrices])

      /** 保存一条价目。 */
      const savePrice = async (input) => {
        if (input.model.length === 0) return
        setBusy(true)
        try {
          await postJson(`${ROUTE}/prices`, input)
          await Promise.all([loadPrices(), loadSummary(range)])
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
          await Promise.all([loadPrices(), loadSummary(range)])
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

      return hs('div', {
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
                    children: `统计 DSH 全部会话的实时用量 · ${formatSince(summary?.since, summary?.window ?? range)}`,
                  }),
                ],
              }),
              hs('div', {
                key: 'actions',
                className: 'jbHeadActions',
                children: [
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
                      Promise.all([loadSummary(range), loadPrices()])
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

          summary?.unpriced !== undefined && summary.unpriced.length > 0
            ? h('div', {
                key: 'unpriced',
                className: 'jbNotice jbNoticeWarn',
                children: `以下模型没有配置单价，已按默认模型「${summary.defaultModel}」计价：${summary.unpriced.join('、')}`,
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
              h('div', { key: 'wrap', className: 'jbTableWrap', children: editor }),
            ],
          }),
        ],
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
