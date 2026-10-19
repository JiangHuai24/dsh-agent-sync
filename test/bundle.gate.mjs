import fs from 'node:fs'
import vm from 'node:vm'

/**
 * Structural + behavioural gate for client bundles.
 * Fails loudly instead of letting a broken bundle reach the app.
 */
function makeReact() {
  const store = []
  const effects = []
  let cursor = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Children: {
      toArray: (input) => {
        if (input === null || input === undefined || input === false) return []
        if (Array.isArray(input)) return input.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false)
        return [input]
      },
    },
    useState: (initial) => {
      const i = cursor++
      if (!(i in store)) store[i] = typeof initial === 'function' ? initial() : initial
      return [
        store[i],
        (next) => {
          const value = typeof next === 'function' ? next(store[i]) : next
          store[i] = value
        },
      ]
    },
    useEffect: (fn) => { effects.push(fn) },
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (v) => ({ current: v }),
    Fragment: 'Fragment',
    __reset: () => { cursor = 0 },
    __runEffects: async () => {
      for (const fn of effects.splice(0)) fn()
      await new Promise((r) => setTimeout(r, 120))
    },
  }
}

function gate(file, label, requiredSlots) {
  const problems = []
  const text = fs.readFileSync(file, 'utf8')

  // 1. No leaked source: these strings only appear if a patch script wrote its
  //    own body into the bundle.
  for (const leak of ['const primitives = `', 'writeSettingsPage', 'export function', 'readFileSync(__filename', "import fs from 'node:fs'"]) {
    if (text.includes(leak)) problems.push('leaked source fragment: ' + leak)
  }

  // 2. The factory must be the last top-level statement, and `return {` must
  //    come after every function it hands to the slot system.
  const returnAt = text.lastIndexOf('    return {')
  if (returnAt < 0) problems.push('no module return block')
  for (const name of ['footerButtonStyle', 'SettingsSection']) {
    const at = text.lastIndexOf('function ' + name)
    if (at < 0) problems.push('missing function ' + name)
    else if (returnAt >= 0 && at > returnAt) problems.push(name + ' is declared after the module return (dead code)')
  }

  // 3. Syntax.
  try {
    new Function(text)
  } catch (error) {
    problems.push('syntax: ' + error.message)
  }

  // 4. Behaviour: every registered slot component must render without throwing.
  if (problems.length === 0) {
    const React = makeReact()
    let captured = null
    const sandbox = {
      window: {
        __ModuleLoader__: { load: (s) => { captured = s } },
        localStorage: { getItem: () => '1', setItem: () => {} },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      navigator: { language: 'zh-CN', clipboard: { writeText: async () => {} } },
      document: { addEventListener: () => {}, removeEventListener: () => {} },
      console,
      setTimeout,
      clearTimeout,
      fetch: async () => ({
        ok: true,
        json: async () => ({
          pollMs: 3000, sealAfterMs: 12000, scanEveryMs: 5000, maxSessionsPerApp: 0,
          orphanAfterMinutes: 60, backupKeep: 10, sweepMissing: false, backupOnStart: true,
          workspacesRoot: null, mirrored: 0, errors: 0, orphaned: 0, apps: [],
          repos: [], skill: 'github-push', version: 'test', script: 'x', repo: 'y',
        }),
      }),
    }
    sandbox.globalThis = sandbox
    vm.createContext(sandbox)
    try {
      vm.runInContext(text, sandbox, { filename: file })
      const mod = captured.factory((n) => (n === 'react' ? React : (() => { throw new Error('require ' + n) })()))
      const reg = []
      mod.apply({ effect: (fn) => fn(), slots: { inject: (n, fn) => fn(), register: (o, c) => { reg.push({ ...o, c }); return () => {} } } })

      for (const slot of requiredSlots) {
        if (!reg.some((r) => r.name === slot)) problems.push('slot not registered: ' + slot)
      }
      for (const entry of reg) {
        React.__reset()
        try {
          entry.c({ close: () => {} })
        } catch (error) {
          problems.push(entry.id + ' threw on render: ' + error.message)
        }
      }

      // Render with children in every shape React can produce: a single element
      // (not an array) is the case that used to throw on a spread.
      for (const entry of reg) {
        for (const probe of [{ close: () => {}, children: 'single' }, { close: () => {}, children: undefined }, { close: () => {} }]) {
          React.__reset()
          try {
            entry.c(probe)
          } catch (error) {
            problems.push(entry.id + ' threw on probe render: ' + error.message)
          }
        }
      }
    } catch (error) {
      problems.push('module load: ' + error.message)
    }
  }

  return { label, file, problems }
}

const results = [
  gate('D:/WorkBuddy/dsh-agent-sync/client.js', 'agent-sync', ['settings.section', 'sidebar.footer.action', 'shell.overlay']),
  gate('D:/WorkBuddy/dsh-github-flow/client.js', 'github-flow', ['settings.section', 'sidebar.footer.action', 'shell.overlay']),
]

// --- combo checks -------------------------------------------------------
// Every client bundle is concatenated into ONE script by the host, so two
// plugins declaring the same top-level name break the whole page even though
// each file is valid on its own.
const comboFiles = ['D:/WorkBuddy/dsh-agent-sync/client.js', 'D:/WorkBuddy/dsh-github-flow/client.js']
const comboText = comboFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
try {
  new Function(comboText)
} catch (error) {
  results.push({ label: 'combo', file: 'combined', problems: ['combined script does not parse: ' + error.message] })
}

const declared = new Map()
for (const f of comboFiles) {
  const source = fs.readFileSync(f, 'utf8')
  let depth = 0
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (depth === 0) {
      const match = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(trimmed)
      if (match) {
        const list = declared.get(match[1]) || []
        list.push(f.split('/').slice(-2).join('/'))
        declared.set(match[1], list)
      }
    }
    depth += (line.match(/[{([]/g) || []).length - (line.match(/[})\]]/g) || []).length
  }
}
const comboProblems = []
for (const [name, where] of declared) {
  const unique = [...new Set(where)]
  if (unique.length > 1) comboProblems.push('top-level "' + name + '" declared in ' + unique.join(' and '))
}
results.push({ label: 'combo', file: 'combined', problems: comboProblems })

// --- end combo checks ---


// --- host halves ---------------------------------------------------------
// "import failed" is reported by the host when a plugin cannot be imported or
// throws while applying. Test both, with and without services.
const hostCases = [
  { name: 'agent-sync', file: 'file:///D:/WorkBuddy/dsh-agent-sync/index.js' },
  { name: 'github-flow', file: 'file:///D:/WorkBuddy/dsh-github-flow/index.js' },
]

for (const hostCase of hostCases) {
  const hostProblems = []
  let mod
  try {
    mod = await import(hostCase.file + '?gate=' + Date.now())
  } catch (error) {
    hostProblems.push('import threw: ' + error.message)
    results.push({ label: 'host ' + hostCase.name, file: hostCase.file, problems: hostProblems })
    continue
  }
  if (!mod || typeof mod.apply !== 'function') hostProblems.push('no apply export')

  // Zero-service context: must degrade, never throw.
  const bare = {
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') dispose()
    },
    get: () => undefined,
    on: () => {},
  }
  try {
    mod.apply(bare, {})
  } catch (error) {
    hostProblems.push('apply threw without services: ' + error.message)
  }

  results.push({ label: 'host ' + hostCase.name, file: hostCase.file, problems: hostProblems })
}

let failed = false
for (const result of results) {
  if (result.problems.length === 0) {
    console.log('PASS  ' + result.label)
  } else {
    failed = true
    console.log('FAIL  ' + result.label)
    for (const problem of result.problems) console.log('        - ' + problem)
  }
}
if (failed) process.exitCode = 1
