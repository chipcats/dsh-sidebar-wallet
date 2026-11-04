# CHANGELOG

## 0.2.0 — 2026-11-04

- 「今日消费」改为优先使用 DeepSeek 官方后台用量口径（platform usage export），本地会话日志估算退化为兜底（显示时带 `≈`）。
- 插件重命名为 `dsh-sidebar-wallet`，标题「侧边栏钱包 / Sidebar Wallet」（原 `dsh-balance-today`）。
- 读数固定到侧边栏账户行最右端；悬停显示口径、请求数、输入/缓存/输出 token 与峰谷倒计时。
- 只读 HTTP 路由增加回环/同源校验，并复用 DSH 的 `connection.requestRejection`。

## 0.1.0 — 2026-11-04

- 首个版本：在侧边栏底部显示 DeepSeek 余额与今日消费估算。
