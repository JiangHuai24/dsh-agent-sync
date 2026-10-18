import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { eventsForTurn, titleEventFor } from '../index.js'

/**
 * Contract test: every event this plugin writes must be accepted by the DSH
 * session-format validator. The Harness ships its packages inside the desktop
 * application, so the library is located through the environment or a few known
 * installation layouts and skipped when none of them exist.
 */
async function loadValidator() {
  const candidates = [
    process.env.DSH_SESSION_LIB,
    'D:/deepseekHarness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js',
    'C:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue
    try {
      const mod = await import('file:///' + path.resolve(candidate).replace(/\\/g, '/'))
      if (typeof mod.adoptSessionEvent === 'function') return mod
    } catch {
      // try the next location
    }
  }
  return undefined
}

const validator = await loadValidator()

test('generated events are accepted by the DSH session format', async (t) => {
  if (!validator) {
    t.skip('no installed @deepseek-ai/dsh-session found (set DSH_SESSION_LIB)')
    return
  }
  const events = [
    titleEventFor(0, '[Probe] contract', 2),
    ...eventsForTurn({ user: '问题', assistants: ['回答'], at: Date.now(), lastAt: Date.now() }, 1, 1, 'probe'),
  ]
  for (const event of events) {
    assert.doesNotThrow(() => validator.adoptSessionEvent(event), 'rejected: ' + event.type)
  }
})

test('a fallback title is never emitted without a cited message', () => {
  // Guards the regression that produced unreadable mirrored logs: DSH rejects a
  // non-user title whose messageSeqs is empty.
  assert.throws(() => titleEventFor(0, 'broken', undefined))
  assert.equal(titleEventFor(0, 'ok', 3).data.messageSeqs.length, 1)
})
