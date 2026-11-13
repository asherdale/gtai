import http from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createHash, randomBytes, randomInt } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { extname, join, normalize } from 'node:path'
import { loadGraph } from './sim.mjs'
import { runAttempt, moderate } from './runner.mjs'
import { renderCard, renderGenericCard } from './card.mjs'
import { PROFILES } from './omnara.mjs'

const PORT = Number(process.env.PORT ?? 8787)
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3)
const MAX_PER_HOUR = Number(process.env.MAX_PER_HOUR ?? 8)
const MODEL_NAME = /model:\s*\n\s+provider_config:\s*\S+\s*\n\s+name:\s*(\S+)/
const DRIVERS = Object.keys(PROFILES).filter((k) => existsSync(new URL(`./agents/driver-${k}.yaml`, import.meta.url)))
const SLUGS = Object.fromEntries(DRIVERS.map((k) => [k, readFileSync(new URL(`./agents/driver-${k}.yaml`, import.meta.url), 'utf8').match(MODEL_NAME)[1]]))
if (!DRIVERS.length) throw new Error('No drivers: run `npm run setup` to create the agent profiles')
const MODELS = Object.fromEntries(DRIVERS.map((k) => [k, SLUGS[k]]).sort((a, b) => a[1].localeCompare(b[1])))
const STARTS = ['Castro', 'Chinatown', 'Dolores Park', 'Ferry Building', "Fisherman's Wharf", 'Haight-Ashbury', 'Lombard Street', 'Oracle Park', 'Painted Ladies', 'Palace of Fine Arts', 'Salesforce Tower', 'Twin Peaks', 'Union Square']
const DEFAULT_START = 'Salesforce Tower'
const ATTEMPTS = 3
const ROOT = import.meta.dirname
const SITE = join(ROOT, 'site')
const DATA_DIR = process.env.DATA_DIR ?? join(ROOT, 'data')
if (process.env.NODE_ENV === 'production' && !process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY: chases are not moderated without it')
mkdirSync(join(DATA_DIR, 'chases'), { recursive: true })
mkdirSync(join(DATA_DIR, 'cards'), { recursive: true })

const graph = loadGraph()
const DATA = Object.fromEntries(['graph', 'features', 'buildings'].map((n) => { const body = gzipSync(readFileSync(join(ROOT, `data/${n}.json`))); return [`/data/${n}.json`, { body, etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"` }] }))
const db = new DatabaseSync(join(DATA_DIR, 'chase.db'))
db.exec(`create table if not exists chases (
  id text primary key, root_id text, attempt integer, player text, name text, prompt text, start text, model text,
  seed integer, status text, time real, reason text, stars integer, agent_id text, created_at text, ip text
);
create index if not exists chases_done on chases(status, time desc);`)
db.exec(`update chases set status = 'failed' where status in ('queued', 'running')`)

const live = new Map()
const queue = []
let running = 0, avgRun = 45
const queueMsg = (p) => `event: queue\ndata: ${JSON.stringify({ position: p, eta: Math.round(Math.ceil(p / CONCURRENCY) * avgRun) })}\n\n`
const hits = new Map()

const id = () => randomBytes(6).toString('base64url')
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const now = () => new Date().toISOString()
const row = (cid) => db.prepare('select * from chases where id = ?').get(cid)
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)) }
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]))
const ipOf = (req) => (req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? '').toString()
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 10000) req.destroy() }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')) } catch { resolve({}) } }) })
const publicRow = (r, player) => r && {
  id: r.id, root_id: r.root_id, attempt: r.attempt, name: r.name, start: r.start, model: r.model, slug: SLUGS[r.model] ?? r.model, status: r.status,
  time: r.time, reason: r.reason, stars: r.stars, created_at: r.created_at,
  prompt: r.prompt, mine: r.player === player,
  position: r.status === 'queued' ? queue.findIndex((j) => j.id === r.id) + 1 : 0,
  attempts_left: MODELS[r.model] ? Math.max(0, ATTEMPTS - db.prepare("select count(*) n from chases where root_id = ? and status != 'failed'").get(r.root_id).n) : 0,
  previous_time: r.attempt > 1 ? db.prepare('select time from chases where root_id = ? and attempt = ?').get(r.root_id, r.attempt - 1)?.time ?? null : null,
}

function standing(r) {
  if (r.status !== 'done') return {}
  const rank = db.prepare("select count(*) n from chases where status = 'done' and (time > ? or (time = ? and created_at < ?))").get(r.time, r.time, r.created_at).n + 1
  const { total, beaten } = db.prepare("select count(*) total, sum(time < ?) beaten from chases where status = 'done' and id != ?").get(r.time, r.id)
  return { rank, beat_pct: total ? Math.round((100 * beaten) / total) : null }
}

function limited(ip) {
  const list = (hits.get(ip) ?? []).filter((t) => Date.now() - t < 3600_000)
  hits.set(ip, list)
  if (list.length >= MAX_PER_HOUR) return true
  list.push(Date.now())
  return false
}

function enqueue(job) { queue.push(job); pump() }
function pump() {
  while (running < CONCURRENCY && queue.length) {
    const job = queue.shift()
    running++
    run(job).catch((e) => { console.error('chase failed', job.id, e.message); db.prepare("update chases set status = 'failed' where id = ?").run(job.id); for (const s of live.get(job.id)?.subs ?? []) s.write('event: failed\ndata: {}\n\n') })
      .finally(() => { running--; live.get(job.id)?.close(); live.delete(job.id); pump() })
  }
}

async function run(job) {
  const r = row(job.id), t0 = Date.now()
  const state = { meta: { id: r.id, name: r.name, prompt: r.prompt, start: r.start, model: r.model, attempt: r.attempt }, frames: [], events: [], result: null, subs: new Set(),
    close() { for (const s of this.subs) { s.write('event: end\ndata: {}\n\n'); s.end() } this.subs.clear() } }
  live.set(job.id, state)
  db.prepare("update chases set status = 'running' where id = ?").run(job.id)
  for (const s of job.waiting ?? []) attach(s, state)
  const { agentId, record } = await runAttempt(graph, {
    agentId: job.agentId, model: r.model, strategy: r.prompt, start: r.start, seed: r.seed, name: r.name, previous: job.previous,
    onUpdate: (u) => {
      state.frames.push(...u.frames); state.events.push(...u.events); if (u.result) state.result = u.result
      const msg = `event: update\ndata: ${JSON.stringify(u)}\n\n`
      for (const s of state.subs) s.write(msg)
    },
  })
  writeFileSync(join(DATA_DIR, `chases/${job.id}.json`), JSON.stringify({ meta: state.meta, ...record }))
  db.prepare("update chases set status = 'done', time = ?, reason = ?, stars = ?, agent_id = ? where id = ?").run(record.result.time, record.result.reason, record.result.stars, agentId, job.id)
  avgRun = avgRun * 0.8 + ((Date.now() - t0) / 1000) * 0.2
}

function attach(res, state) {
  res.write(`event: init\ndata: ${JSON.stringify({ meta: state.meta, frames: state.frames, events: state.events, result: state.result })}\n\n`)
  state.subs.add(res)
  res.on('close', () => state.subs.delete(res))
}

async function create(req, res, player) {
  const body = await readBody(req)
  const prompt = String(body.prompt ?? '').trim(), start = String(body.start ?? ''), model = String(body.model ?? '')
  const handle = String(body.name ?? '').trim().replace(/^@/, '')
  if (handle && !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return send(res, 400, { error: "That's not a valid X handle.", field: 'name' })
  const name = handle || 'anonymous'
  if (prompt.length < 3 || prompt.length > 280) return send(res, 400, { error: 'Write a strategy between 3 and 280 characters.', field: 'prompt' })
  if (!STARTS.includes(start) || !MODELS[model]) return send(res, 400, { error: 'Pick a start and a driver.' })
  if (limited(ipOf(req))) return send(res, 429, { error: 'Too many chases from you this hour. Try again later.' })
  if (!(await moderate(`${name}: ${prompt}`))) return send(res, 400, { error: "That strategy or name can't be used." })
  const cid = id()
  db.prepare("insert into chases (id, root_id, attempt, player, name, prompt, start, model, seed, status, created_at, ip) values (?, ?, 1, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
    .run(cid, cid, player, name, prompt, start, model, randomInt(1, 2 ** 31), now(), ipOf(req))
  enqueue({ id: cid })
  send(res, 200, { id: cid })
}

async function again(req, res, player, cid) {
  const r = row(cid)
  if (!r || r.player !== player) return send(res, 404, { error: 'Not found.' })
  if (!MODELS[r.model]) return send(res, 400, { error: 'This driver has been retired.' })
  if (db.prepare("select 1 from chases where root_id = ? and status in ('queued', 'running')").get(r.root_id)) return send(res, 400, { error: 'This strategy is already running.' })
  const done = db.prepare("select * from chases where root_id = ? and status = 'done' order by attempt desc").all(r.root_id), last = done[0]
  if (!last || done.length >= ATTEMPTS) return send(res, 400, { error: 'No runs left for this strategy.' })
  if (limited(ipOf(req))) return send(res, 429, { error: 'Too many chases from you this hour. Try again later.' })
  const nid = id()
  db.prepare("insert into chases (id, root_id, attempt, player, name, prompt, start, model, seed, status, created_at, ip) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)")
    .run(nid, r.root_id, done.length + 1, player, r.name, r.prompt, r.start, r.model, randomInt(1, 2 ** 31), now(), ipOf(req))
  enqueue({ id: nid, agentId: last.agent_id, previous: { time: last.time, reason: last.reason } })
  send(res, 200, { id: nid })
}

function stream(req, res, player, cid) {
  const r = row(cid)
  if (!r) return send(res, 404, { error: 'Not found.' })
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(`event: meta\ndata: ${JSON.stringify(publicRow(r, player))}\n\n`)
  const state = live.get(cid)
  if (state) return attach(res, state)
  if (r.status === 'done') {
    const rec = JSON.parse(readFileSync(join(DATA_DIR, `chases/${cid}.json`), 'utf8'))
    res.write(`event: init\ndata: ${JSON.stringify({ meta: rec.meta, frames: rec.frames, events: rec.events, result: rec.result })}\n\n`)
    res.write('event: end\ndata: {}\n\n'); return res.end()
  }
  if (r.status === 'queued') {
    const job = queue.find((j) => j.id === cid)
    if (job) { (job.waiting ??= []).push(res); res.write(queueMsg(queue.indexOf(job) + 1)); const tick = setInterval(() => { const p = queue.findIndex((j) => j.id === cid) + 1; if (!p) return clearInterval(tick); res.write(queueMsg(p)) }, 2000); res.on('close', () => clearInterval(tick)); return }
  }
  res.write('event: end\ndata: {}\n\n'); res.end()
}

function leaderboard(res) {
  const rows = db.prepare("select id, name, start, model, time from chases where status = 'done' order by time desc, created_at asc limit 100").all()
  send(res, 200, { rows: rows.map((r) => ({ id: r.id, name: r.name, start: r.start, slug: SLUGS[r.model] ?? r.model, time: r.time })) })
}

let genericCard = null
function card(res, cid) {
  const r = row(cid), file = join(DATA_DIR, `cards/${cid}.png`)
  if (r?.status !== 'done') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' }); return res.end(genericCard ??= renderGenericCard(graph))
  }
  if (!existsSync(file)) {
    const rec = JSON.parse(readFileSync(join(DATA_DIR, `chases/${cid}.json`), 'utf8'))
    writeFileSync(file, renderCard(graph, { ...rec, meta: { name: r.name, model: r.model, slug: SLUGS[r.model] } }))
  }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' })
  createReadStream(file).pipe(res)
}

const TAGLINE = 'How long can your AI agent survive a 5-star wanted level?'
function page(req, res, file, { title = 'GTAI: Vibe City', image = '/og.png' } = {}) {
  const origin = process.env.PUBLIC_URL ?? `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}`
  const html = readFileSync(join(SITE, file), 'utf8').replace('</title>', `</title>
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${TAGLINE}">
<meta property="og:image" content="${esc(origin + image)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">`).replace('<!--REPO-->', process.env.REPO_URL ? `<a class="btn alt" href="${esc(process.env.REPO_URL)}" target="_blank">View the code</a>` : '').replace('<!--REPO_NAV-->', process.env.REPO_URL ? `<a href="${esc(process.env.REPO_URL)}" target="_blank">GitHub</a>` : '').replace('<!--REPO_PILL-->', process.env.REPO_URL ? `<a class="pill" href="${esc(process.env.REPO_URL)}" target="_blank">GitHub</a>` : '')
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html)
}

function chasePage(req, res, cid) {
  const r = cid && row(cid)
  if (!r) return page(req, res, 'chase.html')
  const who = r.name && r.name !== 'anonymous' ? `@${r.name}'s AI agent` : 'An AI agent'
  page(req, res, 'chase.html', { title: r.status === 'done' ? `${who} survived ${fmt(r.time)} in GTAI: Vibe City` : 'GTAI: Vibe City', image: `/api/chases/${cid}/card.png` })
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2' }
function serveStatic(req, res, path) {
  const data = DATA[path]
  if (data) {
    if (req.headers['if-none-match'] === data.etag) { res.writeHead(304, { ETag: data.etag }); return res.end() }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-cache', ETag: data.etag }); return res.end(data.body)
  }
  let file = normalize(join(SITE, path === '/' ? 'index.html' : path))
  if (!file.startsWith(SITE)) return send(res, 404, { error: 'Not found.' })
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html')
  if (!existsSync(file) && existsSync(file + '.html')) file += '.html'
  if (!existsSync(file)) return send(res, 404, { error: 'Not found.' })
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', ...(extname(file) === '.woff2' && { 'Cache-Control': 'public, max-age=31536000, immutable' }) })
  createReadStream(file).pipe(res)
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  let player = cookies(req).player
  const headers = {}
  if (!player || !/^[\w-]{8,32}$/.test(player)) { player = randomBytes(12).toString('base64url'); res.setHeader('Set-Cookie', `player=${player}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`) }
  try {
    const m = url.pathname.match(/^\/api\/chases\/([\w-]+)(\/stream|\/again|\/card\.png)?$/)
    if (req.method === 'POST' && url.pathname === '/api/chases') return await create(req, res, player)
    if (m && m[2] === '/card.png') return card(res, m[1])
    if (url.pathname === '/chase' || url.pathname === '/chase.html') return chasePage(req, res, url.searchParams.get('id'))
    if (url.pathname === '/' || url.pathname === '/index.html') return page(req, res, 'index.html')
    if (url.pathname === '/how' || url.pathname === '/how.html') return page(req, res, 'how.html', { title: 'How it works · GTAI: Vibe City' })
    if (url.pathname === '/og.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }); return res.end(genericCard ??= renderGenericCard(graph)) }
    if (m && req.method === 'POST' && m[2] === '/again') return await again(req, res, player, m[1])
    if (m && m[2] === '/stream') return stream(req, res, player, m[1])
    if (m && !m[2]) { const r = row(m[1]); return r ? send(res, 200, { ...publicRow(r, player), ...standing(r) }) : send(res, 404, { error: 'Not found.' }) }
    if (url.pathname === '/api/leaderboard') return leaderboard(res)
    if (url.pathname === '/api/stats') return send(res, 200, db.prepare("select count(*) chases, count(distinct agent_id) agents from chases where status = 'done'").get())
    if (url.pathname === '/api/config') return send(res, 200, { starts: STARTS, default_start: DEFAULT_START, models: Object.entries(MODELS).map(([key, slug]) => ({ key, slug })) })
    return serveStatic(req, res, url.pathname)
  } catch (e) {
    console.error(e); send(res, 500, { error: 'Something went wrong.' }, headers)
  }
}).listen(PORT, () => console.log(`listening on http://localhost:${PORT} (concurrency ${CONCURRENCY})`))
