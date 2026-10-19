import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const plain = (value) => JSON.parse(JSON.stringify(value))
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8')

/** Load the browser bundle in a VM and hand back its module definition. */
function loadClient() {
  let definition
  const listeners = []
  const document = {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: () => {},
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (def) => { definition = def } } },
    document,
    navigator: { language: 'zh-CN' },
    console,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)

  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => undefined,
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }
  const mod = definition.factory((name) => {
    if (name === 'react') return fakeReact
    throw new Error('unexpected require: ' + name)
  })
  return { mod, definition, listeners, document, fakeReact }
}

test('client bundle is a lazy factory registered under the package id', () => {
  const { mod, definition } = loadClient()
  assert.equal(definition.id, '@local/agent-sync')
  assert.equal(typeof definition.factory, 'function')
  assert.deepEqual(Array.from(mod.inject), ['slots'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply registers the search action, the palette and the refresh action', () => {
  const { mod } = loadClient()
  const registered = []
  const ctx = {
    slots: {
      inject: (_key, callback) => callback(),
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect: (factory) => factory(),
  }
  mod.apply(ctx)
  const ids = registered.map((entry) => entry.options.id).sort()
  assert.deepEqual(ids, ['agent-sync', 'agent-sync-refresh', 'agent-sync-search', 'agent-sync-search-palette'])
  assert.equal(registered.filter((entry) => entry.options.name === 'sidebar.footer.action').length, 2)
  assert.equal(registered.filter((entry) => entry.options.name === 'shell.overlay').length, 1)
  assert.equal(registered.filter((entry) => entry.options.name === 'settings.section').length, 1)
})

test('Ctrl+K toggles the palette and Escape-free keyboard handling is passive', () => {
  const { mod, listeners } = loadClient()
  const ctx = {
    slots: { inject: (_key, callback) => callback(), register: () => () => {} },
    effect: (factory) => factory(),
  }
  mod.apply(ctx)
  const keydown = listeners.find((entry) => entry.type === 'keydown')
  assert.ok(keydown, 'a global keydown listener is installed')

  const makeEvent = (key, ctrlKey) => ({ key, ctrlKey, metaKey: false, preventDefault() {} })
  assert.equal(mod.__internals.getOpen(), false)
  keydown.fn(makeEvent('k', true))
  assert.equal(mod.__internals.getOpen(), true)
  keydown.fn(makeEvent('k', true))
  assert.equal(mod.__internals.getOpen(), false)
  keydown.fn(makeEvent('x', false))
  assert.equal(mod.__internals.getOpen(), false)
})

test('normalizeSessions accepts every plausible snapshot shape', () => {
  const { mod } = loadClient()
  const normalize = mod.__internals.normalizeSessions

  assert.deepEqual(plain(normalize([{ sessionId: 's1', title: '甲' }])), [{ id: 's1', title: '甲' }])
  assert.deepEqual(plain(normalize(new Map([['s2', { id: 's2', title: '乙' }]]))), [{ id: 's2', title: '乙' }])
  assert.deepEqual(plain(normalize({ items: [{ id: 's3', projections: { title: '丙' } }] })), [{ id: 's3', title: '丙' }])
  assert.deepEqual(plain(normalize({ s4: { sessionId: 's4', customTitle: '丁' } })), [{ id: 's4', title: '丁' }])
  assert.deepEqual(plain(normalize(null)), [])
  assert.deepEqual(plain(normalize([{ nope: true }])), [])
})

test('mergeResults puts title matches first, de-duplicates and bounds the list', () => {
  const { mod } = loadClient()
  const merge = mod.__internals.mergeResults
  const index = [
    { id: 'a', title: '个人规划风险评估' },
    { id: 'b', title: '游艇项目Git推送' },
  ]
  const hits = [
    { sessionId: 'a', snippet: '规划里的关键词' },
    { sessionId: 'c', snippet: '来自消息内容的命中' },
  ]

  const results = plain(merge(index, hits, '规划'))
  assert.deepEqual(results.map((entry) => entry.id), ['a', 'c'])
  assert.equal(results[0].kind, 'title')
  assert.equal(results[1].kind, 'content')
  assert.equal(results[1].title, '')
  assert.equal(results[1].snippet, '来自消息内容的命中')

  assert.deepEqual(plain(merge(index, hits, '   ')), [])
  assert.deepEqual(plain(merge(index, [], '不存在的词')), [])
  // Content hits are already filtered Host-side, so they are passed through.
  assert.equal(plain(merge(index, hits, '不存在的词')).length, 2)

  const many = Array.from({ length: 30 }, (_, i) => ({ sessionId: 'h' + i, snippet: 'x' }))
  assert.equal(plain(merge([], many, 'x', 8, 20)).length, 20)
})

test('the palette renders nothing while closed and a dialog when opened', () => {
  const { mod, fakeReact } = loadClient()
  const registered = []
  const ctx = {
    slots: { inject: (_key, callback) => callback(), register: (options, component) => registered.push({ options, component }) },
    effect: (factory) => factory(),
  }
  mod.apply(ctx)
  const palette = registered.find((entry) => entry.options.id === 'agent-sync-search-palette').component

  // Closed: hooks still run, but no element is produced.
  assert.equal(palette({}), null)

  // Open: a dialog element is produced.
  mod.__internals.setOpen(true)
  const tree = palette({ useSessions: (selector) => selector([{ sessionId: 's1', title: '甲' }]) })
  assert.ok(tree, 'the palette renders')
  assert.equal(tree.type, 'div')
  assert.equal(tree.props.role, undefined)
  const dialog = tree.children.find((child) => child && child.props && child.props.role === 'dialog')
  assert.ok(dialog, 'a dialog element is rendered')
  assert.equal(dialog.props['aria-label'], mod.__internals.text.search)
  mod.__internals.setOpen(false)
  assert.equal(fakeReact.createElement, fakeReact.createElement)
})
