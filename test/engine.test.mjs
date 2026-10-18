import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { apply } from '../index.js'

/* ------------------------------------------------------------------------ */
/* A minimal in-memory Harness: only the two services the engine depends on. */
/* ------------------------------------------------------------------------ */

function createHarness(basePath) {
  const sessions = new Map()
  const workspaces = []
  const archived = new Set()
  const disposers = []
  const logs = []

  const handle = (id) => ({
    id,
    async append(events) {
      const entry = sessions.get(id)
      if (!entry) throw new Error('missing session ' + id)
      for (const event of events) entry.events.push(event)
    },
    async flush() {},
    async close() {},
    async read(offset = 0, length = Infinity) {
      const entry = sessions.get(id)
      if (!entry) throw new Error('missing session ' + id)
      return { events: entry.events.slice(offset, offset + length) }
    },
  })

  const persistence = {
    async stat(id) {
      const entry = sessions.get(id)
      if (!entry) return undefined
      return { header: entry.header, eventCount: entry.events.length, revision: entry.events.length }
    },
    async create(header) {
      if (sessions.has(header.id)) throw new Error('session "' + header.id + '" already exists')
      sessions.set(header.id, { header, events: [] })
      return handle(header.id)
    },
    async open(id, access) {
      if (!sessions.has(id)) throw new Error('session "' + id + '" not found')
      return handle(id)
    },
  }

  const makeWorkspace = (id, wsPath, title) => {
    const ws = {
      id,
      path: wsPath,
      title,
      sessionIds: [],
      async attachSession(sessionId) {
        const entry = sessions.get(sessionId)
        if (!entry) throw new Error('cannot attach session ' + sessionId)
        if (entry.header.cwd !== wsPath) throw new Error('cwd mismatch: ' + entry.header.cwd + ' vs ' + wsPath)
        if (!ws.sessionIds.includes(sessionId)) ws.sessionIds.push(sessionId)
      },
      async setTitle(next) {
        ws.title = next
      },
    }
    workspaces.push(ws)
    return ws
  }

  const base = makeWorkspace('ws-base', basePath, 'Base')
  let nextId = 0

  const registry = {
    list: () => [...workspaces],
    get: (id) => workspaces.find((ws) => ws.id === id),
    async create(wsPath, title) {
      const existing = workspaces.find((ws) => ws.path.toLowerCase() === wsPath.toLowerCase())
      if (existing) return existing
      nextId += 1
      return makeWorkspace('ws-' + nextId, wsPath, title)
    },
    async delete(id) {
      const index = workspaces.findIndex((ws) => ws.id === id)
      if (index >= 0) workspaces.splice(index, 1)
      return index >= 0
    },
    async archiveSession(sessionId) {
      archived.add(sessionId)
    },
    async unarchiveSession(sessionId) {
      archived.delete(sessionId)
    },
  }

  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }

  const ctx = {
    sessionPersistence: persistence,
    workspaceRegistry: registry,
    get(name) {
      return name === 'webServer' ? webServer : undefined
    },
    effect(factory) {
      const dispose = factory()
      disposers.push(dispose)
      return () => dispose()
    },
  }

  return {
    ctx,
    sessions,
    workspaces,
    archived,
    logs,
    routes,
    dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // ignore teardown noise
        }
      }
    },
  }
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sync-engine-'))
}

function writeTurn(file, { title, user, assistant, at = Date.now() }) {
  const lines = []
  if (title) lines.push(JSON.stringify({ type: 'ai-title', aiTitle: title, timestamp: at }))
  lines.push(JSON.stringify({ type: 'message', role: 'user', timestamp: at, content: [{ type: 'input_text', text: user }] }))
  if (assistant) {
    lines.push(JSON.stringify({ type: 'message', role: 'assistant', timestamp: at + 10, content: [{ type: 'output_text', text: assistant }] }))
  }
  fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8')
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(predicate, timeoutMs = 5000, stepMs = 25) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await wait(stepMs)
  }
  return false
}

test('the engine mirrors a source into a per-app workspace and appends new turns', async () => {
  const root = tempRoot()
  const projectDir = path.join(root, 'projects', 'proj')
  fs.mkdirSync(projectDir, { recursive: true })
  const file = path.join(projectDir, 'session.jsonl')
  writeTurn(file, { title: '集成测试', user: '第一问', assistant: '第一答' })
  writeTurn(file, { user: '第二问', assistant: '第二答' })

  const harness = createHarness(root)
  const originalLog = console.log
  console.log = () => {}
  try {
    apply(harness.ctx, {
      pollMs: 500,
      sealAfterMs: 1000,
      maxSessionsPerApp: 0,
      onlyApps: ['workbuddy'],
      stateFile: path.join(root, 'state.json'),
      apps: { workbuddy: { roots: [root] } },
    })
    await until(() => harness.sessions.size === 1)
    assert.equal(harness.sessions.size, 1, 'one mirror session was written')
    assert.equal(harness.workspaces.length, 2, 'a workspace was created for the application')
    const ws = harness.workspaces.find((candidate) => candidate.title === 'WorkBuddy')
    assert.ok(ws, 'workspace title is the application name')
    assert.equal(ws.path, path.join(path.dirname(root), 'agent-sync-workspaces', 'workbuddy'))

    const mirrored = [...harness.sessions.values()]
    assert.equal(mirrored.length, 1, 'one mirror session was written')
    const entry = mirrored[0]
    assert.equal(entry.header.cwd, ws.path, 'header cwd points at the app workspace')
    assert.ok(ws.sessionIds.includes(entry.header.id), 'the mirror is attached to its workspace')

    const types = entry.events.map((event) => event.type)
    assert.equal(types.filter((type) => type === 'turn/end').length, 1, 'only the sealed turn is emitted')
    const title = entry.events.find((event) => event.type === 'session/title')
    assert.ok(title, 'a title event is logged')
    assert.equal(title.data.messageSeqs.length, 1, 'the title cites its user message')
    const userEvents = entry.events.filter((event) => event.type === 'user/message')
    assert.equal(userEvents[0].data.content[0].text, '第一问')

    const route = harness.routes.find((candidate) => candidate.path === '/agent-sync/sessions')
    assert.ok(route, 'the host exposes a title index route')
    let payload = ''
    route.handler({}, { writeHead() {}, end(body) { payload = body } })
    const hostIndex = JSON.parse(payload)
    assert.ok(
      hostIndex.sessions.some((item) => item.id === entry.header.id && item.title.includes('集成测试')),
      'the title index carries the mirrored title',
    )

    // Append a third turn: the earlier turns finish sealing and are appended.
    writeTurn(file, { user: '第三问', assistant: '第三答' })
    await until(() => (harness.sessions.get(entry.header.id)?.events.filter((event) => event.type === 'turn/end').length ?? 0) === 3)

    const after = harness.sessions.get(entry.header.id)
    assert.equal(after.events.filter((event) => event.type === 'turn/end').length, 3)
    assert.deepEqual(
      after.events.filter((event) => event.type === 'user/message').map((event) => event.data.content[0].text),
      ['第一问', '第二问', '第三问'],
    )
    // Sequence numbers stay contiguous.
    after.events.forEach((event, index) => assert.equal(event.seq, index))
  } finally {
    harness.dispose()
    console.log = originalLog
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('noise-only and empty sources never become tasks', async () => {
  const root = tempRoot()
  const projectDir = path.join(root, 'projects', 'proj')
  fs.mkdirSync(projectDir, { recursive: true })
  const noiseFile = path.join(projectDir, 'noise.jsonl')
  fs.writeFileSync(
    noiseFile,
    JSON.stringify({ type: 'message', role: 'user', timestamp: 1, content: [{ type: 'input_text', text: '[OpenClaw heartbeat poll]' }] }) + '\n',
    'utf8',
  )
  fs.writeFileSync(path.join(projectDir, 'tiny.jsonl'), '{"type":"message"}\n', 'utf8')

  const harness = createHarness(root)
  const originalLog = console.log
  console.log = () => {}
  try {
    apply(harness.ctx, {
      pollMs: 500,
      sealAfterMs: 1000,
      maxSessionsPerApp: 0,
      onlyApps: ['workbuddy'],
      stateFile: path.join(root, 'state.json'),
      apps: { workbuddy: { roots: [root] } },
    })
    await wait(300)
    assert.equal(harness.sessions.size, 0, 'no mirror was created')
    assert.equal(harness.workspaces.length, 1, 'no workspace was created for an empty application')
  } finally {
    harness.dispose()
    console.log = originalLog
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the timer stops when the plugin is disposed', async () => {
  const root = tempRoot()
  const harness = createHarness(root)
  const originalLog = console.log
  console.log = () => {}
  try {
    apply(harness.ctx, { pollMs: 500, sealAfterMs: 1000, onlyApps: ['workbuddy'], apps: { workbuddy: { roots: [root] } } })
    await wait(60)
    harness.dispose()
    await wait(700)
    // No lingering interval kept the process busy: sessions stayed untouched.
    assert.equal(harness.sessions.size, 0)
  } finally {
    console.log = originalLog
    fs.rmSync(root, { recursive: true, force: true })
  }
})
