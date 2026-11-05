# 预览图生成

`assets/preview.png` 不是截图，而是 **`preview.html` 用无头 Edge/Chrome 渲染出来的示例图**（示例数据），
再由 `make-preview.mjs` 裁掉多余背景得到。

## 用法

```bash
node tools/preview/make-preview.mjs
# 或
npm run preview
```

要求：Node ≥ 20 + 本机安装 Microsoft Edge（或 Chrome/Chromium）。**无任何 npm 依赖**。

可选参数：

| 参数 | 说明 |
| --- | --- |
| `--out <file>` | 输出路径，默认 `assets/preview.png` |
| `--scale <n>` | 渲染倍率，默认 `2`（最高 4） |
| `--html <file>` | 换成别的 HTML，默认本目录的 `preview.html` |
| `--edge <exe>` | 指定浏览器可执行文件（也可用环境变量 `EDGE_PATH`/`CHROME_PATH`） |

## 改图

直接编辑 `preview.html` 里的示例数值/文案/样式，然后重新跑上面的命令即可。

## 说明

- 这个目录**不在** `package.json` 的 `files` 白名单里，所以从 GitHub / npm 安装插件时不会带上这些脚本，只影响仓库本身；
- 生成过程只做「渲染 → 按背景色裁边 → 写 PNG」，不联网、不执行插件代码。
