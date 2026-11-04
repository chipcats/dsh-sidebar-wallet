# 侧边栏钱包 · dsh-sidebar-wallet

在 DeepSeek Harness 侧边栏底部**账户行（头像那一行）的最右端**显示一行小字：余额与今日消费。

```
余额 ¥3.85 · 今日 ¥17.86
```

> 今日消费取 DeepSeek 官方后台口径（与网页控制台「用量」页一致，北京时间 0 点起算）；只有官方口径不可用时才回退本机会话日志估算，并带 `≈` 前缀。

## 功能

- **余额**：官方口径。优先用已保存的 `DEEPSEEK_API_KEY` 调 `GET /user/balance`，取不到时退回当前登录的 DeepSeek 账号钱包。
- **今日消费**：DeepSeek 后台官方用量口径（北京时间 0 点起算），显示为 `今日 ¥17.86`；官方不可用时回退本机会话日志估算（`今日 ≈¥3.90`）。
- **悬停**：余额更新时间/来源、今日消费口径与请求数、输入/缓存命中/输出 token、当前峰谷时段与倒计时。
- **点击**：立即刷新（余额 + 官方用量）。
- **收起侧边栏**时不显示；无配置项、无设置页、全程只读。

## 安装

要求：DeepSeek Harness ≥ 0.2.1-rc.1（已在 0.2.1-rc.5 桌面 profile 实测）。

```bash
# 从 GitHub 安装（推荐，锁 tag）
dsh plugin --profile desktop add github:chipcats/dsh-sidebar-wallet#v0.2.0

# 从本地目录安装
dsh plugin --profile desktop add link:/path/to/dsh-sidebar-wallet
```

把 `desktop` 换成你的 profile 名（Web 版通常是 `web`），装好后刷新页面即可看到。

npm 包发布后也可以：

```bash
dsh plugin --profile desktop add dsh-sidebar-wallet
```

## 今日消费的两个口径

| 口径 | 数据来源 | 认证 | 说明 |
| --- | --- | --- | --- |
| 官方（默认） | `platform.deepseek.com/api/v0/usage/export?start&end&tz=0`（ZIP 内 CSV：`type` + `amount` + `price`），按北京时间窗口求和 `price × amount` | 网页登录态 userToken；插件通过 DSH 已登录账号的 `deepseekAccount.getPlatformSession()` 直接取用，**无需手动粘贴 token** | 与后台控制台数字一致，按量计费全量（含其他客户端用同一账户/Key 的调用） |
| 本地估算（兜底） | DSH 本机会话日志里每条 `assistant/message` 的 token 用量 | 无 | 只有本机 DSH 发起的调用，通常明显低于官方数字；仅在官方不可用时显示 |

> **私有接口**：`api/v0/usage/*` 是 platform.deepseek.com 的网页私有接口，非官方公开 API，可能随时调整；失败时自动回退到本地估算，不会让读数消失。

## 兼容性

| 依赖 | 说明 |
| --- | --- |
| DeepSeek Harness | `engines.dsh` = `>=0.2.1-rc.1 <0.3.0-0`；实测 0.2.1-rc.5（桌面 profile） |
| Node | ≥ 20（只使用 `node:zlib`，无第三方运行时依赖） |
| 浏览器半区 | 走 `dsh.client` 体系（`platform: web`），不依赖任何客户端包 |
| 宿主能力 | `webServer`、`deepseekAccount`、`credentials`、`sessionQuery`、`session/event`、`sidebar.footer.action` 插槽；缺失时降级而不是报错 |

## 隐私与安全

本插件需要读取账户余额与用量，特此说明（便于安全审计核对）：

- **网络请求只有两个域名**：`https://api.deepseek.com/user/balance`（余额，凭 `DEEPSEEK_API_KEY`）与 `https://platform.deepseek.com/api/v0/usage/export`（官方用量，凭 DSH 已登录账号的会话令牌）。没有其他外发请求，没有遥测、没有埋点。
- **令牌来源**：通过 DSH 自己的 `deepseekAccount.getPlatformSession()` 取得当前登录账号的会话令牌，只在 Host 进程内存中使用，**不下发浏览器、不落盘、不打印**。
- **本地数据只读**：兜底估算只读取 DSH 会话日志里的 token 用量（不读消息内容）。
- **HTTP 路由**：只注册一个只读 `GET /dsh-sidebar-wallet/state.json`；仅允许回环/同源请求，并复用 DSH 自己的 `connection.requestRejection`。确需反代/局域网访问时，用 `DSH_BALANCE_TRUSTED_HOSTS`（逗号分隔 `host:port`）显式放行。
- **无写入**：插件不写文件、不改配置、不执行子进程。

## 实现

| 文件 | 职责 |
| --- | --- |
| `index.js` | Host 半区：余额抓取、官方用量导出（ZIP/CSV 解析）、会话日志回放兜底、`session/event` 实时累计、只读路由 `GET /dsh-sidebar-wallet/state.json` |
| `client.js` | 浏览器半区：注册到 `sidebar.footer.action`，把读数定位到下方账户行右端；每分钟轮询 |
| `cordis.patch.yml` | 把插件行插入 profile 加载树 |

布局说明：`sidebar.footer.action` 只分配「账户行之上」的那一行，所以本插件在该行放一个 0 尺寸锚点，再从自身祖先里量出侧边栏列与账户行的几何，把读数固定定位到账户行右端（量不到时退化为侧边栏右下角）。不改动、不替换宿主控件。

## 已知限制

- 官方今日消费按北京时间窗口统计；若未登录 DeepSeek 账号，只能显示本地估算（`≈`）。
- 官方口径是该账户下全部 API 调用，不区分 API Key 或来源客户端。
- 峰谷计价表与法定节假日表只用于本地估算与倒计时，官方数字已含实际计价，不受影响；节假日表当前覆盖 2026 年。
- 官方用量最多滞后约一分钟（平台统计本身有延迟）。

## 卸载

在「插件」页卸载 `dsh-sidebar-wallet`，或从 profile 的 `dsh.profile.bundles` 移除后重启。

## 许可证

[MIT](./LICENSE)
