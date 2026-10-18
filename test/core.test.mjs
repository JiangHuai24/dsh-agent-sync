import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  mirrorIdFor,
  stripReminders,
  isNoiseUserText,
  parseClaudeRecord,
  parseCodexRecord,
  parseAnyRecord,
  createSourceState,
  pushItem,
  trimItems,
  describe,
  groupTurns,
  eventsForTurn,
  readNewLines,
  backoffDelayMs,
  missingAction,
  titleEventFor,
} from '../index.js'

const app = { id: 'probe', name: 'Probe' }

function freshState(key = 'probe:one') {
  return createSourceState(key)
}

function feed(state, records) {
  for (const record of records) parseAnyRecord(record, state)
  return state
}

test('mirrorIdFor is deterministic, uuid-shaped and attempt-sensitive', () => {
  const a = mirrorIdFor('workbuddy:a/b.jsonl')
  const b = mirrorIdFor('workbuddy:a/b.jsonl')
  assert.equal(a, b)
  assert.match(a, /^session-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(a, mirrorIdFor('workbuddy:a/b.jsonl', 1))
  assert.notEqual(mirrorIdFor('workbuddy:a/b.jsonl', 1), mirrorIdFor('workbuddy:a/b.jsonl', 2))
})

test('stripReminders removes harness scaffolding', () => {
  const raw = '<system-reminder data-role="user-context">noise</system-reminder>\n\n\n请把按钮改成蓝色<user_query></user_query>'
  assert.equal(stripReminders(raw), '请把按钮改成蓝色')
})

test('isNoiseUserText catches machine turns only', () => {
  assert.equal(isNoiseUserText('[OpenClaw heartbeat poll]'), true)
  assert.equal(isNoiseUserText('An async command you ran earlier has completed'), true)
  assert.equal(isNoiseUserText('   <task-notification'), true)
  assert.equal(isNoiseUserText('帮我修一下这个 bug'), false)
})

test('claude parser reads conversation and ignores tool plumbing', () => {
  const st = feed(freshState(), [
    { type: 'ai-title', aiTitle: '修按钮' },
    { type: 'message', role: 'user', timestamp: 1000, content: [{ type: 'input_text', text: '把按钮改成蓝色' }] },
    { type: 'reasoning', timestamp: 1001, content: [] },
    { type: 'function_call', timestamp: 1002, name: 'Read', arguments: '{}' },
    { type: 'function_call_result', timestamp: 1003 },
    { type: 'message', role: 'assistant', timestamp: 1004, content: [{ type: 'output_text', text: '改好了' }] },
  ])
  assert.equal(st.items.length, 2)
  assert.equal(st.items[0].role, 'user')
  assert.equal(st.items[1].text, '改好了')
  assert.equal(st.sawUser, true)
  assert.equal(st.title, '修按钮')
})

test('claude parser drops heartbeat sessions', () => {
  const st = feed(freshState(), [
    { type: 'message', role: 'user', timestamp: 1, content: [{ type: 'input_text', text: '[OpenClaw heartbeat poll]' }] },
  ])
  assert.equal(st.items.length, 0)
  assert.equal(st.sawUser, false)
})

test('codex parser reads response_item messages and skips environment context', () => {
  const st = feed(freshState(), [
    { type: 'session_meta', payload: { cwd: 'C:/w' } },
    {
      type: 'response_item',
      timestamp: '2026-08-24T12:00:00.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] },
    },
    {
      type: 'response_item',
      timestamp: '2026-08-24T12:00:01.000Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你现在是免费的吗' }] },
    },
    {
      type: 'response_item',
      timestamp: '2026-08-24T12:00:02.000Z',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '是的' }] },
    },
  ])
  assert.equal(st.items.length, 2)
  assert.equal(st.items[0].text, '你现在是免费的吗')
  assert.equal(st.items[1].text, '是的')
})

test('groupTurns starts a turn per user message and folds assistant text', () => {
  const turns = groupTurns([
    { role: 'user', text: 'a', at: 1 },
    { role: 'assistant', text: 'a1', at: 2 },
    { role: 'assistant', text: 'a2', at: 3 },
    { role: 'user', text: 'b', at: 4 },
  ])
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0].assistants, ['a1', 'a2'])
  assert.equal(turns[1].user, 'b')
  assert.equal(turns[1].assistants.length, 0)
})

test('groupTurns synthesizes an opening turn when the log starts with the assistant', () => {
  const turns = groupTurns([{ role: 'assistant', text: 'hello', at: 1 }])
  assert.equal(turns.length, 1)
  assert.match(turns[0].user, /该会话以助手消息开头/)
  assert.deepEqual(turns[0].assistants, ['hello'])
})

test('eventsForTurn writes contiguous seqs and closes the turn', () => {
  const withAssistant = eventsForTurn({ user: 'q', assistants: ['a'], at: 10, lastAt: 20 }, 1, 0, 'probe')
  assert.deepEqual(
    withAssistant.map((e) => e.type),
    ['turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end'],
  )
  assert.deepEqual(
    withAssistant.map((e) => e.seq),
    [0, 1, 2, 3, 4, 5],
  )
  assert.equal(withAssistant[0].turn, undefined)
  assert.deepEqual(withAssistant[5].data, { turn: 1, reason: { kind: 'completed' } })
  assert.equal(withAssistant[2].surfaceOp, 'append')
  assert.equal(withAssistant[3].surfaceOp, 'append')

  const userOnly = eventsForTurn({ user: 'q', assistants: [], at: 10 }, 2, 6, 'probe')
  assert.deepEqual(
    userOnly.map((e) => e.type),
    ['turn/start', 'step/start', 'user/message', 'step/end', 'turn/end'],
  )
  assert.deepEqual(
    userOnly.map((e) => e.seq),
    [6, 7, 8, 9, 10],
  )
})

test('describe derives a title from the first user message and flags human content', () => {
  const st = feed(freshState(), [
    { type: 'message', role: 'user', timestamp: 5, content: [{ type: 'input_text', text: '  第一行\n第二行  ' }] },
  ])
  const source = describe(st, app)
  assert.equal(source.title, '第一行 第二行')
  assert.equal(source.hasHuman, true)
  assert.equal(source.appId, 'probe')

  const noise = describe(freshState('probe:two'), app)
  assert.equal(noise.hasHuman, false)
})

test('trimItems drops whole turns and keeps the turn counter absolute', () => {
  const TOTAL = 12000
  const st = freshState()
  for (let i = 0; i < TOTAL; i += 1) {
    pushItem(st, { role: 'user', text: 'u' + i, at: i })
    pushItem(st, { role: 'assistant', text: 'a' + i, at: i })
  }
  assert.ok(st.items.length <= 20000, 'items are capped')
  assert.ok(st.droppedTurns > 0, 'old turns were dropped')
  assert.equal(st.items[0].role, 'user', 'trim lands on a turn boundary')
  assert.equal(st.droppedTurns + groupTurns(st.items).length, TOTAL, 'no turn is lost or double counted')
})

test('resolveConfig applies defaults and validates numbers', async () => {
  const { resolveConfig } = await import('../index.js')
  const defaults = resolveConfig(undefined)
  assert.equal(defaults.maxSessionsPerApp, 0)
  assert.equal(defaults.pollMs, 3000)
  assert.equal(defaults.scanEveryMs, 5000)

  const clamped = resolveConfig({ pollMs: 1, sealAfterMs: 999999999, maxSessionsPerApp: -5 })
  assert.equal(clamped.pollMs, 500)
  assert.equal(clamped.sealAfterMs, 900000)
  assert.equal(clamped.maxSessionsPerApp, 0)
})

test('rootsFor honours a per-app override and drops empty entries', async () => {
  const { rootsFor, appRegistry } = await import('../index.js')
  const app = appRegistry().find((candidate) => candidate.id === 'workbuddy')
  const cfg = resolveConfigForTest({ apps: { workbuddy: { roots: ['C:/temp/store', ''] } } })
  assert.deepEqual(rootsFor(cfg, app), ['C:/temp/store'])
  assert.deepEqual(rootsFor(resolveConfigForTest({}), app), app.roots)

  function resolveConfigForTest(raw) {
    return {
      apps: raw.apps || {},
    }
  }
})

test('readNewLines is incremental, tolerates partial lines and flags truncation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-sync-test-'))
  const file = path.join(dir, 'session.jsonl')
  const st = freshState('probe:file')
  const parse = (record, state) => parseAnyRecord(record, state)

  const line = (text) => JSON.stringify({ type: 'message', role: 'user', timestamp: 1, content: [{ type: 'input_text', text }] })

  fs.writeFileSync(file, line('one') + '\n', 'utf8')
  await readNewLines(st, file, parse)
  assert.equal(st.items.length, 1)

  // A partial trailing line must not be parsed yet.
  fs.appendFileSync(file, line('two').slice(0, 10), 'utf8')
  await readNewLines(st, file, parse)
  assert.equal(st.items.length, 1)

  // Completing it releases the whole record.
  const rest = line('two').slice(10)
  fs.appendFileSync(file, rest + '\n', 'utf8')
  await readNewLines(st, file, parse)
  assert.equal(st.items.length, 2)

  // No new bytes => no work, no duplicates.
  await readNewLines(st, file, parse)
  assert.equal(st.items.length, 2)

  // Truncation rebuilds the stream and bumps the reset counter.
  fs.writeFileSync(file, line('fresh') + '\n', 'utf8')
  await readNewLines(st, file, parse)
  assert.equal(st.items.length, 1)
  assert.equal(st.items[0].text, 'fresh')
  assert.equal(st.reset, 1)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('turn counter survives trimming and is reported to the status surface', () => {
  const TOTAL = 12000
  const st = freshState()
  for (let i = 0; i < TOTAL; i += 1) {
    pushItem(st, { role: 'user', text: 'u' + i, at: i })
    pushItem(st, { role: 'assistant', text: 'a' + i, at: i })
  }
  const source = describe(st, app)
  assert.equal(source.turns, st.userCount)
  assert.equal(st.droppedTurns + groupTurns(st.items).length, TOTAL)
  // userCount counts the retained stream, droppedTurns the retired prefix.
  assert.equal(st.userCount + st.droppedTurns, TOTAL)
})

test('backoffDelayMs grows exponentially and caps at one minute', () => {
  assert.equal(backoffDelayMs(1), 2000)
  assert.equal(backoffDelayMs(2), 4000)
  assert.equal(backoffDelayMs(3), 8000)
  assert.equal(backoffDelayMs(20), 60000)
  assert.equal(backoffDelayMs(0), 2000)
})

test('missingAction walks mark -> wait -> archive and skips settled records', () => {
  const grace = 60000
  const now = 1_000_000
  assert.equal(missingAction({}, now, grace), 'mark')
  assert.equal(missingAction({ missingSince: now - 1000 }, now, grace), 'wait')
  assert.equal(missingAction({ missingSince: now - grace - 1 }, now, grace), 'archive')
  assert.equal(missingAction({ archived: true }, now, grace), 'skip')
  assert.equal(missingAction({ detached: true }, now, grace), 'skip')
})

test('titleEventFor always cites a message', () => {
  assert.throws(() => titleEventFor(0, 'x', undefined))
  const event = titleEventFor(0, 'x', 7)
  assert.deepEqual(event.data.messageSeqs, [7])
  assert.equal(event.data.source.kind, 'fallback')
})
