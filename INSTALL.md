# 安装说明（给同事）

## 前置条件

- 已经装好 DSH，能正常打开 Web 界面
- 你的 DSH 里配好了 Znb（`znb-gongsi`）provider，baseURL 是 `https://znbcode.com/v1`

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

然后启用 bundle：

```
plugin_manager action=set_bundle target=dsh-plugin-jersey-billing enabled=true
```

## 装完做什么

1. **重启 DSH**（替换包代码需要新进程才能加载新模块）
2. 侧边栏底部会出现**钱包图标**，点开是「Znb 计费统计」面板
3. 在「计费模型与单价」里确认单价（每百万 token），默认已经填好：
   - 输入 **0.30**
   - 输出 **1.20**
   - 缓存读取 **0.006**
   - 缓存写入 **0**（Znb 不收费）
4. 点**保存**

单价存在 `C:\Users\<你的用户名>\.dsh\znb-billing.json`，改完立即生效、跨重启保留。

## 统计范围

插件**只统计 provider = `znb-gongsi`** 的调用，这条规则写死，面板上没有开关。

- `znbcode`（同一站点上的另一个账号）→ 不统计
- 泽西、DeepSeek 官方账号、其他中转站 → 不统计

被排除的 provider 会列在面板顶部，方便你确认没算错。

如果你的账号名不叫 `znb-gongsi`，需要改 `lib/index.js` 里的 `ZNB_PROVIDER` 常量。

## 面板说明

顶部四个时间窗口：**今天 / 本周 / 本月 / 全部**，默认今天，每 15 秒自动刷新。

五张汇总卡：总花费、未命中输入、缓存读取、缓存写入、输出。

下面的表格按模型列出请求数、四类 token 和花费，每个模型还会显示它当前用的输入 / 输出单价。

## 注意

- **统计的是本地会话日志，不是 Znb 服务端账单。** 正常情况下两者一致；
  日志被清理或某次请求未落盘时会偏少。
- **删掉会话不会丢账**：用量按天存进 `~/.dsh/znb-billing-ledger.json`，
  删了会话历史花费仍然保留。面板会提示「已保留 N 个已删除会话的历史计费」。
- **没有配单价的模型整条跳过**，不会回退到别的模型的价格去估算，
  面板顶部会列出被跳过的模型。
- **导入型会话**（provider 是 `codex-sync` 之类）没有 token 用量，会计为 0。
- **Znb 没有额度查询接口**（`/v1/dashboard/billing/*` 返回 404），所以面板不显示剩余额度。
- **改插件代码后必须重启 DSH 进程**，只重载配置不够。
