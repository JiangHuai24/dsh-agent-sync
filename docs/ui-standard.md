# UI 统一标准

DSH 插件界面共用一套尺寸与交互约定。新增插件请直接照做，不要另起一套数值。

## 侧边栏底部动作（`sidebar.footer.action`）

三个按钮（搜索 / ↑ GitHub / 刷新）现在统一为：

| 项目 | 数值 |
| --- | --- |
| 高度 | `28px` |
| 最小宽度 | `28px`（纯图标正好 28×28） |
| 水平内边距 | `6px`（纯图标用 `0`） |
| 图标尺寸 | `16px` |
| 图标与文字间距 | `6px` |
| 圆角 | `6px` |
| 字号 | `12px` |
| 行高 | `1` |
| 默认颜色 | `--dsw-alias-label-secondary` |
| 激活/悬停 | 文字 `--dsw-alias-label-primary`，背景 `--dsw-alias-interactive-bg-hover` |
| 边框 | 无 |

### 参考实现

每个客户端 bundle 内联同一份规格（浏览器侧没有模块解析器，只能 `require('react')`，所以不能跨文件 import）：

```js
const FOOTER_BUTTON = {
  height: 28,
  minWidth: 28,
  padding: '0 6px',
  paddingIconOnly: 0,
  gap: 6,
  radius: 6,
  fontSize: 12,
  iconSize: 16,
}

function footerButtonStyle(active, colors) {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: FOOTER_BUTTON.gap,
    height: FOOTER_BUTTON.height,
    minWidth: FOOTER_BUTTON.minWidth,
    padding: FOOTER_BUTTON.padding,
    background: active ? colors.hover : 'transparent',
    border: 'none',
    borderRadius: FOOTER_BUTTON.radius,
    cursor: 'pointer',
    color: active ? colors.primary : colors.secondary,
    font: 'inherit',
    fontSize: FOOTER_BUTTON.fontSize,
    lineHeight: 1,
    whiteSpace: 'nowrap',
  }
}
```

用法：

```js
// 纯图标
h('button', { style: footerButtonStyle(open, colors) },
  h(Icon, { path: [...], size: FOOTER_BUTTON.iconSize }))

// 图标 + 短标签
h('button', { style: footerButtonStyle(open, colors) },
  h(Icon, { path: [...], size: FOOTER_BUTTON.iconSize }),
  h('span', null, 'GitHub'))
```

### 图标的「光学尺寸」

同一 `iconSize` 不等于同一视觉大小：每个图标在 `viewBox="0 0 24 24"` 里实际占的跨度必须接近 **18 个单位**。

| 图标 | 路径跨度 | 说明 |
| --- | --- | --- |
| 放大镜 | 约 17–18 | `M11 4a7 7…` 圆 + 手柄 |
| 刷新 | 约 18 | 整圆环 |
| 上箭头 | 17（`M12 20.5V3.5` + 宽 17 的箭头） | 早期版本只占 14，显得小一圈 |

新图标落地前先量一下路径包围盒：跨度明显小于 18 就把路径放大，而不是调 `iconSize`（那样会让整个按钮错位）。

描边统一 `strokeWidth: 2`，`strokeLinecap/Linejoin: round`，SVG 设 `display: block` 以脱离文本基线。

## 设置页表单与向导

设置页不是只读状态面板，必须能改配置并落盘。参照 `meow-memory` 的做法：

| 部件 | 规格 |
| --- | --- |
| 分组标题 | 12px / 600 / secondary，上间距 20px |
| 字段行 | 左侧标签 200px + 右侧控件，底部 1px 分隔，上下 10px |
| 开关 | 34×18 圆角胶囊，滑块 14px |
| 数字输入 | 宽 96px，右对齐，可带单位后缀 |
| 保存栏 | 主按钮 28px 高，未改动时禁用；旁边「还原」 |

### 设置向导（防呆）

参考 `gh auth login` 与 `create-vite` 的分步模式：

- **一次只问一个决定**，不要把所有字段堆在一屏；
- 顶部进度条显示 `当前/总数`；
- 每步可给 `canAdvance` 校验，不满足就禁用「下一步」；
- 最后一步必须有**只读核对区**（脚本路径、仓库、凭据来源），让用户确认再落盘；
- 首次进入自动展开，完成后用 `localStorage` 记录，并提供「重新运行设置向导」入口。

## 可读性要求

- **纯图标必须**同时给 `title`（tooltip）和 `aria-label`；
- 带文字时 `title` 写更完整的说明；
- 文案优先「图标 + 短词」（如 `↑ GitHub`），不要长句。

## 设置页（`settings.section`）

| 项目 | 数值 |
| --- | --- |
| 标题 | `16px`，`--dsw-alias-label-primary` |
| 正文/说明 | `12px`，`--dsw-alias-label-secondary`，行高 `1.6` |
| 标签列宽 | `88px` |
| 行分隔 | `1px solid --dsw-alias-border-l1` |
| 按钮 | 高 `28px`，圆角 `6px`，字号 `12px`，透明底 + 1px 边框 |
| 内容最大宽度 | `720px` |

## 浮层面板（`shell.overlay`）

| 项目 | 数值 |
| --- | --- |
| 根节点 | `position: fixed; inset: 0; pointer-events: auto`（overlay 默认 click-through） |
| 面板圆角 | `12px` |
| 面板边框 | `1px solid --dsw-alias-border-l2` |
| 阴影 | `0 16px 48px rgba(0,0,0,0.35)` |
| 宽度 | `min(560–680px, 90–92vw)` |
| 顶部留白 | `10–12vh` |
| 关闭 | `Esc` / 点击遮罩 |

## 客户端 bundle 的缓存陷阱

所有插件的 `client.js` 会被拼成**一个脚本**下发，且资源 URL 的 `rev` 由**文件元数据**决定：

```
rev = sha1(mtimeMs, ctimeMs, size)   // 不是内容哈希
```

由此有两种必然踩到的坑：

1. **改坏了但 mtime/size 变了** → 得到新的 rev，浏览器刷新会去拉这个坏版本；重启走另一条路径重新解析，于是「重启就好、刷新就崩」。
2. **内容改了但 mtime/size 没变** → rev 不变，浏览器继续用旧缓存。

因此改完 `client.js` 后必须：**先跑 `npm test`（含 bundle gate）确认可解析且能渲染，再 `touch` 文件刷新 mtime**，让新 rev 一定对应磁盘上的字节。

另一条只在这种拼接模式下才暴露的故障：**两个插件声明了同名顶层标识符**，会让整个页面脚本 SyntaxError。gate 的 `combo` 检查专门防这个。

## 配置文件写入规范

改 `cordis.patch.yml` 这类用户配置文件时，**必须**满足以下五条（参考 `kuaiyukuaikuai/dsh-agent-sync` 的实现）：

| 要求 | 原因 |
| --- | --- |
| **托管区块标记** | 用 `# --- xxx managed ---` 包住自己写的内容，重写只替换区块，绝不碰用户手写内容 |
| **原子写入** | 先写 `.tmp-<pid>-<ts>` 再 `rename`，进程中途被杀也不会留下截断文件 |
| **写前备份** | 首次修改前复制一份 `*.backup`，出问题可手工回滚 |
| **结构校验** | 写前确认结果仍是以 `- ` 开头的条目列表，否则拒绝写入 |
| **层级优先** | 有 `DSH_PROFILE_DIR` 时写 profile 层，打包目录里的 patch 只作兜底 |

反面教材（本项目真实事故）：

- 用正则整块替换 config，把 `sources:` 和注释吞掉；
- 直接 `writeFileSync(file, ...)`，写一半崩溃就是坏文件；
- 打包目录优先，导致保存写进了包里而不是用户 profile；
- 没校验结构，把 `[]` 这种非法根节点又写回去。

`test/safety.gate.mjs` 会对上述每一条做静态检查 + 临时 profile 往返测试，`npm test` 必须全绿。

## 通用约束

- 颜色只用 `--dsw-alias-*` / `--dsw-specific-*` 主题 token，不写死色值（阴影除外）；
- 不使用客户端构建里不存在的 React API（如 `useSyncExternalStore`）；
- 不用空 `catch` 吞掉 UI 动作的异常，失败要 `console.warn`。
