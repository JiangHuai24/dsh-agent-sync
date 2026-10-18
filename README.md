# dsh-agent-sync

把本机上其他 AI 编程助手的会话，实时镜像成 **DeepSeek Harness（DSH）** 的任务；每个应用自动分到自己的工作区，工作区名字就是应用名。

> Mirror other coding agents' sessions (WorkBuddy, ZCode, Codex, …) into DeepSeek Harness as live tasks — one workspace per application, named after the application.

---

## 它解决什么问题

你在 WorkBuddy / ZCode / Codex 里干过的活，原本散落在各自的应用里。这个插件把它们**变成 DSH 里可读、可续聊的任务**，并且：

- **实时**：外部应用每产生一轮新对话，几秒内追加到对应的 DSH 任务里；
- **分应用**：`WorkBuddy`、`ZCode`、`Codex` 各有独立工作区，互不混杂；
- **可续聊**：镜像出来的是真正的 DSH 会话，可以直接在里面接着问；
- **不打扰**：一旦你在 DSH 里接管了某个任务，该来源自动停止同步，不会两边互相覆盖。

## 工作方式

```
WorkBuddy  ~/.workbuddy/projects/**/*.jsonl ─┐
ZCode      ~/.zcode/cli/db/db.sqlite        ─┼─▶ 适配器 ─▶ 轮次切分 ─▶ sessionPersistence
Codex      ~/.codex/sessions/**/*.jsonl     ─┘                           │
                                                                          ▼
                                        每应用一个工作区（标题=应用名）◀── attachSession
```

三个关键设计：

1. **只追加已封口的轮次**。一轮对话在"出现下一条用户消息"或"静默超过 `sealAfterMs`"之后才写入，因此日志永远是追加式的，不需要回头改写。
2. **走 Harness 自己的写入路径**。通过 `sessionPersistence.create/append/flush` 落盘、`Workspace.attachSession` 加入工作区，而不是手工造文件或改 `workspace.json`。
3. **标题事件必须引用消息**。非 user 来源的 `session/title` 必须带上 `messageSeqs`，否则整条日志会被判为 corrupt、读不出来——这是本插件开发中踩过的最大一个坑。

## 安装

插件是一个 DSH bundle。在 Harness 里用插件管理器安装这个目录即可：

```text
plugin_manager  action=install_bundle  target=<本仓库目录的绝对路径>
```

或者直接放进 profile 的 bundle 列表后用 `dsh plugin add <path>`（取决于你的 DSH 版本）。

安装后插件行 id 为 `agent-sync`，可在 `cordis.patch.yml` 里改配置。

## 配置

```yaml
- insert:
    - id: agent-sync
      name: '@local/agent-sync'
      config:
        pollMs: 3000
        sealAfterMs: 12000
        maxSessionsPerApp: 0
        maxFilesPerApp: 4000
        scanEveryMs: 5000
        missingGraceMinutes: 30
        workspacesRoot: ''
        onlyApps: []
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `pollMs` | `3000` | 轮询间隔（毫秒），最小 500 |
| `sealAfterMs` | `12000` | 会话静默多久后视为"这一轮结束"，最小 1000 |
| `maxSessionsPerApp` | `0` | 每个应用最多同步多少个会话，`0` = 全量 |
| `maxFilesPerApp` | `4000` | 每个应用最多扫描多少个候选文件 |
| `scanEveryMs` | `5000` | 重新扫描文件列表的间隔 |
| `missingGraceMinutes` | `30` | 源会话消失多久后归档对应任务 |
| `workspacesRoot` | 空 | 工作区根目录；空 = 默认工作区的父目录下 `agent-sync-workspaces` |
| `onlyApps` | `[]` | 只同步这些应用 id |
| `stateFile` | 空 | 覆盖状态文件位置（测试/便携安装用） |
| `apps.<id>` | — | 单应用覆盖：`enabled: false`、`roots: [...]` |

示例：只同步 WorkBuddy 和 ZCode，并把工作区放到 D 盘：

```yaml
config:
  onlyApps: ['workbuddy', 'zcode']
  workspacesRoot: 'D:\agent-sync-workspaces'
```

## 支持的应用

插件内置 14 个应用的候选数据目录。**只对实际存在且能扫到会话的应用生效**，不会产生空工作区。

| id | 应用 | 数据来源 | 解析器 |
| --- | --- | --- | --- |
| `workbuddy` | WorkBuddy | `~/.workbuddy` | Claude 风格 JSONL + 应用 SQLite 标题库 |
| `workbuddy-ai` | WorkBuddy AI | `~/.workbuddy-ai` | 同上 |
| `zcode` | ZCode | `~/.zcode/cli/db/db.sqlite` | SQLite（message + part） |
| `codex` | Codex | `~/.codex/sessions` | Codex rollout JSONL |
| `codebuddy` | CodeBuddy | `~/.codebuddy`、`%APPDATA%\CodeBuddy` | Claude 风格 JSONL |
| `loomy` | Loomy | `~/.loomy`、`%APPDATA%\Loomy` 等 | Claude 风格 JSONL |
| `raccoon` | Raccoon | `~/.raccoon`、`%APPDATA%\Raccoon` 等 | Claude 风格 JSONL |
| `minimax` | MiniMax | `~/.minimax`、`%APPDATA%\MiniMax` 等 | Claude 风格 JSONL |
| `trae` | TRAE | `~/.trae`、`%APPDATA%\Trae` | Claude 风格 JSONL |
| `qoder` | Qoder | `~/.qoder`、`%APPDATA%\Qoder` | Claude 风格 JSONL |
| `cline` | Cline | `~/.cline`、`%APPDATA%\Cline` | Claude 风格 JSONL |
| `codearts` | CodeArts | `~/.codearts`、`%APPDATA%\CodeArts` | Claude 风格 JSONL |
| `lobster` | LobsterAI | `~/.lobster`、`%APPDATA%\LobsterAI` 等 | Claude 风格 JSONL |
| `gemini` | Gemini | `~/.gemini` | Claude 风格 JSONL |

> 未安装的应用不会产生任何工作区。若某应用已安装但存储格式不同，它会在状态文件的 `scanned` 里显示 0，而不是静默失败——按需补一个解析器即可。

## 侧边栏刷新按钮

插件在 `sidebar.footer.action` 注册了一个「刷新任务列表」按钮：点击会重新加载页面，拉取刚写入的会话与标题。

之所以需要它：侧边栏的会话列表是客户端的运行时状态，**追加到已有任务**不会触发列表重绘（点进任务内容是新的）。新建任务通常会自动出现，改名和增量更新以按钮为准。

## 状态与排错

| 文件 | 内容 |
| --- | --- |
| `$DSH_HOME/storages/agent-sync/status.json` | 每次轮询的应用、扫描数、每个来源的标题/轮数/错误 |
| `$DSH_HOME/storages/agent-sync/state.json` | 镜像记账：id、已同步轮数、事件数、是否已脱管 |

排错顺序：先看 `status.json` 的 `apps[].error` 和 `sources[].error`，再看 Host 日志里的 `[agent-sync]` 前缀行。

## 已知限制

- **只读镜像**：不会把 DSH 里的新对话写回原应用。
- **脱管即停**：在 DSH 里打开/续聊某个镜像任务后（应用会追加续接事件），该来源停止同步——这是为了避免两个写者抢同一条日志。
- **仅文本**：工具调用、图片、附件不入镜像，只保留用户与助手的文本。
- **未验证的格式**：除 WorkBuddy / ZCode / Codex 外，其余应用的解析器是通用 Claude-JSONL 兜底，未在真实数据上验证。

## 开发与测试

```bash
# 纯逻辑 + 契约测试（Node ≥ 22）
node --test test/core.test.mjs
node --test test/format.test.mjs   # 需要本机安装 DSH，或用 DSH_SESSION_LIB 指定

# 引擎集成测试：内存版 persistence/registry，不碰真实数据
node --test test/engine.test.mjs
```

测试覆盖：三个解析器、轮次切分、事件构造、增量读取（含半行与截断）、裁剪计数、退避与缺失扫描、DSH 格式契约、以及完整同步循环（建工作区 → 建镜像 → 追加轮次）。

## License

MIT © 2026

---

## English

**dsh-agent-sync** mirrors the sessions of other coding agents on your machine into DeepSeek Harness as ordinary, continuable tasks — one workspace per application, titled after the application.

- Append-only mirroring of *sealed* turns.
- Writes through `sessionPersistence` and `attachSession`; never edits `workspace.json`.
- Titles prefer the application's own session index (e.g. WorkBuddy's SQLite) over stale transcript titles.
- Stops mirroring a source once DSH adopts that session, so two writers never collide.
- Adds a "Refresh tasks" action under the sidebar footer.

Configure via the `agent-sync` row in `cordis.patch.yml`; see the table above.
