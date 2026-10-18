window.__ModuleLoader__.load({
  id: '@local/agent-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const zh = typeof navigator !== 'undefined' && /^zh\b/i.test(navigator.language || '')
    const text = zh ? '刷新任务列表' : 'Refresh tasks'
    const hint = zh ? '重新加载页面，拉取其他 Agent 刚写入的会话' : 'Reload the page to pull sessions other agents just wrote'

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
          title: hint,
          'aria-label': text,
          'aria-busy': busy ? 'true' : 'false',
          onClick,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: 'none',
            cursor: busy ? 'progress' : 'pointer',
            color: 'var(--dsw-alias-text-secondary, inherit)',
            padding: wide ? '4px 8px' : '4px',
            borderRadius: 6,
            font: 'inherit',
            opacity: busy ? 0.6 : 1,
          },
        },
        h(
          'svg',
          {
            width: 16,
            height: 16,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': true,
            style: { flex: 'none' },
          },
          h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
          h('path', { d: 'M21 3v6h-6' }),
        ),
        wide ? h('span', null, text) : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'agent-sync-refresh',
              order: 10,
              label: text,
            },
            RefreshAction,
          ),
        )
      },
    }
  },
})
