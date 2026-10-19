import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Static guarantees that would have prevented today's breakages:
 *   1. Patch writers must write atomically (tmp + rename), never in place.
 *   2. The profile layer must be preferred over the packaged patch.
 *   3. Writers must refuse a result that is not a patch entry list.
 *   4. No `ctx.<service>.` property access that can throw during activation.
 */
const targets = [
  { name: 'agent-sync', file: 'D:/WorkBuddy/dsh-agent-sync/index.js' },
  { name: 'github-flow', file: 'D:/WorkBuddy/dsh-github-flow/index.js' },
]

const results = []

for (const target of targets) {
  const text = fs.readFileSync(target.file, 'utf8')
  const problems = []

  // 1. atomic write present
  if (!/renameSync\(tmp, file\)/.test(text)) problems.push('patch write is not atomic (no tmp+rename)')
  if (/fs\.writeFileSync\(file, merged/.test(text)) problems.push('writes the target file in place')

  // 2. profile layer precedence
  const candidatesAt = text.indexOf('const candidates = [')
  if (candidatesAt >= 0) {
    const slice = text.slice(candidatesAt, candidatesAt + 400)
    const profileIndex = slice.indexOf('DSH_PROFILE_DIR')
    const packageIndex = slice.indexOf('PACKAGE_DIR')
    if (profileIndex < 0) problems.push('profile layer not considered')
    else if (packageIndex >= 0 && packageIndex < profileIndex) problems.push('packaged patch is preferred over the profile layer')
  }

  // 3. structural guard
  if (!text.includes('looksLikePatchList')) problems.push('no structural guard before writing the patch')

  // 4. no unguarded service property access in apply
  const applyAt = text.indexOf('export function apply')
  if (applyAt >= 0) {
    const body = text.slice(applyAt)
    for (const service of ['skills', 'webServer', 'workspaceRegistry', 'sessionPersistence']) {
      const direct = new RegExp('ctx\\.' + service + '\\s*\\.')
      if (direct.test(body)) {
        // Allow `ctx.<service>` as a fallback inside a ctx.get ternary.
        const guarded = new RegExp("ctx\\.get\\('" + service + "'\\)")
        if (!guarded.test(body)) problems.push('unguarded ctx.' + service + ' access in apply')
      }
    }
  }

  results.push({ name: target.name, problems })
}

// 5. The writers must survive a round trip on a scratch profile.
for (const [name, file, route] of [
  ['agent-sync', 'D:/WorkBuddy/dsh-agent-sync/index.js', '/agent-sync/config'],
  ['github-flow', 'D:/WorkBuddy/dsh-github-flow/index.js', '/github-flow/config'],
]) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-patch-'))
  const profile = path.join(scratch, 'profiles', 'p')
  fs.mkdirSync(profile, { recursive: true })
  const patchFile = path.join(profile, 'cordis.patch.yml')
  fs.writeFileSync(patchFile, '- id: user-entry\n  config:\n    keep: yes\n', 'utf8')
  process.env.DSH_PROFILE_DIR = profile

  const routes = new Map()
  const mod = await import('file:///' + file.replace(/\\/g, '/') + '?gate=' + Date.now())
  mod.apply({
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') dispose()
    },
    get: (serviceName) => {
      if (serviceName === 'webServer') return { register: (r) => { routes.set(r.path, r); return () => {} } }
      if (serviceName === 'workspaceRegistry') return { list: () => [] }
      if (serviceName === 'sessionPersistence') return { open: async () => null }
      if (serviceName === 'skills') return { register: () => {} }
      return undefined
    },
    on: () => {},
  }, {})

  const handler = routes.get(route)
  if (!handler) {
    results.push({ name: name + ' roundtrip', problems: [route + ' not registered'] })
  } else {
    const body =
      name === 'agent-sync'
        ? { pollMs: 3000, sealAfterMs: 12000, scanEveryMs: 5000, maxSessionsPerApp: 0, maxFilesPerApp: 4000, orphanAfterMinutes: 60, backupKeep: 10, sweepMissing: false, backupOnStart: true, workspacesRoot: '' }
        : { reposRoot: 'D:/WorkBuddy', autoTag: true, retries: 6 }

    await new Promise((resolve) => {
      const req = {
        method: 'POST',
        on: (event, fn) => {
          if (event === 'data') fn(JSON.stringify(body))
          if (event === 'end') fn()
          return req
        },
        destroy: () => {},
      }
      handler.handler(req, { writeHead: () => ({}), end: () => resolve() })
    })

    const written = fs.readFileSync(patchFile, 'utf8')
    const problems = []
    if (!written.includes('user-entry')) problems.push('user content lost on save')
    if (!written.includes('managed')) problems.push('managed block missing')
    if ((written.match(/managed \(config/g) || []).length > 1) problems.push('managed block duplicated')
    results.push({ name: name + ' roundtrip', problems })
  }
  fs.rmSync(scratch, { recursive: true, force: true })
}

let failed = false
for (const result of results) {
  if (result.problems.length === 0) {
    console.log('PASS  ' + result.name)
  } else {
    failed = true
    console.log('FAIL  ' + result.name)
    for (const problem of result.problems) console.log('        - ' + problem)
  }
}
if (failed) process.exitCode = 1
