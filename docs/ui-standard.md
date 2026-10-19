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

## 通用约束

- 颜色只用 `--dsw-alias-*` / `--dsw-specific-*` 主题 token，不写死色值（阴影除外）；
- 不使用客户端构建里不存在的 React API（如 `useSyncExternalStore`）；
- 不用空 `catch` 吞掉 UI 动作的异常，失败要 `console.warn`。
