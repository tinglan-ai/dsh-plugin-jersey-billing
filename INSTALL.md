# 安装说明（给同事）

## 前置条件

- 已经装好 DSH，能正常打开 Web 界面
- 你的 DSH 里配好了 itkk provider，baseURL 是 `https://itkk.lol/v1`，
  模型 `deepseek-v4.1-flash-1017`

## 安装

在 DSH 里对 AI 说这一句就行（把 `<仓库地址>` 换成实际地址）：

> 帮我安装这个 DSH 插件：`<仓库地址>`

AI 会用 `plugin_manager` 工具执行安装并启用。也可以自己在 DSH 的
**插件**页面里粘贴仓库地址安装。

如果你想用命令行，在 profile 目录执行：

```powershell
# profile 目录：C:\Users\<你的用户名>\.dsh\profiles\desktop
node <pnpm.mjs> add "github:<用户名>/<仓库名>"
```

然后确认 profile 的 `package.json` 里 `dsh.profile.bundles` 包含
`dsh-plugin-jersey-billing`，没有就手动加一行。

## 装完做什么

1. **重启 DSH**（替换包代码需要新进程才能加载新模块）
2. 侧边栏底部会出现**钱包图标**「计费统计」，点开是 `itkk 计费统计` 面板
3. 在「计费模型与单价」里确认单价（每百万 token），默认已经填好：
   - 输入 **0.1**
   - 输出 **0.4**
   - 缓存读取 **0.002**
   - 缓存写入 **0**
4. 点**保存**

单价存在 `C:\Users\<你的用户名>\.dsh\billing-prices.json`，改完立即生效、跨重启保留。

## 统计范围

插件**只统计一个 provider**，默认 `itkk`，配置在插件的 `cordis.patch.yml`：

```yaml
config:
  provider: 'itkk'
```

其他 provider（泽西、Znb、官方账号等）一律不计。面板上没有开关，
要换统计对象就改 `provider` 那一行然后重启 DSH。

如果你的账号名不叫 `itkk`，改成你日志里 `request/header` 记录的 provider 值。

## 面板说明

顶部四个时间窗口：**今天 / 本周 / 本月 / 全部**，默认今天，每 15 秒自动刷新。

五张汇总卡：总花费、未命中输入、缓存读取、缓存写入、输出。

下面的表格按模型列出请求数、四类 token 和花费，每个模型还会显示它当前用的输入 / 输出单价。

## 注意

- **统计的是本地会话日志，不是中转站服务端账单。** 正常情况下两者一致；
  日志被清理或某次请求未落盘时会偏少。
- **删掉会话不会丢账**：用量按天存进 `~/.dsh/billing-ledger.json`，
  删了会话历史花费仍然保留。面板会提示「已保留 N 个已删除会话的历史计费」。
- **没有配单价的模型整条跳过**，不会回退到别的模型的价格去估算，
  面板顶部会列出被跳过的模型。
- **导入型会话**（provider 是 `codex-sync` 之类）没有 token 用量，会计为 0。
- **不显示剩余额度**：中转站的 billing 接口普遍不完整，插件只统计花费。
- **改插件代码后必须重启 DSH 进程**，只重载配置不够。
