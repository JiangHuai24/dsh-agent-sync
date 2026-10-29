/**
 * Agent Session Sync
 *
 * Mirrors sessions produced by other coding agents on this machine into DSH, one
 * workspace per application (the workspace title is the application's name), so
 * every agent's history lands in its own place and stays readable - and
 * continuable - inside the Harness.
 *
 * Design notes:
 * - The durable session log is written through `sessionPersistence` (create,
 *   append, flush, close), i.e. the same storage path the Harness itself uses.
 * - Workspace membership goes through `Workspace.attachSession`, never through a
 *   hand-edited workspace.json.
 * - Only *sealed* turns are mirrored: a turn becomes sealed once a later user
 *   message arrives or the source has been idle for `sealAfterMs`, so the
 *   append-only log never has to be rewritten.
 * - If a mirrored session gets new events from anywhere else (the user continues
 *   the conversation inside DSH), syncing for that source stops, so the two
 *   writers never fight over one log.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** Directory of this package; the bundle patch lives beside it. */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** The session log format the installed Harness writes. */
const FORMAT_VERSION = 4
/** Longest single message text kept from a source session. */
const MAX_ITEM_CHARS = 8000
/** Soft cap; sources are trimmed from the head at a user boundary. */
const MAX_ITEMS = 20000
const KEEP_ITEMS = 15000
const STATE_VERSION = 2
/** Bytes read from a source file per iteration; bounds peak memory. */
const READ_CHUNK_BYTES = 4 * 1024 * 1024

export const inject = ['sessionPersistence', 'workspaceRegistry']

const log = (...args) => console.log('[agent-sync]', ...args)

const home = os.homedir()

function num(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

/**
 * Applications the "Our Free Model" channels belong to, plus the agents already
 * supported. `roots` are candidate data directories; an application contributes
 * nothing until one of them exists, so this list is safe to keep broad.
 */
export function appRegistry() {
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  return [
    {
      id: 'workbuddy',
      name: 'WorkBuddy',
      kind: 'jsonl',
      roots: [path.join(home, '.workbuddy')],
      titleDb: path.join(home, '.workbuddy', 'workbuddy.db'),
    },
    {
      id: 'workbuddy-ai',
      name: 'WorkBuddy AI',
      kind: 'jsonl',
      roots: [path.join(home, '.workbuddy-ai')],
      titleDb: path.join(home, '.workbuddy-ai', 'workbuddy.db'),
    },
    { id: 'zcode', name: 'ZCode', kind: 'zcode', roots: [path.join(home, '.zcode')] },
    { id: 'codex', name: 'Codex', kind: 'jsonl', roots: [path.join(home, '.codex', 'sessions')] },
    { id: 'codebuddy', name: 'CodeBuddy', kind: 'jsonl', roots: [path.join(home, '.codebuddy'), path.join(roaming, 'CodeBuddy')] },
    {
      id: 'loomy',
      name: 'Loomy',
      kind: 'jsonl',
      roots: [path.join(home, '.loomy'), path.join(home, '.loomy-code'), path.join(roaming, 'Loomy'), path.join(local, 'Programs', 'Loomy')],
    },
    {
      id: 'raccoon',
      name: 'Raccoon',
      kind: 'jsonl',
      roots: [path.join(home, '.raccoon'), path.join(roaming, 'Raccoon'), path.join(roaming, 'SenseNova')],
    },
    {
      id: 'minimax',
      name: 'MiniMax',
      kind: 'jsonl',
      roots: [path.join(home, '.minimax'), path.join(home, '.minimax-code'), path.join(roaming, 'MiniMax'), path.join(roaming, 'MiniMax Code')],
    },
    { id: 'qoder', name: 'Qoder', kind: 'jsonl', roots: [path.join(home, '.qoder'), path.join(roaming, 'Qoder')] },
    {
      id: 'cline',
      name: 'Cline',
      kind: 'jsonl',
      roots: [path.join(home, '.cline'), path.join(roaming, 'Cline')],
    },
    { id: 'codearts', name: 'CodeArts', kind: 'jsonl', roots: [path.join(home, '.codearts'), path.join(roaming, 'CodeArts')] },
    {
      id: 'lobster',
      name: 'LobsterAI',
      kind: 'jsonl',
      roots: [path.join(home, '.lobster'), path.join(home, '.lobsterai'), path.join(roaming, 'LobsterAI')],
    },
    { id: 'gemini', name: 'Gemini', kind: 'jsonl', roots: [path.join(home, '.gemini')] },
  ]
}

export function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const sourceOverrides =
    raw.apps && typeof raw.apps === 'object'
      ? raw.apps
      : raw.sources && typeof raw.sources === 'object'
        ? raw.sources
        : {}
  return {
    pollMs: clamp(num(raw.pollMs, 3000), 500, 120000),
    sealAfterMs: clamp(num(raw.sealAfterMs, 12000), 1000, 900000),
    /** 0 = import every session found in the application's store. */
    maxSessionsPerApp: clamp(num(raw.maxSessionsPerApp, 0), 0, 5000),
    maxFilesPerApp: clamp(num(raw.maxFilesPerApp, 4000), 10, 20000),
    scanEveryMs: clamp(num(raw.scanEveryMs, 5000), 1000, 300000),
    /** Minutes a source may stay absent before its mirror is archived. */
    missingGraceMinutes: clamp(num(raw.missingGraceMinutes, 30), 1, 10080),
    /** Archive mirrors whose source disappeared. Off by default: a deleted host
     *  application must not take its mirrored history down with it. */
    sweepMissing: raw.sweepMissing === true,
    /** Minutes before a source-less mirror is flagged as orphaned (kept alive). */
    orphanAfterMinutes: clamp(num(raw.orphanAfterMinutes, 60), 1, 10080),
    /** Snapshot the mirror bookkeeping on activation. */
    backupOnStart: raw.backupOnStart !== false,
    backupKeep: clamp(num(raw.backupKeep, 10), 1, 100),
    /** Manual/automatic backup folder; empty = next to the state file. */
    backupsRoot: typeof raw.backupsRoot === 'string' && raw.backupsRoot ? raw.backupsRoot : undefined,
    workspacesRoot: typeof raw.workspacesRoot === 'string' && raw.workspacesRoot ? raw.workspacesRoot : undefined,
    /** Override where the mirror bookkeeping lives (tests, portable installs). */
    stateFile: typeof raw.stateFile === 'string' && raw.stateFile ? raw.stateFile : undefined,
    /** Non-empty = sync only these application ids. */
    onlyApps: Array.isArray(raw.onlyApps) ? raw.onlyApps.filter((value) => typeof value === 'string' && value.length > 0) : [],
    /** Per-application switches, keyed by application id. */
    apps: sourceOverrides,
  }
}

function appEnabled(cfg, app) {
  if (cfg.onlyApps.length > 0 && !cfg.onlyApps.includes(app.id)) return false
  const override = cfg.apps[app.id]
  if (override === false) return false
  if (override && typeof override === 'object' && override.enabled === false) return false
  return true
}

// ---------------------------------------------------------------------------
// Session log construction
// ---------------------------------------------------------------------------

export function mirrorIdFor(key, attempt = 0) {
  const seed = attempt > 0 ? `agent-sync:r${attempt}:${key}` : 'agent-sync:' + key
  const h = crypto.createHash('sha1').update(seed).digest('hex')
  return `session-${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export function makeEvent(type, seq, time, data, surfaceOp) {
  const event = { type, seq, time, data }
  if (surfaceOp) event.surfaceOp = surfaceOp
  return event
}

export function userTextOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && typeof c.text === 'string' && (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text'))
    .map((c) => c.text)
    .join('\n')
}

export function assistantTextOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && typeof c.text === 'string' && (c.type === 'output_text' || c.type === 'output_text_delta' || c.type === 'text'))
    .map((c) => c.text)
    .join('\n')
}

export function stripReminders(text) {
  return text
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<user_query>/gi, '')
    .replace(/<\/user_query>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Machine-generated user turns that carry no human conversation. */
const NOISE_PREFIXES = [
  '[OpenClaw heartbeat poll]',
  'An async command you ran earlier',
  '<task-notification',
  '<command-name>',
  '<local-command',
  '[heartbeat',
]

export function isNoiseUserText(text) {
  const head = text.trimStart()
  return NOISE_PREFIXES.some((prefix) => head.startsWith(prefix))
}

export function firstLine(text, max) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// ---------------------------------------------------------------------------
// Per-source item streams
// ---------------------------------------------------------------------------

export function createSourceState(key) {
  return {
    key,
    title: undefined,
    firstAt: undefined,
    lastItemAt: 0,
    droppedTurns: 0,
    items: [],
    sawUser: false,
    userCount: 0,
    reset: 0,
    offset: 0,
    pending: Buffer.alloc(0),
    cursor: undefined,
    fp: undefined,
  }
}

export function trimItems(st) {
  if (st.items.length <= MAX_ITEMS) return
  const drop = st.items.length - KEEP_ITEMS
  let cut = -1
  for (let i = 0; i < drop; i += 1) {
    if (st.items[i].role === 'user') cut = i
  }
  if (cut < 0) return
  const removed = st.items.slice(0, cut)
  const droppedUsers = removed.filter((i) => i.role === 'user').length
  st.droppedTurns += droppedUsers
  st.userCount = Math.max(0, (st.userCount || 0) - droppedUsers)
  st.items = st.items.slice(cut)
}

export function pushItem(st, item) {
  if (!item || !item.text || !item.text.trim()) return
  st.items.push(item)
  if (item.role === 'user') {
    st.sawUser = true
    st.userCount = (st.userCount || 0) + 1
  }
  if (st.firstAt === undefined) st.firstAt = item.at || Date.now()
  st.lastItemAt = item.at || Date.now()
  trimItems(st)
}

/**
 * Append bytes from a growing JSONL file and hand each parsed record to `parse`.
 * Reads are incremental, line-aligned and chunked, so a large historical log is
 * never materialized in memory as one buffer.
 */
export async function readNewLines(st, fp, parse) {
  let stat
  try {
    stat = await fsp.stat(fp)
  } catch {
    return
  }
  if (stat.size < st.offset) {
    // The producer rewrote or truncated the file: the mirror must be rebuilt
    // from a fresh identity instead of appending onto stale counters.
    st.offset = 0
    st.pending = Buffer.alloc(0)
    st.items = []
    st.droppedTurns = 0
    st.sawUser = false
    st.title = undefined
    st.firstAt = undefined
    st.userCount = 0
    st.reset = (st.reset || 0) + 1
  }
  if (stat.size === st.offset) return

  const handle = await fsp.open(fp, 'r')
  try {
    let pos = st.offset
    let carry = st.pending
    while (pos < stat.size) {
      const length = Math.min(READ_CHUNK_BYTES, stat.size - pos)
      const chunk = Buffer.allocUnsafe(length)
      await handle.read(chunk, 0, length, pos)
      pos += length
      const buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
      const lastNewline = buffer.lastIndexOf(0x0a)
      if (lastNewline < 0) {
        carry = buffer
        continue
      }
      const complete = buffer.subarray(0, lastNewline).toString('utf8')
      carry = buffer.subarray(lastNewline + 1)
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        try {
          parse(record, st)
        } catch (error) {
          log('record parse failed', String(error && error.message))
        }
      }
      st.offset = pos
    }
    st.offset = pos
    st.pending = carry
  } finally {
    await handle.close()
  }
}

export function describe(st, app) {
  if (!st.title) {
    const firstUser = st.items.find((i) => i.role === 'user')
    st.title = firstUser ? firstLine(firstUser.text, 60) : undefined
  }
  return {
    key: st.key,
    appId: app.id,
    appName: app.name,
    label: app.name,
    title: st.title,
    items: st.items,
    firstAt: st.firstAt,
    lastItemAt: st.lastItemAt || Date.now(),
    droppedTurns: st.droppedTurns,
    hasHuman: st.sawUser === true,
    turns: st.userCount || 0,
    reset: st.reset || 0,
  }
}

// ---------------------------------------------------------------------------
// Line parsers
// ---------------------------------------------------------------------------

export function parseClaudeRecord(record, st) {
  if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim()) {
    st.title = record.aiTitle.trim()
    return
  }
  if (record.type === 'custom-title' && typeof record.customTitle === 'string' && record.customTitle.trim()) {
    st.title = record.customTitle.trim()
    return
  }
  if (record.type !== 'message') return
  const at = typeof record.timestamp === 'number' ? record.timestamp : Date.now()
  if (record.role === 'user') {
    const text = stripReminders(userTextOf(record.content))
    if (!text || isNoiseUserText(text)) return
    if (/^<user_info>|^Workspace Folder:|^OS Version:/.test(text)) return
    pushItem(st, { role: 'user', text: text.slice(0, MAX_ITEM_CHARS), at })
    return
  }
  if (record.role === 'assistant') {
    const text = assistantTextOf(record.content).trim()
    if (!text) return
    pushItem(st, { role: 'assistant', text: text.slice(0, MAX_ITEM_CHARS), at })
  }
}

export function parseCodexRecord(record, st) {
  if (record.type !== 'response_item' || !record.payload || record.payload.type !== 'message') return
  const role = record.payload.role
  const at = Date.parse(record.timestamp || '') || Date.now()
  if (role === 'user') {
    const text = userTextOf(record.payload.content).trim()
    if (!text || isNoiseUserText(text)) return
    if (/^<(environment_context|app-context|user_instructions|skill|system)/.test(text)) return
    pushItem(st, { role: 'user', text: text.slice(0, MAX_ITEM_CHARS), at })
    return
  }
  if (role === 'assistant') {
    const text = assistantTextOf(record.payload.content).trim()
    if (!text) return
    pushItem(st, { role: 'assistant', text: text.slice(0, MAX_ITEM_CHARS), at })
  }
}

export function parseAnyRecord(record, st) {
  if (record.type === 'response_item') {
    parseCodexRecord(record, st)
    return
  }
  parseClaudeRecord(record, st)
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '.git', 'cache', 'Cache', 'logs', 'log', 'blobs', 'binaries', '__pycache__'])

/**
 * Read the authoritative session titles an application keeps in its own index
 * database. The transcript's own `ai-title` line can be stale after a rename,
 * so the app's table wins when both exist.
 */
export function createTitleReader(dbPath) {
  let db
  let DatabaseSync
  let map = new Map()
  let loadedAt = 0
  let disabled = false
  return async function titles() {
    if (disabled || !dbPath || !fs.existsSync(dbPath)) return map
    if (Date.now() - loadedAt < 30000) return map
    try {
      if (DatabaseSync === undefined) {
        const sqlite = await import('node:sqlite')
        DatabaseSync = sqlite.DatabaseSync
      }
      if (!db) db = new DatabaseSync(dbPath, { readOnly: true })
      const rows = db.prepare('select id, title, custom_title from sessions').all()
      map = new Map(rows.map((row) => [row.id, row.custom_title || row.title]).filter(([, title]) => title))
      loadedAt = Date.now()
    } catch {
      // a locked or rotated index retries on the next pass with the old map
      loadedAt = Date.now() - 25000
    }
    return map
  }
}

export async function collectJsonl(root, limit) {
  const out = []
  const walk = async (dir, depth) => {
    if (out.length >= limit || depth > 6) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.endsWith('.file-rollback.ndjson')) {
        try {
          const stat = await fsp.stat(full)
          if (stat.size < 200) continue
          out.push({ fp: full, mtime: stat.mtimeMs })
        } catch {
          // skip unreadable entries
        }
      }
    }
  }
  await walk(root, 0)
  return out
}

function jsonlAdapter(app, cfg) {
  const states = new Map()
  let fileCache = []
  let lastScan = 0
  const readTitles = app.titleDb ? createTitleReader(app.titleDb) : undefined
  return {
    app,
    async poll() {
      const roots = app.roots.filter((root) => root && fs.existsSync(root))
      if (roots.length === 0) return []
      if (Date.now() - lastScan > cfg.scanEveryMs) {
        lastScan = Date.now()
        const files = []
        const perRoot = Math.ceil(cfg.maxFilesPerApp / roots.length)
        for (const root of roots) {
          const found = await collectJsonl(root, perRoot)
          for (const file of found) files.push({ ...file, root })
        }
        files.sort((a, b) => b.mtime - a.mtime)
        fileCache = files
      }
      const files = fileCache
      const limit = cfg.maxSessionsPerApp > 0 ? cfg.maxSessionsPerApp : files.length
      const out = []
      for (const file of files.slice(0, limit)) {
        const key = `${app.id}:${path.relative(file.root, file.fp).replace(/\\/g, '/')}`
        let st = states.get(key)
        if (!st) {
          st = createSourceState(key)
          states.set(key, st)
        }
        st.fp = file.fp
        try {
          await readNewLines(st, file.fp, parseAnyRecord)
        } catch (error) {
          log(app.id, 'read failed', file.fp, String(error && error.message))
        }
        if (st.items.length) {
          if (readTitles) {
            const titles = await readTitles()
            const sessionId = path.basename(file.fp, '.jsonl')
            const authoritative = titles.get(sessionId)
            if (authoritative) st.title = authoritative
          }
          out.push(describe(st, app))
        }
      }
      return out
    },
  }
}

function zcodeAdapter(app, cfg) {
  const dbPath = path.join(app.roots[0], 'cli', 'db', 'db.sqlite')
  const states = new Map()
  let db
  let DatabaseSync
  let unavailable = false
  // A locked or rotated database is reopened on the next poll instead of
  // poisoning every later tick with the same error.
  const closeDb = () => {
    try {
      db?.close()
    } catch {
      // already closed
    }
    db = undefined
  }
  return {
    app,
    async poll() {
      if (unavailable || !fs.existsSync(dbPath)) return []
      if (DatabaseSync === undefined) {
        try {
          const sqlite = await import('node:sqlite')
          DatabaseSync = sqlite.DatabaseSync
        } catch (error) {
          unavailable = true
          log('node:sqlite unavailable, ZCode sync disabled', String(error && error.message))
          return []
        }
      }
      try {
        if (!db) db = new DatabaseSync(dbPath, { readOnly: true })
      } catch (error) {
        log('zcode open failed', String(error && error.message))
        return []
      }
      let sessions
      try {
        sessions = db.prepare('select id, title, time_created, time_updated from session order by time_updated desc').all()
      } catch (error) {
        log('zcode session query failed', String(error && error.message))
        closeDb()
        return []
      }
      const limit = cfg.maxSessionsPerApp > 0 ? cfg.maxSessionsPerApp : sessions.length
      const out = []
      for (const session of sessions.slice(0, limit)) {
        const key = `${app.id}:${session.id}`
        let st = states.get(key)
        if (!st) {
          st = createSourceState(key)
          states.set(key, st)
        }
        if (typeof session.title === 'string' && session.title.trim()) st.title = session.title.trim()
        if (st.cursor === undefined) st.cursor = -1
        let rows
        try {
          rows = db
            .prepare(
              `select m.id as mid, coalesce(m.sequence, 0) as mseq, m.time_created as mtime, m.data as mdata,
                      p.sequence as pseq, p.data as pdata
                 from message m left join part p on p.message_id = m.id
                where m.session_id = ? and coalesce(m.sequence, 0) > ?
                order by coalesce(m.sequence, 0) asc, p.sequence asc`,
            )
            .all(session.id, st.cursor)
        } catch (error) {
          log('zcode message query failed', String(error && error.message))
          closeDb()
          break
        }
        const grouped = new Map()
        for (const row of rows) {
          let entry = grouped.get(row.mid)
          if (!entry) {
            entry = { seq: row.mseq, at: row.mtime, data: row.mdata, texts: [] }
            grouped.set(row.mid, entry)
          }
          if (typeof row.pdata === 'string') {
            let part
            try {
              part = JSON.parse(row.pdata)
            } catch {
              part = undefined
            }
            if (part && part.type === 'text' && typeof part.text === 'string') entry.texts.push(part.text)
          }
        }
        for (const entry of grouped.values()) {
          let message
          try {
            message = JSON.parse(entry.data)
          } catch {
            message = undefined
          }
          const text = entry.texts.join('\n').trim()
          const role = message && message.role === 'assistant' ? 'assistant' : message && message.role === 'user' ? 'user' : undefined
          if (role && text) pushItem(st, { role, text: text.slice(0, MAX_ITEM_CHARS), at: entry.at || Date.now() })
          if (typeof entry.seq === 'number' && entry.seq > st.cursor) st.cursor = entry.seq
        }
        if (st.items.length) out.push(describe(st, app))
      }
      return out
    },
  }
}

/** Resolve the roots an application is read from, honouring per-app overrides. */
export function rootsFor(cfg, app) {
  const override = cfg.apps && cfg.apps[app.id]
  const custom = override && typeof override === 'object' && Array.isArray(override.roots) ? override.roots : undefined
  const roots = custom && custom.length > 0 ? custom : app.roots
  return roots.filter((root) => typeof root === 'string' && root.length > 0)
}

function buildAdapters(cfg) {
  const adapters = []
  for (const app of appRegistry()) {
    if (!appEnabled(cfg, app)) continue
    const roots = rootsFor(cfg, app)
    if (app.kind === 'zcode') {
      if (!fs.existsSync(roots[0])) continue
      adapters.push(zcodeAdapter({ ...app, roots }, cfg))
      continue
    }
    const present = roots.filter((root) => fs.existsSync(root))
    if (present.length === 0) continue
    adapters.push(jsonlAdapter({ ...app, roots: present }, cfg))
  }
  return adapters
}

// ---------------------------------------------------------------------------
// Durable mirror state
// ---------------------------------------------------------------------------

export function storeFile(cfg) {
  if (cfg && typeof cfg.stateFile === 'string' && cfg.stateFile) return cfg.stateFile
  const homeDir = process.env.DSH_HOME || path.join(home, '.dsh')
  return path.join(homeDir, 'storages', 'agent-sync', 'state.json')
}

function loadStore(cfg) {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(cfg), 'utf8'))
    if (raw && typeof raw === 'object' && raw.sources && typeof raw.sources === 'object') {
      return { version: raw.version || 1, sources: new Map(Object.entries(raw.sources)) }
    }
  } catch {
    // first run or unreadable state
  }
  return { version: STATE_VERSION, sources: new Map() }
}

function saveStore(store, cfg) {
  const file = storeFile(cfg)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const sources = {}
    for (const [key, value] of store.sources) sources[key] = value
    const body = JSON.stringify({ version: STATE_VERSION, updatedAt: new Date().toISOString(), sources }, null, 2)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    log('state save failed', String(error && error.message))
  }
}

// ---------------------------------------------------------------------------
// Turn assembly
// ---------------------------------------------------------------------------

/** Exponential backoff for a repeatedly failing adapter poll, capped at a minute. */
export function backoffDelayMs(failures) {
  return Math.min(60000, 2000 * 2 ** Math.max(0, failures - 1))
}

/**
 * Decide what a tick should do with a record whose source was not seen:
 * `skip` (already settled), `mark` (start the grace clock), `wait` (inside the
 * grace period) or `archive` (the source is gone for good).
 */
export function missingAction(record, now, graceMs) {
  if (record.archived || record.detached) return 'skip'
  if (record.missingSince === undefined) return 'mark'
  return now - record.missingSince < graceMs ? 'wait' : 'archive'
}

/** Fold a flat item stream into turns: one user message starts a turn. */
export function groupTurns(items) {
  const turns = []
  let current
  for (const item of items) {
    if (item.role === 'user') {
      current = { user: item.text, assistants: [], at: item.at, lastAt: item.at }
      turns.push(current)
    } else if (item.text && item.text.trim()) {
      if (!current) {
        current = { user: '（该会话以助手消息开头）', assistants: [], at: item.at, lastAt: item.at }
        turns.push(current)
      }
      current.assistants.push(item.text)
      current.lastAt = item.at || current.lastAt
    }
  }
  return turns
}

/**
 * Build a fallback title event. A non-user title must cite the message it was
 * derived from: the stored log is rejected as corrupt otherwise.
 */
export function titleEventFor(seq, title, citedSeq) {
  if (typeof citedSeq !== 'number' || !Number.isFinite(citedSeq)) {
    throw new Error('a fallback title requires a cited message seq')
  }
  return makeEvent('session/title', seq, Date.now(), {
    title,
    messageSeqs: [citedSeq],
    source: { kind: 'fallback' },
  })
}

/**
 * Build the DSH events for one sealed turn. A turn without assistant text still
 * produces a closed user-only turn, so the log stays well formed.
 */
export function eventsForTurn(turn, turnNumber, seqStart, provider, messageIds = crypto) {
  let seq = seqStart
  const events = []
  const at = turn.at || Date.now()
  const last = turn.lastAt || at
  events.push(makeEvent('turn/start', seq++, at, { turn: turnNumber }))
  events.push(makeEvent('step/start', seq++, at, { turn: turnNumber, step: 1 }))
  events.push(
    makeEvent(
      'user/message',
      seq++,
      at,
      {
        content: [{ type: 'text', text: turn.user }],
        source: { kind: 'user' },
        role: 'user',
        id: messageIds.randomUUID(),
      },
      'append',
    ),
  )
  const assistant = turn.assistants.join('\n\n').trim()
  if (assistant) {
    events.push(
      makeEvent(
        'assistant/message',
        seq++,
        last,
        {
          turn: turnNumber,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: assistant }],
            source: { kind: 'model', provider, model: provider },
            id: messageIds.randomUUID(),
          },
          stream: [],
        },
        'append',
      ),
    )
  }
  events.push(makeEvent('step/end', seq++, last, { turn: turnNumber, step: 1 }))
  events.push(makeEvent('turn/end', seq++, last, { turn: turnNumber, reason: { kind: 'completed' } }))
  return events
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  // Resolve through ctx.get: a hard property access here throws when the
  // service is not ready yet, and the host reports that as "import failed",
  // which aborts the whole web boot.
  // Resolve through ctx.get first (a hard property access throws when the
  // service is not ready and aborts the whole web boot), but keep the direct
  // property as a fallback: minimal harnesses expose services only there.
  const resolveService = (name) => (typeof ctx.get === 'function' && ctx.get(name)) || ctx[name]
  const persistence = resolveService('sessionPersistence')
  const registry = resolveService('workspaceRegistry')
  // The session list reads projection-cache rows, so a mirror written straight
  // through persistence never shows up until a row exists for it.
  const projectionCache = resolveService('sessionProjectionCache')
  /** Mirror id produced by the most recent syncSource call (import needs it). */
  let lastMirrorId = null

  /**
   * Merge the editable keys into this plugin's row in the profile patch. The
   * file is small YAML, so the row is rewritten in place instead of pulling in
   * a YAML dependency.
   */
  /**
   * Merge only the editable keys into this plugin's own bundle patch. Every
   * other key (sources, comments, unknown options) is preserved verbatim, so a
   * save from the settings page never drops configuration it does not know.
   */

  // --- safe patch persistence (adopted from kuaiyukuaikuai/dsh-agent-sync) ---

  const PATCH_MARK_START = '# --- agent-sync managed (config; edit via the settings page) ---'
  const PATCH_MARK_END = '# --- end agent-sync managed ---'

  /** Write a file atomically so an interrupted write cannot truncate it. */
  const atomicWrite = (file, content) => {
    const dir = path.dirname(file)
    const tmp = path.join(dir, '.' + path.basename(file) + '.tmp-' + process.pid + '-' + Date.now())
    fs.writeFileSync(tmp, content, 'utf8')
    try {
      fs.renameSync(tmp, file)
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
      throw error
    }
  }

  /** Keep one rolling backup next to the file before the first modification. */
  const backupOnce = (file) => {
    try {
      const backup = file + '.agent-sync-backup'
      if (fs.existsSync(file) && !fs.existsSync(backup)) {
        fs.copyFileSync(file, backup)
      }
    } catch {
      // a backup is a convenience, never a reason to fail the write
    }
  }

  /**
   * Remove the managed block so the caller can re-render it, and drop a bare
   * `[]` root (the loader expects an array of patch entries, not a flow empty).
   */
  const stripManagedSection = (text) => {
    const kept = []
    let inside = false
    for (const line of String(text || '').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === PATCH_MARK_START) {
        inside = true
        continue
      }
      if (trimmed === PATCH_MARK_END) {
        inside = false
        continue
      }
      if (inside) continue
      if (trimmed === '[]') continue
      kept.push(line)
    }
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
    return kept.join('\n')
  }

  /** Render our config as one patch entry under the managed markers. */
  const renderManagedConfig = (values) => {
    const rows = []
    rows.push(PATCH_MARK_START)
    rows.push('- id: agent-sync')
    rows.push("  name: '@local/agent-sync'")
    rows.push('  config:')
    for (const key of Object.keys(values)) {
      const value = values[key]
      if (value === undefined) continue
      const rendered = typeof value === 'string' ? JSON.stringify(value) : String(value)
      rows.push('    ' + key + ': ' + rendered)
    }
    rows.push(PATCH_MARK_END)
    return rows.join('\n')
  }

  /** A light structural check: the file must still describe a YAML entry list. */
  const looksLikePatchList = (text) => {
    const meaningful = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
    if (meaningful.length === 0) return true
    return meaningful[0].startsWith('- ')
  }

  const writeProfileConfig = (next) => {
    // The user-owned profile layer wins; the packaged patch is only a fallback
    // for profiles that carry no patch of their own.
    const candidates = [
      process.env.DSH_PROFILE_DIR ? path.join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml') : undefined,
      path.join(PACKAGE_DIR, 'cordis.patch.yml'),
    ].filter(Boolean)
    const file = candidates.find((candidate) => fs.existsSync(candidate))
    if (!file) return false

    backupOnce(file)
    const current = fs.readFileSync(file, 'utf8')
    const body = stripManagedSection(current)
    const section = renderManagedConfig(next)
    const merged = (body ? body + '\n\n' : '') + section + '\n'

    if (!looksLikePatchList(merged)) {
      throw new Error('refusing to write: result is not a patch entry list')
    }
    atomicWrite(file, merged)
    return true
  }

  const readJsonBody = (req) =>
    new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => {
        data += chunk
        if (data.length > 200000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'))
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const sendJson = (res, payload) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  const store = loadStore(cfg)
  const adapters = buildAdapters(cfg)

  // The browser cannot read the mirror bookkeeping, and the session hook the
  // slots expose does not promise a title field. Serve the title index over a
  // read-only same-origin route instead of guessing a snapshot shape.
  /**
   * Title index for the search palette.
   *
   * ⚠️ The mirror bookkeeping holds the title agent-sync itself wrote
   * (`[App] original`), which goes stale the moment the user renames the task
   * inside DSH. The live projection cache is the authority for the current
   * title, so read it first and fall back to the bookkeeping only when the
   * cache has no row (a mirror that was never listed, or a cache miss).
   * Without this, a renamed task stops matching its new name entirely.
   */
  const mirroredTitles = async () => {
    // The cache only answers for the exact stored header (version / createdAt /
    // cwd / isSeeded), so the identity must come from persistence, never from
    // a reconstructed object. One `list()` covers every mirror in this store.
    let headerById = new Map()
    if (projectionCache && typeof projectionCache.cachedSnapshot === 'function'
      && persistence && typeof persistence.list === 'function') {
      try {
        const snapshots = await persistence.list()
        headerById = new Map(snapshots.map((snapshot) => [snapshot.header.id, snapshot.header]))
      } catch {
        headerById = new Map()
      }
    }
    const items = []
    for (const record of store.sources.values()) {
      if (!record || record.archived || !record.title) continue
      let title = record.title
      const header = headerById.get(record.mirrorId)
      if (header !== undefined) {
        try {
          const live = projectionCache.cachedSnapshot(header, ['title'])
          const value = live && live.values && live.values.title
          if (typeof value === 'string' && value.trim() !== '') title = value
        } catch {
          // The cache is an optimization: a miss must never break the index.
        }
      }
      items.push({ id: record.mirrorId, title, app: record.appId || null })
    }
    return items
  }

  const backupsDir = () =>
    cfg.backupsRoot || path.join(path.dirname(storeFile(cfg)), 'backups')

  const backupState = () => {
    const file = storeFile(cfg)
    if (!fs.existsSync(file)) return null
    const dir = backupsDir()
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(dir, 'state-' + stamp + '.json')
    fs.copyFileSync(file, target)
    try {
      const kept = fs
        .readdirSync(dir)
        .filter((name) => name.startsWith('state-') && name.endsWith('.json'))
        .sort()
      while (kept.length > cfg.backupKeep) {
        const oldest = kept.shift()
        fs.rmSync(path.join(dir, oldest), { force: true })
      }
    } catch {
      // pruning is best-effort
    }
    return target
  }

  const backupMirrors = () => {
    const dir = path.join(backupsDir(), 'mirrors-' + new Date().toISOString().replace(/[:.]/g, '-'))
    fs.mkdirSync(dir, { recursive: true })
    const sessionsRoot = path.join(process.env.DSH_HOME || path.join(home, '.dsh'), 'sessions')
    let copied = 0
    for (const record of store.sources.values()) {
      if (!record || !record.mirrorId) continue
      let source = null
      try {
        for (const group of fs.readdirSync(sessionsRoot)) {
          const candidate = path.join(sessionsRoot, group, record.mirrorId)
          if (fs.existsSync(candidate)) {
            source = candidate
            break
          }
        }
      } catch {
        source = null
      }
      if (!source) continue
      try {
        fs.cpSync(source, path.join(dir, record.mirrorId), { recursive: true })
        copied += 1
      } catch {
        // a single unreadable session must not abort the backup
      }
    }
    return { dir, copied }
  }

  if (cfg.backupOnStart) {
    try {
      const target = backupState()
      if (target) log('state backup written', target)
    } catch (error) {
      log('state backup failed', String(error && error.message))
    }
  }

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
  if (webServer) {
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/agent-sync/sessions',
        handler: async (_req, res) => {
          let sessions = []
          try {
            sessions = await mirroredTitles()
          } catch {
            sessions = []
          }
          const payload = JSON.stringify({ at: Date.now(), sessions })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(payload)
        },
      }),
    )
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/agent-sync/config',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, {
              pollMs: cfg.pollMs,
              sealAfterMs: cfg.sealAfterMs,
              maxSessionsPerApp: cfg.maxSessionsPerApp,
              maxFilesPerApp: cfg.maxFilesPerApp,
              scanEveryMs: cfg.scanEveryMs,
              missingGraceMinutes: cfg.missingGraceMinutes,
              orphanAfterMinutes: cfg.orphanAfterMinutes,
              sweepMissing: cfg.sweepMissing,
              backupOnStart: cfg.backupOnStart,
              backupKeep: cfg.backupKeep,
              workspacesRoot: cfg.workspacesRoot || null,
              onlyApps: cfg.onlyApps,
            })
            return
          }
          const body = await readJsonBody(req)
          const num = (value, min, max, fallback) => {
            const n = Number(value)
            if (!Number.isFinite(n)) return fallback
            return Math.min(max, Math.max(min, Math.round(n)))
          }
          const next = {
            pollMs: num(body.pollMs, 500, 120000, cfg.pollMs),
            sealAfterMs: num(body.sealAfterMs, 1000, 900000, cfg.sealAfterMs),
            scanEveryMs: num(body.scanEveryMs, 1000, 300000, cfg.scanEveryMs),
            maxSessionsPerApp: num(body.maxSessionsPerApp, 0, 5000, cfg.maxSessionsPerApp),
            orphanAfterMinutes: num(body.orphanAfterMinutes, 1, 10080, cfg.orphanAfterMinutes),
            backupKeep: num(body.backupKeep, 1, 100, cfg.backupKeep),
            sweepMissing: body.sweepMissing === true,
            backupOnStart: body.backupOnStart !== false,
            workspacesRoot: typeof body.workspacesRoot === 'string' ? body.workspacesRoot : cfg.workspacesRoot || '',
          }
          try {
            const written = writeProfileConfig(next)
            // Values that only affect future ticks can be adopted immediately.
            cfg.pollMs = next.pollMs
            cfg.sealAfterMs = next.sealAfterMs
            cfg.scanEveryMs = next.scanEveryMs
            cfg.maxSessionsPerApp = next.maxSessionsPerApp
            cfg.orphanAfterMinutes = next.orphanAfterMinutes
            cfg.backupKeep = next.backupKeep
            cfg.sweepMissing = next.sweepMissing
            cfg.backupOnStart = next.backupOnStart
            if (next.workspacesRoot) cfg.workspacesRoot = next.workspacesRoot
            sendJson(res, {
              ok: true,
              config: { ...next, workspacesRoot: cfg.workspacesRoot || null },
              note: written ? '已保存到 profile 配置' : '已生效（未能写入配置文件）',
            })
          } catch (error) {
            sendJson(res, { ok: false, error: String(error && error.message) })
          }
        },
      }),
    )
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/agent-sync/import',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405).end('method not allowed')
            return
          }
          const body = await readJsonBody(req)
          const target = typeof body.path === 'string' ? body.path.trim() : ''
          const title = typeof body.title === 'string' ? body.title.trim() : ''
          const appId = typeof body.app === 'string' && body.app.trim() ? body.app.trim() : 'manual'
          if (!target) {
            sendJson(res, { ok: false, error: '请填写会话文件或目录路径' })
            return
          }
          if (!fs.existsSync(target)) {
            sendJson(res, { ok: false, error: '路径不存在：' + target })
            return
          }
          try {
            const result = await importFromPath({ target, title, appId })
            sendJson(res, { ok: true, ...result })
          } catch (error) {
            sendJson(res, { ok: false, error: String(error && error.message) })
          }
        },
      }),
    )
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/agent-sync/status',
        handler: (_req, res) => {
          const report = lastReport || { at: null, workspacesRoot: workspacesRoot || null, apps: [], sources: [] }
          const payload = JSON.stringify({
            at: report.at,
            workspacesRoot: report.workspacesRoot || workspacesRoot || null,
            mirrored: report.sources.filter((item) => item.emittedTurns > 0).length,
            errors: report.sources.filter((item) => item.error).length,
            orphaned: report.sources.filter((item) => item.orphaned).length,
            projectionCache: cacheProbe,
            apps: report.apps.map((app) => ({
              id: app.id,
              name: app.name,
              scanned: app.scanned,
              workspace: app.workspace,
              error: app.error,
            })),
          })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(payload)
        },
      }),
    )
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: '/agent-sync/backup',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405).end('method not allowed')
            return
          }
          try {
            const state = backupState()
            const mirrors = backupMirrors()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, state, ...mirrors }))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: String(error && error.message) }))
          }
        },
      }),
    )
  }

  let baseWorkspace
  let workspacesRoot
  let busy = false
  let stopped = false
  let dirty = false
  let statusCache = ''
  let lastReport = null
  const workspaceCache = new Map()
  let pruned = false

  /**
   * Remove workspaces this plugin created nested inside itself (a layout bug in
   * an earlier build). Deletion goes through the registry so the running process
   * cannot resurrect them from memory.
   */
  const pruneStrayWorkspaces = async () => {
    if (pruned) return
    pruned = true
    for (const candidate of (registry && typeof registry.list === 'function' ? registry.list() : [])) {
      const depth = (candidate.path.match(/agent-sync-workspaces/g) || []).length
      if (depth < 2) continue
      const target = candidate.path
      try {
        await registry.delete(candidate.id)
        log('removed stray workspace', target)
      } catch (error) {
        log('stray workspace delete failed', String(error && error.message))
        continue
      }
      try {
        fs.rmSync(target, { recursive: true, force: true })
      } catch {
        // the record is gone; a leftover empty directory is harmless
      }
    }
  }

  /**
   * Retire mirrors whose source session vanished from the application's store.
   * A long grace period keeps a temporarily unreadable store from hiding tasks;
   * the sweep is skipped when a per-app cap could make a live source look gone.
   */
  const sweepMissingSources = async (seen) => {
    if (cfg.maxSessionsPerApp > 0) return
    const now = Date.now()
    const orphanAfter = cfg.orphanAfterMinutes * 60000
    const archiveAfter = cfg.missingGraceMinutes * 60000
    for (const [key, record] of store.sources) {
      if (seen.has(key)) {
        if (record.missingSince !== undefined) {
          delete record.missingSince
          dirty = true
        }
        if (record.orphaned) {
          delete record.orphaned
          dirty = true
        }
        continue
      }
      if (record.archived) continue
      if (record.missingSince === undefined) {
        record.missingSince = now
        dirty = true
        continue
      }
      const age = now - record.missingSince
      if (!record.orphaned && age >= orphanAfter) {
        record.orphaned = true
        dirty = true
        log('source missing but mirror kept (orphaned)', key)
      }
      // Mirrored logs live under DSH_HOME and outlive the source application;
      // archiving them is opt-in only.
      if (!cfg.sweepMissing || age < archiveAfter) continue
      try {
        if (record.emittedTurns > 0) await registry.archiveSession(record.mirrorId)
        record.archived = true
        record.missingReason = 'source-gone'
        dirty = true
        log('archived mirror whose source disappeared (sweepMissing)', key)
      } catch (error) {
        log('archive missing source failed', key, String(error && error.message))
      }
    }
  }

  const pickBase = () => {
    const all = (registry && typeof registry.list === 'function' ? registry.list() : [])
    if (all.length === 0) return undefined
    // Never anchor the root on a workspace this plugin created: doing so would
    // nest agent-sync-workspaces inside itself on the next activation.
    const outside = all.find((candidate) => !candidate.path.includes('agent-sync-workspaces'))
    return outside || all[0]
  }

  const ensureWorkspacesRoot = () => {
    if (workspacesRoot) return workspacesRoot
    const base = pickBase()
    const root = cfg.workspacesRoot
      ? cfg.workspacesRoot
      : base
        ? path.join(path.dirname(base.path), 'agent-sync-workspaces')
        : path.join(home, 'agent-sync-workspaces')
    fs.mkdirSync(root, { recursive: true })
    workspacesRoot = root
    return root
  }

  /** One workspace per application; its title is the application's name. */
  const workspaceFor = async (app) => {
    if (workspaceCache.has(app.id)) return workspaceCache.get(app.id)
    const root = ensureWorkspacesRoot()
    const dir = path.join(root, app.id)
    fs.mkdirSync(dir, { recursive: true })
    const canonical = fs.realpathSync(dir)
    let ws = (registry && typeof registry.list === 'function' ? registry.list() : []).find((candidate) => candidate.path.toLowerCase() === canonical.toLowerCase())
    if (!ws) {
      try {
        ws = await registry.create(canonical, app.name)
        log('created workspace', app.name, canonical)
      } catch (error) {
        log('workspace create failed', app.id, String(error && error.message))
        ws = (registry && typeof registry.list === 'function' ? registry.list() : []).find((candidate) => candidate.path.toLowerCase() === canonical.toLowerCase())
      }
    }
    if (ws) {
      workspaceCache.set(app.id, ws)
      if (ws.title !== app.name) {
        try {
          await ws.setTitle(app.name)
        } catch {
          // a title that cannot be updated is not worth failing the sync
        }
      }
    }
    return ws
  }

  /**
   * Import one session file, or every session file under a directory, without
   * requiring it to sit in an application's standard root. Parsing reuses the
   * same primitives the automatic adapters use, so turns group identically.
   */
  const importFromPath = async ({ target, title, appId }) => {
    const stat = fs.statSync(target)
    const files = []
    if (stat.isDirectory()) {
      const walk = (dir, depth) => {
        if (depth > 6) return
        let entries = []
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) walk(full, depth + 1)
          else if (/\.(jsonl|json|ndjson|log)$/i.test(entry.name)) files.push(full)
        }
      }
      walk(target, 0)
    } else {
      files.push(target)
    }
    if (files.length === 0) return { imported: 0, scanned: 0, error: '没有找到 .jsonl/.json/.ndjson/.log 文件' }

    let imported = 0
    const failures = []
    for (const file of files.slice(0, 200)) {
      const key = 'manual:' + crypto.createHash('sha1').update(file).digest('hex').slice(0, 16)
      try {
        const st = createSourceState(key)
        st.fp = file
        await readNewLines(st, file, parseAnyRecord)
        if (!st.items.length) {
          failures.push({ file, error: '没有可导入的对话内容' })
          continue
        }
        const described = describe(st, { id: appId || 'manual', name: appId || '手动导入' })
        if (!described) {
          failures.push({ file, error: '解析后没有对话轮次' })
          continue
        }
        described.key = key
        described.appId = appId || 'manual'
        described.hasHuman = true
        if (title) described.title = title
        if (!described.title) described.title = path.basename(file).replace(/\.(jsonl|json|ndjson|log)$/i, '')
        await syncSource(described)
        const mirrorRecord = store.sources.get(described.key)
        const mirrorId = (mirrorRecord && mirrorRecord.mirrorId) || lastMirrorId
        if (mirrorId) {
          await refreshProjectionCache(mirrorId, {
            version: FORMAT_VERSION,
            id: mirrorId,
            createdAt: (mirrorRecord && mirrorRecord.firstAt) || Date.now(),
            isSeeded: false,
          })
        }
        imported += 1
      } catch (error) {
        failures.push({ file, error: String(error && error.message) })
      }
    }
    dirty = true
    const ws = ensureWorkspacesRoot()
    return {
      imported,
      scanned: files.length,
      failed: failures.length,
      failures: failures.slice(0, 5),
      workspace: ws ? ws.title : null,
    }
  }

  /**
   * Rebuild this mirror's projection-cache row from its complete log. Without a
   * row the session list has nothing to render, which is why an imported task
   * could exist on disk yet never appear in its workspace.
   */
  const cacheProbe = { available: false, lastError: null, lastOk: null, lastId: null }

  const refreshProjectionCache = async (id, meta) => {
    cacheProbe.available = Boolean(projectionCache && typeof projectionCache.coldSnapshot === 'function')
    cacheProbe.lastId = id
    if (!cacheProbe.available) {
      cacheProbe.lastError = 'sessionProjectionCache unavailable'
      return
    }
    let reader
    try {
      reader = await persistence.open(id, 'read')
      // The cache row is matched by header identity (version/createdAt/cwd/
      // isSeeded), so the stored header must win over a reconstructed one.
      const stored = reader && reader.header
      if (stored && stored.id) meta = stored
      const all = []
      let from = 0
      for (;;) {
        const batch = await reader.read(from, 500)
        const events = (batch && batch.events) || []
        if (events.length === 0) break
        all.push(...events)
        from += events.length
        if (all.length > 20000) break
      }
      const snapshot = projectionCache.coldSnapshot(meta, 0, all)
      cacheProbe.lastOk = { events: all.length, asOfSeq: snapshot && snapshot.asOfSeq }
      cacheProbe.lastError = null
      log('projection cache rebuilt', id, 'asOfSeq=' + (snapshot && snapshot.asOfSeq))
    } catch (error) {
      cacheProbe.lastError = String(error && error.message)
      log('projection cache rebuild failed', id, cacheProbe.lastError)
    } finally {
      if (reader) {
        try {
          await reader.close()
        } catch {
          // closing a read handle must not break the mirror
        }
      }
    }
  }

  const attach = async (id, ws) => {
    if (!ws) return
    try {
      if (ws.sessionIds.includes(id)) return
      await ws.attachSession(id)
      log('attached mirrored session', id, 'to', ws.title)
    } catch (error) {
      log('attach failed', id, String(error && error.message))
    }
  }

  const syncSource = async (source) => {
    lastMirrorId = null
    const record = store.sources.get(source.key) || {
      mirrorId: mirrorIdFor(source.key),
      appId: source.appId,
      emittedTurns: 0,
      droppedTurns: 0,
      lastEventCount: undefined,
      detached: false,
      title: undefined,
    }
    record.appId = source.appId
    if (record.detached) return

    // The producer rewrote its log (rotation/truncation): retire the old mirror
    // and continue under a fresh identity instead of appending onto stale state.
    if (source.reset !== (record.resetSeen || 0)) {
      if (record.emittedTurns > 0 && !record.archived) {
        try {
          await registry.archiveSession(record.mirrorId)
        } catch {
          // the old mirror is already gone; nothing to retire
        }
      }
      record.idAttempt = (record.idAttempt || 0) + 1
      record.emittedTurns = 0
      record.droppedTurns = 0
      delete record.lastEventCount
      delete record.firstUserSeq
      delete record.title
      delete record.detached
      delete record.archived
      delete record.lastError
      record.resetSeen = source.reset
      store.sources.set(source.key, record)
      dirty = true
      log('source was rewritten, rebuilt mirror for', source.key)
    }

    // A session id can be "known" to the persistence service even after its log
    // was removed on disk; a collision then bumps the attempt and mints a fresh
    // deterministic id instead of retrying forever.
    record.mirrorId = mirrorIdFor(source.key, record.idAttempt || 0)

    // A source that carries no human conversation (heartbeat polls, system
    // notifications) must not sit in the task list: archive a mirror built for
    // it earlier and stop tracking it.
    if (source.hasHuman !== true) {
      if (record.emittedTurns > 0 && !record.archived) {
        try {
          await registry.archiveSession(record.mirrorId)
          record.archived = true
          store.sources.set(source.key, record)
          dirty = true
          log('archived noise-only mirror', source.key)
        } catch (error) {
          log('archive failed', source.key, String(error && error.message))
        }
      }
      return
    }

    const ws = await workspaceFor({ id: source.appId, name: source.appName })

    const turns = groupTurns(source.items)
    if (turns.length === 0) return
    if (source.droppedTurns > record.emittedTurns) record.emittedTurns = source.droppedTurns

    const idle = Date.now() - source.lastItemAt
    let sealedCount = turns.length
    if (idle < cfg.sealAfterMs && sealedCount > 0) sealedCount -= 1
    const absoluteEnd = source.droppedTurns + sealedCount
    const desiredTitle = `[${source.label}] ${source.title || '会话'}`
    const titleChanged = record.title !== desiredTitle
    if (absoluteEnd <= record.emittedTurns && !titleChanged) {
      store.sources.set(source.key, record)
      return
    }
    const absoluteStart = Math.max(record.emittedTurns, source.droppedTurns)
    const pending = turns.slice(absoluteStart - source.droppedTurns, sealedCount)
    if (pending.length === 0 && !titleChanged) return

    const id = record.mirrorId
    let snapshot
    try {
      snapshot = await persistence.stat(id)
    } catch (error) {
      log('stat failed', id, String(error && error.message))
      return
    }

    let handle
    let seq
    let created = false
    try {
      if (!snapshot && pending.length === 0) {
        store.sources.set(source.key, record)
        return
      }
      if (!snapshot) {
        if (!ws) return
        handle = await persistence.create({
          version: FORMAT_VERSION,
          id,
          createdAt: source.firstAt || Date.now(),
          cwd: ws.path,
          isSeeded: false,
        })
        created = true
        seq = 0
        await attach(id, ws)
      } else {
        // Detect external growth by looking at the log tail itself: `eventCount`
        // is an optional hint whose meaning differs per backend.
        let externalGrowth = false
        if (typeof record.lastEventCount === 'number' && record.lastEventCount > 0) {
          const readHandle = await persistence.open(id, 'read')
          try {
            const tail = await readHandle.read(Math.max(0, record.lastEventCount - 1), 4)
            externalGrowth = (tail.events || []).some((event) => event.seq >= record.lastEventCount)
          } finally {
            await readHandle.close()
          }
        }
        if (externalGrowth) {
          record.detached = true
          record.detachedAt = Date.now()
          log('stopped mirroring (session gained local events)', source.key)
          store.sources.set(source.key, record)
          dirty = true
          return
        }
        seq = typeof record.lastEventCount === 'number' ? record.lastEventCount : snapshot.eventCount || 0
        handle = await persistence.open(id, 'write')
      }

      const events = []
      let turnNumber = record.emittedTurns
      let firstUserSeq = record.firstUserSeq
      for (const turn of pending) {
        turnNumber += 1
        const built = eventsForTurn(turn, turnNumber, seq, source.appId)
        if (firstUserSeq === undefined) {
          const userEvent = built.find((event) => event.type === 'user/message')
          if (userEvent) firstUserSeq = userEvent.seq
        }
        events.push(...built)
        seq += built.length
      }
      // A non-user title must cite the message it was derived from, otherwise
      // the stored log is rejected as corrupt the next time it is opened.
      if (titleChanged && firstUserSeq !== undefined) {
        events.push(titleEventFor(seq++, desiredTitle, firstUserSeq))
        record.title = desiredTitle
        record.firstUserSeq = firstUserSeq
      }
      await handle.append(events)
      await handle.flush()
      record.lastEventCount = seq
      record.emittedTurns = absoluteEnd
      record.droppedTurns = source.droppedTurns
      record.detached = false
      delete record.lastError
      store.sources.set(source.key, record)
      dirty = true
      log(`mirrored ${pending.length} turn(s) from ${source.label}: ${source.title || source.key}`, created ? '(new task)' : '')
      await refreshProjectionCache(id, {
        version: FORMAT_VERSION,
        id,
        createdAt: source.firstAt || Date.now(),
        cwd: ws ? ws.path : undefined,
        isSeeded: false,
      })
      lastMirrorId = id
    } catch (error) {
      const text = String(error && error.message)
      if (/already exists/i.test(text)) {
        record.idAttempt = (record.idAttempt || 0) + 1
        delete record.lastError
        store.sources.set(source.key, record)
        dirty = true
        log('mirror id collided, switching to a fresh id', source.key, record.idAttempt)
        return
      }
      record.lastError = text
      store.sources.set(source.key, record)
      dirty = true
      if (/already owned|SessionAlreadyOwned|busy/i.test(text)) {
        log('mirror busy, will retry', source.key)
      } else {
        log('mirror write failed', source.key, text)
      }
    } finally {
      if (handle) {
        try {
          await handle.close()
        } catch {
          // closing a failed handle must not break the loop
        }
      }
    }
  }

  const saveStatus = (payload) => {
    let text
    try {
      text = JSON.stringify(payload, null, 2)
    } catch {
      return
    }
    if (text === statusCache) return
    statusCache = text
    try {
      const file = path.join(path.dirname(storeFile(cfg)), 'status.json')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text, 'utf8')
    } catch {
      // status is a convenience, never a reason to fail a tick
    }
  }

  const tick = async () => {
    if (busy || stopped) return
    busy = true
    try {
      baseWorkspace = pickBase()
      if (!baseWorkspace) return
      await pruneStrayWorkspaces()
      const report = { at: new Date().toISOString(), workspacesRoot: workspacesRoot || null, apps: [], sources: [] }
      const seen = new Set()
      for (const adapter of adapters) {
        const summary = { id: adapter.app.id, name: adapter.app.name, scanned: 0, workspace: null, error: null }
        report.apps.push(summary)
        if (adapter.nextAttempt && Date.now() < adapter.nextAttempt) {
          summary.error = 'backoff'
          continue
        }
        let sources
        try {
          sources = await adapter.poll()
          summary.scanned = sources.length
          adapter.failures = 0
          adapter.nextAttempt = 0
        } catch (error) {
          summary.error = String(error && error.message)
          adapter.failures = (adapter.failures || 0) + 1
          adapter.nextAttempt = Date.now() + backoffDelayMs(adapter.failures)
          log('poll failed', adapter.app.id, summary.error, 'backoff', adapter.failures)
          continue
        }
        for (const source of sources.slice(0, cfg.maxSessionsPerApp > 0 ? cfg.maxSessionsPerApp : sources.length)) {
          seen.add(source.key)
          const record = store.sources.get(source.key)
          report.sources.push({
            key: source.key,
            app: source.appName,
            title: source.title || null,
            hasHuman: source.hasHuman === true,
            turns: source.turns || 0,
            emittedTurns: record ? record.emittedTurns : 0,
            lastEventCount: record ? record.lastEventCount ?? null : null,
            mirrorId: record ? record.mirrorId : null,
            detached: record ? record.detached === true : false,
            archived: record ? record.archived === true : false,
            orphaned: record ? record.orphaned === true : false,
            error: record ? record.lastError || null : null,
          })
          try {
            await syncSource(source)
          } catch (error) {
            log('sync failed', source.key, String(error && error.message))
          }
        }
        const ws = workspaceCache.get(adapter.app.id)
        if (ws) summary.workspace = { title: ws.title, path: ws.path }
      }
      await sweepMissingSources(seen)
      lastReport = report
      saveStatus(report)
      if (dirty) {
        saveStore(store, cfg)
        dirty = false
      }
    } finally {
      busy = false
    }
  }

  ctx.effect(() => {
    const run = () => {
      void tick().catch((error) => log('tick failed', String(error && error.message)))
    }
    const timer = setInterval(run, cfg.pollMs)
    timer.unref?.()
    run()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, 'agent-sync.loop')

  log(`started: apps=${adapters.map((a) => a.app.id).join(',') || '(none found)'} pollMs=${cfg.pollMs}`)
}
