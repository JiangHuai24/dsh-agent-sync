window.__ModuleLoader__.load({
  id: '@local/agent-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const zh = typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language || '')
    const text = {
      refresh: zh ? '刷新任务列表' : 'Refresh tasks',
      refreshHint: zh ? '重新加载页面，拉取其他 Agent 刚写入的会话' : 'Reload the page to pull sessions other agents just wrote',
      search: zh ? '搜索会话' : 'Search sessions',
      searchHint: zh ? '按会话名称或消息关键词搜索（Ctrl+K）' : 'Search by session title or message keywords (Ctrl+K)',
      placeholder: zh ? '搜索会话名称或消息内容…' : 'Search session titles or message content…',
      empty: zh ? '没有匹配的会话' : 'No matching sessions',
      typing: zh ? '开始输入以搜索' : 'Type to search',
      content: zh ? '匹配消息' : 'Message match',
      title: zh ? '标题匹配' : 'Title match',
      settingsTitle: zh ? '外部会话同步' : 'Agent Session Sync',
      settingsHint: zh ? '其他 AI 助手的会话会实时镜像成任务，每个应用一个工作区。' : 'Sessions from other coding agents are mirrored as tasks, one workspace per app.',
      mirrored: zh ? '镜像任务' : 'Mirrored',
      appsLabel: zh ? '应用' : 'Apps',
      errorsLabel: zh ? '错误' : 'Errors',
      orphanedLabel: zh ? '来源已消失（已保留）' : 'Source gone (kept)',
      backup: zh ? '备份镜像' : 'Back up mirrors',
      backing: zh ? '备份中…' : 'Backing up…',
      backupDone: zh ? '备份完成' : 'Backup complete',
      reload: zh ? '刷新数据' : 'Reload',
      workspaceRoot: zh ? '工作区根目录' : 'Workspaces root',
      scanned: zh ? '扫描' : 'scanned',
    }

    /* ------------------------------------------------------------------ */
    /* Shared open state: one action toggles, one overlay renders.        */
    /* ------------------------------------------------------------------ */

    const listeners = new Set()
    let isOpen = false
    let ctxRef
    let services = {}
    const subscribe = (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
    const getOpen = () => isOpen
    const setOpen = (next) => {
      if (isOpen === next) return
      isOpen = next
      for (const fn of listeners) fn()
    }

    // ---- shared footer-action spec (see docs/ui-standard.md) ----

    /** Shared footer-action metrics: one spec, applied to every plugin. */
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

    const colors = {
      panel: 'var(--dsw-alias-bg-overlay)',
      border: 'var(--dsw-alias-border-l2)',
      borderSoft: 'var(--dsw-alias-border-l1)',
      primary: 'var(--dsw-alias-label-primary)',
      secondary: 'var(--dsw-alias-label-secondary)',
      tertiary: 'var(--dsw-alias-label-tertiary)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      active: 'var(--dsw-alias-interactive-bg-active)',
    }

    function Icon({ path, size = 16 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { flex: 'none', display: 'block' },
        },
        ...path.map((d, index) => h('path', { key: index, d })),
      )
    }

    function useOpenState() {
      const [open, setOpenState] = React.useState(getOpen())
      React.useEffect(() => {
        const listener = () => setOpenState(getOpen())
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return open
    }

    function normalizeSessions(snapshot) {
      if (!snapshot) return []
      let values
      // The session store snapshot is `{ byId, ids, phase, ... }` — none of its
      // top-level values is a session row, so `Object.values` would yield
      // nothing and the local (live) title index stayed permanently empty.
      // That made renaming a mirrored task silently unsearchable.
      if (Array.isArray(snapshot)) values = snapshot
      else if (typeof snapshot.values === 'function' && typeof snapshot.get === 'function') values = [...snapshot.values()]
      else if (Array.isArray(snapshot.items)) values = snapshot.items
      else if (snapshot.byId && typeof snapshot.byId === 'object') values = Object.values(snapshot.byId)
      else if (typeof snapshot === 'object') values = Object.values(snapshot)
      const out = []
      for (const value of values) {
        if (!value || typeof value !== 'object') continue
        const id = value.sessionId || value.id
        if (!id) continue
        // The session list row exposes `title` only when the session has a
        // durable title projection; `displayTitle` always exists but falls
        // back to the workspace basename or the raw id. Use displayTitle
        // only when it is a real (renamed) title, never when it is the id.
        const projected =
          value.title ||
          (value.projections && value.projections.title) ||
          (value.projection && value.projection.title) ||
          value.customTitle ||
          ''
        const display = typeof value.displayTitle === 'string' ? value.displayTitle : ''
        const title = projected || (display && display !== String(id) ? display : '')
        out.push({ id: String(id), title: String(title) })
      }
      return out
    }

    /**
     * Merge title matches (local session index) with keyword matches (host
     * message-content search), de-duplicated by session id, titles first.
     */
    function mergeResults(index, hits, rawQuery, maxTitles = 8, maxContent = 20) {
      const query = String(rawQuery || '').trim().toLowerCase()
      if (!query) return []
      const titles = []
      for (const entry of index) {
        if (titles.length >= maxTitles) break
        if (!entry || !entry.title) continue
        if (!entry.title.toLowerCase().includes(query)) continue
        titles.push({ id: entry.id, title: entry.title, snippet: '', kind: 'title' })
      }
      const seen = new Set(titles.map((entry) => entry.id))
      const content = []
      for (const hit of hits) {
        if (content.length >= maxContent) break
        if (!hit || !hit.sessionId) continue
        const id = String(hit.sessionId)
        if (seen.has(id)) continue
        seen.add(id)
        const known = index.find((entry) => entry.id === id)
        content.push({
          id,
          title: (known && known.title) || '',
          snippet: String(hit.snippet || ''),
          kind: 'content',
        })
      }
      return [...titles, ...content]
    }

    function SearchAction(props) {
      const wide = props && props.wide !== false
      const open = useOpenState()
      return h(
        'button',
        {
          type: 'button',
          title: text.searchHint,
          'aria-label': text.search,
          'aria-pressed': open ? 'true' : 'false',
          onClick: () => setOpen(!open),
          style: footerButtonStyle(open, colors),
        },
        h(Icon, { path: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'M20 20l-4.2-4.2'], size: FOOTER_BUTTON.iconSize }),
      )
    }

    function Palette(props) {
      const open = useOpenState()
      const [query, setQuery] = React.useState('')
      const [hits, setHits] = React.useState([])
      const [busy, setBusy] = React.useState(false)
      const [active, setActive] = React.useState(0)
      const inputRef = React.useRef(null)

      const useSessions = props && typeof props.useSessions === 'function' ? props.useSessions : null
      // Select a string (a value, not an object) so the snapshot hook stays
      // referentially stable no matter which snapshot shape the host passes.
      let indexJson = '[]'
      if (useSessions) {
        try {
          indexJson = useSessions((snapshot) => JSON.stringify(normalizeSessions(snapshot))) || '[]'
        } catch {
          indexJson = '[]'
        }
      }
      const hookIndex = React.useMemo(() => {
        try {
          const parsed = JSON.parse(indexJson)
          return Array.isArray(parsed) ? parsed : []
        } catch {
          return []
        }
      }, [indexJson])

      const [hostIndex, setHostIndex] = React.useState([])

      React.useEffect(() => {
        if (!open) return undefined
        const controller = new AbortController()
        fetch('/agent-sync/sessions', { signal: controller.signal, cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (!payload || !Array.isArray(payload.sessions)) return
            setHostIndex(payload.sessions.filter((entry) => entry && entry.id && entry.title))
          })
          .catch(() => {
            // the host index is an enhancement; content search still works
          })
        return () => controller.abort()
      }, [open])

      const index = React.useMemo(() => {
        // Live projection first: a session renamed in DSH keeps its old
        // `[App] original` string in the mirror bookkeeping, so the host
        // snapshot must never win over the title the UI currently shows —
        // otherwise the renamed task becomes unsearchable by its new name.
        const merged = new Map()
        for (const entry of hookIndex) if (entry && entry.title) merged.set(entry.id, entry)
        for (const entry of hostIndex) if (!merged.has(entry.id)) merged.set(entry.id, { id: entry.id, title: entry.title })
        return [...merged.values()]
      }, [hostIndex, hookIndex])

      React.useEffect(() => {
        if (!open) return undefined
        setQuery('')
        setHits([])
        setActive(0)
        const timer = setTimeout(() => {
          if (inputRef.current) inputRef.current.focus()
        }, 0)
        return () => clearTimeout(timer)
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        const q = query.trim()
        if (!q) {
          setHits([])
          setBusy(false)
          return undefined
        }
        const controller = new AbortController()
        setBusy(true)
        const timer = setTimeout(async () => {
          try {
            const sessions = services.sessions
            if (!sessions) return
            const result = await sessions.search(q, controller.signal)
            if (controller.signal.aborted) return
            if (result && result.ok === false) {
              setHits([])
            } else {
              const items = result && result.ok ? result.value && result.value.items : result && result.items
              setHits(Array.isArray(items) ? items : [])
            }
          } catch {
            if (!controller.signal.aborted) setHits([])
          } finally {
            if (!controller.signal.aborted) setBusy(false)
          }
        }, 180)
        return () => {
          clearTimeout(timer)
          controller.abort()
        }
      }, [open, query])

      const hasQuery = query.trim().length > 0
      const results = mergeResults(index, hits, query)
      const bounded = Math.max(0, Math.min(active, results.length - 1))

      const openResult = (entry) => {
        if (!entry) return
        const uiWorkspace = services.uiWorkspace
        if (!uiWorkspace) {
          console.warn('[agent-sync] uiWorkspace service is unavailable')
          return
        }
        try {
          uiWorkspace.openSession(entry.id)
        } catch (error) {
          console.warn('[agent-sync] openSession failed', error)
          return
        }
        setOpen(false)
      }

      if (!open) return null

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          setOpen(false)
          return
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive((value) => (results.length === 0 ? 0 : (Math.min(value, results.length - 1) + 1) % results.length))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive((value) => (results.length === 0 ? 0 : (Math.min(value, results.length - 1) - 1 + results.length) % results.length))
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          openResult(results[bounded])
        }
      }

      return h(
        'div',
        {
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            // shell.overlay is click-through by default; opt back in while open.
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'center',
            paddingTop: '12vh',
            background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent)',
          },
          onMouseDown: (event) => {
            if (event.target === event.currentTarget) setOpen(false)
          },
        },
        h(
          'div',
          {
            role: 'dialog',
            'aria-label': text.search,
            style: {
              width: 'min(560px, 90vw)',
              background: colors.panel,
              border: '1px solid ' + colors.border,
              borderRadius: 12,
              boxShadow: '0 16px 48px rgba(0,0,0,0.35)',
              overflow: 'hidden',
            },
          },
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 12px',
                borderBottom: '1px solid ' + colors.borderSoft,
                color: colors.secondary,
              },
            },
            h(Icon, { path: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z', 'M20 20l-4.2-4.2'] }),
            h('input', {
              ref: inputRef,
              value: query,
              placeholder: text.placeholder,
              'aria-label': text.placeholder,
              onChange: (event) => {
                setQuery(event.target.value)
                setActive(0)
              },
              onKeyDown,
              style: {
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: colors.primary,
                font: 'inherit',
                fontSize: 14,
                padding: '4px 0',
              },
            }),
            h('span', { style: { fontSize: 11, color: colors.tertiary } }, busy ? '…' : 'Esc'),
          ),
          h(
            'div',
            { style: { maxHeight: '46vh', overflowY: 'auto', padding: 6 } },
            results.length === 0
              ? h('div', { style: { padding: '14px 10px', fontSize: 13, color: colors.tertiary } }, hasQuery ? text.empty : text.typing)
              : results.map((entry, position) => {
                  const selected = position === bounded
                  return h(
                    'button',
                    {
                      key: entry.kind + ':' + entry.id + ':' + position,
                      type: 'button',
                      onMouseEnter: () => setActive(position),
                      onClick: () => openResult(entry),
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: 3,
                        width: '100%',
                        textAlign: 'left',
                        background: selected ? colors.active : 'transparent',
                        border: 'none',
                        borderRadius: 8,
                        padding: '8px 10px',
                        cursor: 'pointer',
                        color: colors.primary,
                        font: 'inherit',
                      },
                    },
                    h(
                      'span',
                      { style: { display: 'flex', gap: 8, alignItems: 'baseline', width: '100%' } },
                      h(
                        'span',
                        { style: { fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                        entry.title || entry.id,
                      ),
                      h(
                        'span',
                        { style: { marginLeft: 'auto', fontSize: 10, color: colors.tertiary, flex: 'none' } },
                        entry.kind === 'title' ? text.title : text.content,
                      ),
                    ),
                    entry.snippet
                      ? h(
                          'span',
                          {
                            style: {
                              fontSize: 12,
                              color: colors.secondary,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: '100%',
                            },
                          },
                          entry.snippet,
                        )
                      : null,
                  )
                }),
          ),
        ),
      )
    }

    // ---- shared settings primitives (docs/ui-standard.md) ----
    function Field({ label, hint, children }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 16,
            padding: '10px 0',
            borderBottom: '1px solid ' + colors.borderSoft,
          },
        },
        h(
          'div',
          { style: { width: 200, flex: 'none' } },
          h('div', { style: { fontSize: 13, color: colors.primary } }, label),
          hint ? h('div', { style: { marginTop: 2, fontSize: 11, color: colors.tertiary, lineHeight: 1.5 } }, hint) : null,
        ),
        h('div', { style: { flex: 1, minWidth: 0, display: 'flex', justifyContent: 'flex-end' } }, children),
      )
    }

    function Group({ title, children }) {
      return h(
        'div',
        { style: { marginTop: 20 } },
        h('div', { style: { fontSize: 12, fontWeight: 600, color: colors.secondary, marginBottom: 4 } }, title),
        ...React.Children.toArray(children),
      )
    }

    function Toggle({ value, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': value ? 'true' : 'false',
          onClick: () => onChange(!value),
          style: {
            width: 34,
            height: 18,
            flex: 'none',
            borderRadius: 9,
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            position: 'relative',
            background: value ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
            transition: 'background 120ms',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: value ? 18 : 2,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 120ms',
          },
        }),
      )
    }

    function NumberField({ value, onChange, min, max, suffix }) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('input', {
          type: 'number',
          value: String(value),
          min,
          max,
          onChange: (event) => {
            const next = Number(event.target.value)
            if (Number.isFinite(next)) onChange(next)
          },
          style: {
            width: 96,
            padding: '5px 8px',
            borderRadius: 6,
            border: '1px solid ' + colors.border,
            background: colors.layer,
            color: colors.primary,
            font: 'inherit',
            fontSize: 12,
          },
        }),
        suffix ? h('span', { style: { fontSize: 11, color: colors.tertiary } }, suffix) : null,
      )
    }

    function TextField({ value, onChange, placeholder, width }) {
      return h('input', {
        value: value || '',
        placeholder,
        onChange: (event) => onChange(event.target.value),
        style: {
          width: width || 260,
          padding: '5px 8px',
          borderRadius: 6,
          border: '1px solid ' + colors.border,
          background: colors.layer,
          color: colors.primary,
          font: 'inherit',
          fontSize: 12,
        },
      })
    }

    function SaveBar({ dirty, saving, onSave, onReset, note }) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 18 } },
        h(
          'button',
          {
            type: 'button',
            disabled: !dirty || saving,
            onClick: onSave,
            style: {
              height: 28,
              padding: '0 14px',
              borderRadius: 6,
              border: 'none',
              background: dirty && !saving ? 'var(--dsw-alias-brand-primary)' : colors.border,
              color: dirty && !saving ? '#fff' : colors.tertiary,
              cursor: dirty && !saving ? 'pointer' : 'not-allowed',
              font: 'inherit',
              fontSize: 12,
            },
          },
          saving ? '保存中…' : '保存',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: onReset,
            style: {
              height: 28,
              padding: '0 12px',
              borderRadius: 6,
              border: '1px solid ' + colors.border,
              background: 'transparent',
              color: colors.secondary,
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 12,
            },
          },
          '还原',
        ),
        note ? h('span', { style: { fontSize: 11, color: colors.tertiary } }, note) : null,
      )
    }

function SettingsSection() {
      const [status, setStatus] = React.useState(null)
      const [config, setConfig] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [backup, setBackup] = React.useState('')
      const [backing, setBacking] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')
      const [importPath, setImportPath] = React.useState('')
      const [importTitle, setImportTitle] = React.useState('')
      const [importApp, setImportApp] = React.useState('workbuddy')
      const [importing, setImporting] = React.useState(false)
      const [importNote, setImportNote] = React.useState('')

      const loadStatus = React.useCallback(() => {
        fetch('/agent-sync/status', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => payload && setStatus(payload))
          .catch(() => {})
      }, [])

      const loadConfig = React.useCallback(() => {
        fetch('/agent-sync/config', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => {
            if (!payload) {
              setLoadError('接口没有返回配置')
              return
            }
            setConfig(payload)
            setDraft(payload)
            setLoadError('')
          })
          .catch((failure) => setLoadError(String(failure && failure.message)))
      }, [])

      React.useEffect(() => {
        loadStatus()
        loadConfig()
      }, [loadStatus, loadConfig])

      const dirty = Boolean(draft && config && JSON.stringify(draft) !== JSON.stringify(config))
      const set = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }))

      const save = () => {
        setSaving(true)
        setNote('')
        fetch('/agent-sync/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((payload) => {
            if (payload && payload.ok) {
              setConfig(payload.config)
              setDraft(payload.config)
              setNote(payload.note || '已保存，立即生效')
            } else {
              setNote((payload && payload.error) || '保存失败')
            }
          })
          .catch((error) => setNote(String(error && error.message)))
          .finally(() => setSaving(false))
      }

      const apps = (status && status.apps) || []
      if (!draft) {
        return h(
          'div',
          { style: { padding: '12px 2px' } },
          h('div', { style: { fontSize: 12, color: colors.tertiary } }, loadError ? '读取配置失败：' + loadError : '加载中…'),
          loadError
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: () => {
                    setLoadError('')
                    loadStatus()
                    loadConfig()
                  },
                  style: {
                    marginTop: 10,
                    height: 28,
                    padding: '0 12px',
                    borderRadius: 6,
                    border: '1px solid ' + colors.border,
                    background: 'transparent',
                    color: colors.primary,
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 12,
                  },
                },
                '重试',
              )
            : null,
        )
      }

      return h(
        'div',
        { style: { padding: '4px 2px', maxWidth: 760 } },
        h('h2', { style: { margin: '0 0 4px', fontSize: 16, color: colors.primary } }, text.settingsTitle),
        h('p', { style: { margin: '0 0 4px', fontSize: 12, color: colors.secondary } }, text.settingsHint),
        h(
          'div',
          { style: { display: 'flex', gap: 18, fontSize: 12, color: colors.secondary, margin: '10px 0 2px' } },
          h('span', null, text.mirrored + ' ' + ((status && status.mirrored) || 0)),
          h('span', null, text.appsLabel + ' ' + apps.length),
          h('span', null, text.errorsLabel + ' ' + ((status && status.errors) || 0)),
          h('span', null, text.orphanedLabel + ' ' + ((status && status.orphaned) || 0)),
        ),

        h(
          Group,
          { title: '同步' },
          h(
            Field,
            { label: '轮询间隔', hint: '多久检查一次来源文件（毫秒）' },
            h(NumberField, { value: draft.pollMs, min: 500, max: 120000, onChange: set('pollMs'), suffix: 'ms' }),
          ),
          h(
            Field,
            { label: '封口时间', hint: '会话静默多久算这一轮结束（毫秒）' },
            h(NumberField, { value: draft.sealAfterMs, min: 1000, max: 900000, onChange: set('sealAfterMs'), suffix: 'ms' }),
          ),
          h(
            Field,
            { label: '扫描间隔', hint: '重新扫描文件列表的间隔（毫秒）' },
            h(NumberField, { value: draft.scanEveryMs, min: 1000, max: 300000, onChange: set('scanEveryMs'), suffix: 'ms' }),
          ),
          h(
            Field,
            { label: '每应用上限', hint: '0 = 全量导入' },
            h(NumberField, { value: draft.maxSessionsPerApp, min: 0, max: 5000, onChange: set('maxSessionsPerApp') }),
          ),
        ),

        h(
          Group,
          { title: '保护' },
          h(
            Field,
            { label: '来源消失后归档', hint: '关闭时镜像永久保留（推荐）' },
            h(Toggle, { value: draft.sweepMissing, onChange: set('sweepMissing') }),
          ),
          h(
            Field,
            { label: '标记为孤儿', hint: '来源消失多久后标记（分钟）' },
            h(NumberField, { value: draft.orphanAfterMinutes, min: 1, max: 10080, onChange: set('orphanAfterMinutes'), suffix: '分钟' }),
          ),
          h(
            Field,
            { label: '启动时快照', hint: '每次激活备份 state.json' },
            h(Toggle, { value: draft.backupOnStart, onChange: set('backupOnStart') }),
          ),
          h(
            Field,
            { label: '快照保留数' },
            h(NumberField, { value: draft.backupKeep, min: 1, max: 100, onChange: set('backupKeep'), suffix: '份' }),
          ),
        ),

        h(
          Group,
          { title: '手动导入' },
          h(
            Field,
            { label: '会话路径', hint: '单个 .jsonl 文件，或一个包含多个会话的目录' },
            h(TextField, {
              value: importPath,
              onChange: setImportPath,
              placeholder: '例如 D:\\backup\\session.jsonl',
              width: 320,
            }),
          ),
          h(
            Field,
            { label: '显示名称', hint: '留空则使用文件名或原会话标题' },
            h(TextField, { value: importTitle, onChange: setImportTitle, placeholder: '例如 旧项目复盘', width: 320 }),
          ),
          h(
            Field,
            { label: '来源类型', hint: '决定用哪个解析器' },
            h(
              'select',
              {
                value: importApp,
                onChange: (event) => setImportApp(event.target.value),
                style: {
                  height: 28,
                  padding: '0 8px',
                  borderRadius: 6,
                  border: '1px solid ' + colors.border,
                  background: colors.layer,
                  color: colors.primary,
                  font: 'inherit',
                  fontSize: 12,
                },
              },
              h('option', { value: 'workbuddy' }, 'WorkBuddy / Claude'),
              h('option', { value: 'codex' }, 'Codex'),
              h('option', { value: 'zcode' }, 'ZCode'),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' } },
            h(
              'button',
              {
                type: 'button',
                disabled: importing || !importPath.trim(),
                onClick: () => {
                  setImporting(true)
                  setImportNote('')
                  fetch('/agent-sync/import', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ path: importPath.trim(), title: importTitle.trim(), app: importApp }),
                  })
                    .then((r) => (r.ok ? r.json() : null))
                    .then((payload) => {
                      if (payload && payload.ok) {
                        setImportNote(
                          '已导入 ' + payload.imported + ' 个会话（扫描 ' + payload.scanned + ' 个文件）',
                        )
                        loadStatus()
                      } else {
                        setImportNote((payload && (payload.error || payload.failures?.[0]?.error)) || '导入失败')
                      }
                    })
                    .catch((error) => setImportNote(String(error && error.message)))
                    .finally(() => setImporting(false))
                },
                style: {
                  height: 28,
                  padding: '0 14px',
                  borderRadius: 6,
                  border: 'none',
                  background: importing || !importPath.trim() ? colors.border : 'var(--dsw-alias-brand-primary)',
                  color: importing || !importPath.trim() ? colors.tertiary : '#fff',
                  cursor: importing || !importPath.trim() ? 'not-allowed' : 'pointer',
                  font: 'inherit',
                  fontSize: 12,
                },
              },
              importing ? '导入中…' : '导入',
            ),
            importNote ? h('span', { style: { fontSize: 11, color: colors.secondary } }, importNote) : null,
          ),
        ),

        h(
          Group,
          { title: '位置' },
          h(
            Field,
            { label: '工作区根目录', hint: '留空 = 默认工作区父目录下 agent-sync-workspaces' },
            h(TextField, { value: draft.workspacesRoot || '', onChange: set('workspacesRoot'), placeholder: '默认' }),
          ),
        ),

        h(SaveBar, { dirty, saving, onSave: save, onReset: () => setDraft(config), note }),

        h(
          Group,
          { title: text.appsLabel },
          ...apps.map((app) =>
            h(
              'div',
              {
                key: app.id,
                style: {
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                  padding: '6px 0',
                  borderBottom: '1px solid ' + colors.borderSoft,
                  fontSize: 12,
                },
              },
              h('span', { style: { width: 120, flex: 'none', color: colors.primary } }, app.name),
              h('span', { style: { color: colors.secondary } }, text.scanned + ' ' + app.scanned),
              h('span', { style: { flex: 1 } }),
              h('span', { style: { color: colors.tertiary, fontSize: 11 } }, app.workspace ? app.workspace.title : '—'),
            ),
          ),
        ),

        h(
          'div',
          { style: { display: 'flex', gap: 10, marginTop: 18 } },
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                setBacking(true)
                setBackup('')
                fetch('/agent-sync/backup', { method: 'POST' })
                  .then((r) => (r.ok ? r.json() : null))
                  .then((payload) => {
                    if (payload && payload.ok) setBackup(text.backupDone + ' · ' + payload.copied + ' 个会话')
                    else setBackup((payload && payload.error) || '备份失败')
                  })
                  .catch((error) => setBackup(String(error && error.message)))
                  .finally(() => setBacking(false))
              },
              style: {
                height: 28,
                padding: '0 12px',
                borderRadius: 6,
                border: '1px solid ' + colors.border,
                background: 'transparent',
                color: colors.primary,
                cursor: backing ? 'progress' : 'pointer',
                font: 'inherit',
                fontSize: 12,
              },
            },
            backing ? text.backing : text.backup,
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                loadStatus()
                loadConfig()
              },
              style: {
                height: 28,
                padding: '0 12px',
                borderRadius: 6,
                border: '1px solid ' + colors.border,
                background: 'transparent',
                color: colors.primary,
                cursor: 'pointer',
                font: 'inherit',
                fontSize: 12,
              },
            },
            text.reload,
          ),
          backup ? h('span', { style: { fontSize: 11, color: colors.secondary, alignSelf: 'center' } }, backup) : null,
        ),
      )
    }

    function RefreshAction(props) {
      const wide = props && props.wide !== false
      const [busy, setBusy] = React.useState(false)
      const onClick = React.useCallback(() => {
        if (busy) return
        setBusy(true)
        window.location.reload()
      }, [busy])
      return h(
        'button',
        {
          type: 'button',
          title: text.refreshHint,
          'aria-label': text.refresh,
          'aria-busy': busy ? 'true' : 'false',
          onClick,
          style: {
            ...footerButtonStyle(false, colors),
            cursor: busy ? 'progress' : 'pointer',
            opacity: busy ? 0.6 : 1,
          },
        },
        h(Icon, { path: ['M21 12a9 9 0 1 1-2.64-6.36', 'M21 3v6h-6'], size: FOOTER_BUTTON.iconSize }),
      )
    }

    return {
      inject: ['slots'],
      __internals: { normalizeSessions, mergeResults, setOpen, getOpen, text },
      apply(ctx) {
        ctxRef = ctx
        const resolve = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : ctx[name])
        services = { sessions: resolve('sessions'), uiWorkspace: resolve('uiWorkspace') }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'agent-sync-search', order: 9, label: text.search }, SearchAction),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'agent-sync-search-palette', order: 60, label: text.search },
            Palette,
          ),
        )

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register({ name: 'sidebar.footer.action', id: 'agent-sync-refresh', order: 10, label: text.refresh }, RefreshAction),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'agent-sync', order: 36, label: text.settingsTitle }, SettingsSection),
        )

        ctx.effect(() => {
          const onKeyDown = (event) => {
            if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'K')) {
              event.preventDefault()
              setOpen(!getOpen())
            }
          }
          document.addEventListener('keydown', onKeyDown)
          return () => document.removeEventListener('keydown', onKeyDown)
        })
      },
    }
  },
})
