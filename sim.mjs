import { readFileSync } from 'node:fs'

const MPH = 0.44704
const TOP = { freeway: 110, main: 70, residential: 55, alley: 35 }
const COP_EDGE = 1.05
const TICK = 0.1
const FRAME_EVERY = 2
const STAR_HEAT = [0, 20, 50, 90, 140]
const UNITS = [2, 3, 5, 7, 9]
const ACCEL = 4, BRAKE = 8
const approach = (v, target) => (v == null ? target : target > v ? Math.min(target, v + ACCEL * TICK) : Math.max(target, v - BRAKE * TICK))
const STEEP = 0.06
const LOCKDOWN = 360
const TIP_EVERY = [30, 22, 16, 12, 8]
const FLOOR_HEAT = 3, FLOOR_TIPS = 0.4
const SEARCH_GROWTH = 15
const SIGHT = 150

export function loadGraph(path = new URL('./data/graph.json', import.meta.url)) {
  const g = JSON.parse(readFileSync(path, 'utf8'))
  const adj = g.nodes.map(() => [])
  g.edges.forEach((e, i) => {
    if (!e.closed) { adj[e.a].push({ e: i, to: e.b, dir: 1 }); adj[e.b].push({ e: i, to: e.a, dir: -1 }) }
    const p = e.pts
    e.outA = Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0])
    e.inB = Math.atan2(p.at(-1)[1] - p.at(-2)[1], p.at(-1)[0] - p.at(-2)[0])
    e.grade = (g.nodes[e.b][2] - g.nodes[e.a][2]) / e.len
    const seg = [0]
    for (let k = 1; k < p.length; k++) seg.push(seg[k - 1] + Math.hypot(p[k][0] - p[k - 1][0], p[k][1] - p[k - 1][1]))
    e.cum = seg
  })
  return { ...g, adj }
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const angDiff = (a, b) => { let d = b - a; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d }
const fmtTime = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`
const compass = (a) => ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'][((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8]

class Heap {
  constructor() { this.a = [] }
  push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p } }
  pop() {
    const a = this.a, top = a[0], last = a.pop()
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m } }
    return top
  }
  get size() { return this.a.length }
}

export class Chase {
  constructor(graph, { seed = 1, start = 'Mission' } = {}) {
    this.g = graph
    this.rand = mulberry32(seed)
    this.seed = seed
    this.startName = start
    this.t = 0
    this.heat = 0
    this.stars = 1
    this.t5 = null
    let s = graph.starts[start]
    if (graph.adj[s].length < 3) {
      const [sx, sy] = graph.nodes[s]
      s = graph.nodes.reduce((b, n, i) => (graph.adj[i].length >= 3 && Math.hypot(n[0] - sx, n[1] - sy) < Math.hypot(graph.nodes[b][0] - sx, graph.nodes[b][1] - sy) ? i : b), graph.adj.findIndex((a) => a.length >= 3))
    }
    this.startNode = s
    const first = graph.adj[s][0]
    this.player = { e: first.e, dir: -first.dir, s: graph.edges[first.e].len, mode: 'floor_it', stoppedUntil: null, jumpUntil: 0, v: null }
    this.lastSeen = { node: s, t: 0 }
    this.seen = true
    this.lostAt = null
    this.cops = []
    this.visits = new Map()
    this.roadblocks = []
    this.nextRoadblockAt = 0
    this.nextTipAt = TIP_EVERY[0]
    this.lastTip = null
    this.heli = null
    this.frames = []
    this.events = []
    this.done = null
    this.decisions = 0
    for (let i = 0; i < UNITS[0]; i++) this.spawnCop(700, 1000)
    this.request = null
    this.pending = null
    this.ticks = 0
  }

  pos(a) {
    const e = this.g.edges[a.e], d = a.dir === 1 ? a.s : e.len - a.s
    let k = 1
    while (k < e.cum.length - 1 && e.cum[k] < d) k++
    const p0 = e.pts[k - 1], p1 = e.pts[k], f = (d - e.cum[k - 1]) / Math.max(0.01, e.cum[k] - e.cum[k - 1])
    const x = p0[0] + (p1[0] - p0[0]) * f, y = p0[1] + (p1[1] - p0[1]) * f
    const h = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) + (a.dir === 1 ? 0 : Math.PI)
    return [x, y, h]
  }

  ahead(a) { const e = this.g.edges[a.e]; return a.dir === 1 ? e.b : e.a }

  grade(e, dir) { return this.g.edges[e].grade * dir }

  speedOn(eIdx, dir, cop) {
    const e = this.g.edges[eIdx]
    let v = TOP[e.cls] * MPH
    const gr = this.grade(eIdx, dir)
    if (gr > STEEP) v *= 0.7
    else if (gr < -STEEP) v *= 1.1
    if (cop) v *= COP_EDGE * (this.t5 === null ? 1 : 1 + 0.02 * Math.floor((this.t - this.t5) / 10))
    return v
  }

  spawnCop(minD, maxD) {
    const [px, py] = this.pos(this.player)
    const nodes = this.g.nodes
    for (let tries = 0; tries < 200; tries++) {
      const n = Math.floor(this.rand() * nodes.length)
      const d = Math.hypot(nodes[n][0] - px, nodes[n][1] - py)
      if (d >= minD && d <= maxD && this.g.adj[n].length) {
        const o = this.g.adj[n][Math.floor(this.rand() * this.g.adj[n].length)]
        this.cops.push({ e: o.e, dir: o.dir, s: 0, path: [], target: null, replanAt: 0, interceptor: false, searchTarget: null })
        return true
      }
    }
    return false
  }

  route(from, to) {
    if (from === to) return [to]
    const dist = new Map([[from, 0]]), prev = new Map(), h = new Heap()
    h.push(0, from)
    let expanded = 0
    while (h.size && expanded < 6000) {
      const [d, u] = h.pop(); expanded++
      if (u === to) break
      if (d > (dist.get(u) ?? Infinity)) continue
      for (const o of this.g.adj[u]) {
        const nd = d + this.g.edges[o.e].len / this.speedOn(o.e, o.dir, true)
        if (nd < (dist.get(o.to) ?? Infinity)) { dist.set(o.to, nd); prev.set(o.to, u); h.push(nd, o.to) }
      }
    }
    if (!prev.has(to)) return null
    const path = [to]
    while (path[0] !== from) path.unshift(prev.get(path[0]))
    return path
  }

  straightestExit(node, arriving) {
    const opts = this.g.adj[node].filter((o) => o.e !== arriving.e && !this.closed(o.e))
    if (!opts.length) return this.g.adj[node].find((o) => o.e === arriving.e) ?? this.g.adj[node][0]
    const inH = this.pos({ ...arriving, s: this.g.edges[arriving.e].len - 0.01 })[2]
    return opts.reduce((b, o) => (Math.abs(angDiff(inH, this.outHeading(o))) < Math.abs(angDiff(inH, this.outHeading(b))) ? o : b))
  }

  closed(e) { return this.roadblocks.some((r) => this.t - r.t < 60 && r.edges?.includes(e)) }

  outHeading(o) { const e = this.g.edges[o.e]; return o.dir === 1 ? e.outA : e.inB + Math.PI }

  predictAhead(steps) {
    let cur = { e: this.player.e, dir: this.player.dir }, node = this.ahead(this.player)
    const out = []
    for (let i = 0; i < steps; i++) {
      out.push(node)
      const nx = this.straightestExit(node, cur)
      cur = { e: nx.e, dir: nx.dir }; node = nx.to
    }
    return out
  }

  copSees(c, P) {
    if (this.g.edges[this.player.e].tunnel || this.t < this.player.jumpUntil) return false
    const [cx, cy] = this.pos(c)
    return Math.hypot(cx - P[0], cy - P[1]) <= SIGHT
  }

  describe(node, arriving) {
    const P = this.pos(this.player), stars = '★'.repeat(this.stars) + '☆'.repeat(5 - this.stars)
    const e = this.g.edges[this.player.e]
    const speedMph = Math.round((this.player.mode === 'pull_over' ? 0 : this.speedOn(this.player.e, this.player.dir, false) * (this.player.mode === 'cruise' ? 0.7 : 1)) / MPH)
    const lines = [`${fmtTime(this.t)} survived · ${stars} · ${e.name || 'unnamed street'} heading ${compass(P[2])} · ${speedMph} mph (${this.player.mode.replace('_', ' ')})`]
    const cops = this.cops.map((c) => { const [x, y] = this.pos(c); return { c, x, y, d: Math.hypot(x - P[0], y - P[1]) } }).sort((a, b) => a.d - b.d).slice(0, 4)
    const copDesc = cops.map(({ c, x, y, d }) => {
      const rel = angDiff(P[2], Math.atan2(y - P[1], x - P[0]))
      const where = Math.abs(rel) < Math.PI / 4 ? 'ahead' : Math.abs(rel) > (3 * Math.PI) / 4 ? 'behind' : rel > 0 ? 'to your right' : 'to your left'
      const street = this.g.edges[c.e].name || 'a side street'
      return `${Math.round(d)} m ${where} on ${street}${c.parkedUntil > this.t ? ' (parked at a roadblock)' : ''}${this.copSees(c, P) ? ' (sees you)' : ''}`
    })
    lines.push(`Cops (${this.cops.length} units${this.seen ? ', they can see you' : ', they lost sight of you'}): ${copDesc.join('; ')}`)
    if (this.lastTip && this.t - this.lastTip.t < 10) lines.push(`A 911 caller reported you at ${this.nodeName(this.lastTip.node)} ${Math.round(this.t - this.lastTip.t)} s ago; units are heading there.`)
    if (this.heli) lines.push(`Helicopter spotlight ${Math.round(Math.hypot(this.heli[0] - P[0], this.heli[1] - P[1]))} m away (sees through buildings within 150 m)`)
    const blocks = this.roadblocks.filter((r) => this.t - r.t < 60 && Math.hypot(this.g.nodes[r.node][0] - P[0], this.g.nodes[r.node][1] - P[1]) < 700)
    if (blocks.length) lines.push(`Roadblocks: police have closed ${blocks.map((r) => `${this.g.edges[r.edges[0]].name || 'a side street'} at ${this.nodeName(r.node)}`).join('; ')}. Closed roads are left out of your exits.`)
    const inH = this.pos({ ...arriving, s: this.g.edges[arriving.e].len - 0.01 })[2]
    const recent = (n) => this.visits.has(n) && this.t - this.visits.get(n) < 45
    const nextStop = (o) => { let n = o.to, cur = o; for (let i = 0; i < 80 && this.g.adj[n].length === 2; i++) { const x = this.g.adj[n].find((y) => y.e !== cur.e) ?? this.g.adj[n][0]; cur = x; n = x.to } return n }
    const exits = this.g.adj[node].map((o, i) => {
      if (this.closed(o.e)) return null
      const ed = this.g.edges[o.e]
      const rel = angDiff(inH, this.outHeading(o)), a = Math.abs(rel)
      const turn = o.e === arriving.e ? 'U-turn back' : a < 0.5 ? 'straight' : a < 1.0 ? (rel > 0 ? 'slight right' : 'slight left') : a < 2.4 ? (rel > 0 ? 'right' : 'left') : 'sharp ' + (rel > 0 ? 'right' : 'left')
      const gr = this.grade(o.e, o.dir), tags = [ed.cls === 'main' ? 'main street' : ed.cls]
      if (gr > STEEP) tags.push('steep uphill'); else if (gr < -STEEP) tags.push('steep downhill')
      if (ed.tunnel) tags.push('TUNNEL: hides you inside')
      const copHere = this.cops.filter((c) => c.e === o.e).length
      if (copHere) tags.push(`${copHere} cop${copHere > 1 ? 's' : ''} on this block`)
      const crest = this.grade(arriving.e, arriving.dir) > STEEP && gr < -STEEP
      if (crest) tags.push('hill crest: special "jump" available')
      const stop = nextStop(o)
      if (stop === node) tags.push('dead-end loop: brings you right back to this corner')
      else if (recent(stop)) tags.push('leads back to a corner you already passed')
      return `${String.fromCharCode(65 + i)}) ${turn} onto ${ed.name || 'unnamed street'} (heading ${compass(this.outHeading(o))}): ${tags.join(', ')}`
    })
    lines.push(`Next intersection: ${this.nodeName(node)}${recent(node) ? ' (you already passed through here: you are going in circles)' : ''}. Exits:`)
    lines.push(...exits.filter(Boolean))
    lines.push(`Any cop within ${SIGHT} m sees you, whatever your speed (tunnels hide you). Speeds: floor_it = full speed, but it is loud while you are hidden: your wanted level climbs 3x faster and 911 callers report you much more often. cruise = 70% speed; 911 callers report you less. pull_over = stop at this corner for 5 s; heat climbs slower and 911 callers report you even less.`)
    return lines.join('\n')
  }

  nodeName(n) {
    const names = [...new Set(this.g.adj[n].map((o) => this.g.edges[o.e].name).filter(Boolean))]
    return names.length ? names.slice(0, 2).join(' & ') : 'an unnamed corner'
  }

  requestDecision(node, arriving) {
    const options = this.g.adj[node].map((o, i) => ({ label: String.fromCharCode(65 + i), to: o.to, e: o.e, cls: this.g.edges[o.e].cls, tunnel: this.g.edges[o.e].tunnel, back: o.e === arriving.e })).filter((o) => !this.closed(o.e))
    this.request = { id: ++this.decisions, node, arriving: { e: arriving.e, dir: arriving.dir }, t: this.t, text: this.describe(node, arriving), options, wall: Date.now() }
    this.onRequest?.(this.request)
  }

  answer(id, decision) {
    if (!this.request || this.request.id !== id) return false
    this.pending = { ...decision, id, wall: Date.now() }
    this.events.push({ t: this.t, kind: 'decision', id, node: this.request.node, requestedT: this.request.t, ...decision, latency: (Date.now() - this.request.wall) / 1000 })
    return true
  }

  applyDecision(node, arriving, d) {
    this.visits.set(node, this.t)
    const opts = this.g.adj[node]
    let o = opts[(d.exit || 'A').toUpperCase().charCodeAt(0) - 65]
    if (!o || this.closed(o.e)) o = this.straightestExit(node, arriving)
    const mode = ['floor_it', 'cruise', 'pull_over'].includes(d.speed) ? d.speed : 'floor_it'
    const crest = this.grade(arriving.e, arriving.dir) > STEEP && this.grade(o.e, o.dir) < -STEEP
    if (mode === 'pull_over') {
      this.player.mode = 'pull_over'
      this.player.stoppedUntil = this.t + 5
      return
    }
    this.player.mode = mode
    this.player.e = o.e; this.player.dir = o.dir; this.player.s = 0
    if (d.special === 'jump' && crest) { this.player.s = Math.min(25, this.g.edges[o.e].len - 1); this.player.jumpUntil = this.t + 2; this.events.push({ t: this.t, kind: 'jump' }) }
  }

  busted(reason) {
    if (this.done) return
    this.done = { time: Math.round(this.t * 10) / 10, reason, stars: this.stars }
    this.events.push({ t: this.t, kind: 'busted', reason })
  }

  stepPlayer() {
    const p = this.player
    if (p.stoppedUntil !== null) {
      p.v = 0
      if (this.t < p.stoppedUntil) return
      if (!this.pending) return 'wait'
      const d = this.pending, node = this.ahead(p), arriving = { e: p.e, dir: p.dir }
      this.pending = null; this.request = null; p.stoppedUntil = null
      this.applyDecision(node, arriving, d)
      if (p.stoppedUntil !== null) this.requestDecision(node, arriving); else this.askNext()
      return
    }
    const e = this.g.edges[p.e]
    if (p.s < e.len) {
      p.v = approach(p.v, this.speedOn(p.e, p.dir, false) * (p.mode === 'cruise' ? 0.7 : 1))
      p.s = Math.min(e.len, p.s + p.v * TICK)
      if (p.s < e.len) return
    }
    const node = this.ahead(p)
    const deg = this.g.adj[node].length
    if (deg < 3) {
      const o = deg === 1 ? this.g.adj[node][0] : this.g.adj[node].find((x) => x.e !== p.e) ?? this.g.adj[node][0]
      p.e = o.e; p.dir = o.dir; p.s = 0
      if (!this.request) this.askNext()
      return
    }
    if (!this.pending) return 'wait'
    const d = this.pending, arriving = { e: p.e, dir: p.dir }
    this.pending = null; this.request = null
    this.applyDecision(node, arriving, d)
    if (p.stoppedUntil !== null) this.requestDecision(node, arriving); else this.askNext()
  }

  askNext() {
    let node = this.ahead(this.player), cur = { e: this.player.e, dir: this.player.dir }
    for (let i = 0; i < 80 && this.g.adj[node].length === 2; i++) {
      const o = this.g.adj[node].find((x) => x.e !== cur.e) ?? this.g.adj[node][0]
      cur = { e: o.e, dir: o.dir }; node = o.to
    }
    if (this.g.adj[node].length >= 3) this.requestDecision(node, cur)
  }

  stepCops() {
    const P = this.pos(this.player)
    const playerNode = this.ahead(this.player)
    const interceptTargets = this.stars >= 4 ? this.predictAhead(3).slice(1) : []
    this.cops.forEach((c, i) => {
      if (c.parkedUntil > this.t) return
      if (this.t >= c.replanAt || !c.path.length) {
        c.replanAt = this.t + 1
        let target
        if (this.seen) {
          c.interceptor = this.stars >= 4 && i % 3 === 1
          target = c.interceptor && interceptTargets.length ? interceptTargets[i % interceptTargets.length] : playerNode
          c.searchTarget = null
        } else {
          const lsx = this.g.nodes[this.lastSeen.node]
          const [cx, cy] = this.pos(c)
          const radius = 100 + SEARCH_GROWTH * (this.t - (this.lostAt ?? this.t))
          if (Math.hypot(cx - lsx[0], cy - lsx[1]) > 40 && !c.searchTarget) target = this.lastSeen.node
          else {
            if (!c.searchTarget || this.ahead(c) === c.searchTarget) {
              for (let k = 0; k < 30; k++) {
                const n = Math.floor(this.rand() * this.g.nodes.length), nn = this.g.nodes[n]
                if (Math.hypot(nn[0] - lsx[0], nn[1] - lsx[1]) <= radius) { c.searchTarget = n; break }
              }
            }
            target = c.searchTarget ?? this.lastSeen.node
          }
        }
        if (target !== c.target || !c.path.length) { c.target = target; c.path = this.route(this.ahead(c), target) ?? [] }
      }
      c.v = approach(c.v, this.speedOn(c.e, c.dir, true))
      c.s += c.v * TICK
      while (c.s >= this.g.edges[c.e].len) {
        const over = c.s - this.g.edges[c.e].len, node = this.ahead(c)
        if (c.path[0] === node) c.path.shift()
        const nextNode = c.path[0]
        let o = nextNode !== undefined ? this.g.adj[node].find((x) => x.to === nextNode) : null
        if (!o) { const opts = this.g.adj[node].filter((x) => x.e !== c.e); o = opts.length ? opts[Math.floor(this.rand() * opts.length)] : this.g.adj[node][0]; c.path = [] }
        c.e = o.e; c.dir = o.dir; c.s = over
      }
    })
    if (this.heli) {
      const dx = P[0] - this.heli[0], dy = P[1] - this.heli[1], d = Math.hypot(dx, dy), step = 28 * TICK
      if (d > step) { this.heli[0] += (dx / d) * step; this.heli[1] += (dy / d) * step }
    }
  }

  stepRules() {
    const P = this.pos(this.player), wasSeen = this.seen
    let seen = this.cops.some((c) => this.copSees(c, P))
    if (this.heli && !this.g.edges[this.player.e].tunnel && Math.hypot(this.heli[0] - P[0], this.heli[1] - P[1]) <= 150) seen = true
    this.seen = seen
    if (seen) { this.lastSeen = { node: this.ahead(this.player), t: this.t }; this.lostAt = null; this.nextTipAt = Math.max(this.nextTipAt, this.t + TIP_EVERY[this.stars - 1]) }
    else if (wasSeen) this.lostAt = this.t
    if (!seen && this.t >= this.nextTipAt && !this.g.edges[this.player.e].tunnel) {
      const node = this.ahead(this.player)
      this.lastSeen = { node, t: this.t }; this.lostAt = this.t
      this.cops.forEach((c) => { c.searchTarget = null; c.replanAt = 0 })
      this.lastTip = { node, t: this.t }
      this.events.push({ t: this.t, kind: 'tip', node })
      const quiet = this.player.stoppedUntil !== null ? 2 : this.player.mode === 'cruise' ? 1.5 : FLOOR_TIPS
      this.nextTipAt = this.t + TIP_EVERY[this.stars - 1] * quiet
    }
    const stopped = this.player.stoppedUntil !== null
    this.heat += TICK * (seen ? 3 : stopped ? 0.5 : this.player.mode === 'floor_it' ? FLOOR_HEAT : 1)
    const stars = STAR_HEAT.filter((h) => this.heat >= h).length
    if (stars > this.stars) { this.stars = stars; this.events.push({ t: this.t, kind: 'stars', stars }); if (stars === 5) { this.t5 = this.t; this.heli = [P[0] + 300, P[1] - 300] } }
    const want = UNITS[this.stars - 1] + (this.t5 === null ? 0 : Math.floor((this.t - this.t5) / 10))
    while (this.cops.length < want && this.spawnCop(500, 900));
    if (this.stars >= 3 && this.t >= this.nextRoadblockAt) {
      this.nextRoadblockAt = this.t + 12
      this.roadblocks = this.roadblocks.filter((r) => this.t - r.t < 60)
      if (this.roadblocks.length < 2) {
        const ahead = this.predictAhead(16), decisions = ahead.flatMap((n, i) => (this.g.adj[n].length >= 3 ? [i] : []))
        const cand = ahead.slice((decisions[1] ?? ahead.length) + 1).filter((n) => { const nn = this.g.nodes[n], d = Math.hypot(nn[0] - P[0], nn[1] - P[1]); return this.g.adj[n].length >= 3 && d > 250 && d < 600 && this.g.adj[n].some((o) => ['main', 'freeway'].includes(this.g.edges[o.e].cls)) })
        if (cand.length) {
          const n = cand[0], k = ahead.indexOf(n), o = this.g.adj[n].find((x) => x.to === ahead[k + 1])
          if (o) {
            const chain = [o]
            for (let cur = o, i = 0; i < 80 && this.g.adj[cur.to].length === 2; i++) { const x = this.g.adj[cur.to].find((y) => y.e !== cur.e); if (!x) break; chain.push(x); cur = x }
            let s = 30, c = chain[0]
            for (const x of chain) { c = x; if (s <= this.g.edges[x.e].len) break; s -= this.g.edges[x.e].len }
            this.cops.push({ e: c.e, dir: c.dir, s: Math.min(s, this.g.edges[c.e].len), path: [], target: null, replanAt: 0, interceptor: false, searchTarget: null, parkedUntil: this.t + 60, v: 0 })
            this.roadblocks.push({ node: n, edges: chain.map((x) => x.e), t: this.t }); this.events.push({ t: this.t, kind: 'roadblock', node: n, e: o.e })
          }
        }
      }
    }
    for (const c of this.cops) {
      const [cx, cy] = this.pos(c), d = Math.hypot(cx - P[0], cy - P[1])
      if (c.parkedUntil > this.t) continue
      if (d <= 10 || (stopped && d <= 20)) return this.busted('caught by a patrol car')
    }
    if (this.t >= LOCKDOWN) this.busted('citywide lockdown')
  }

  record() {
    const [x, y, h] = this.pos(this.player)
    const r1 = (v) => Math.round(v * 10) / 10
    this.frames.push([r1(this.t), r1(x), r1(y), Math.round(h * 100) / 100, this.stars, this.seen ? 1 : 0, this.cops.map((c) => this.pos(c).slice(0, 2).map(r1)), this.heli ? this.heli.map(r1) : null])
  }

  start() {
    this.requestDecision(this.startNode, { e: this.player.e, dir: this.player.dir })
  }

  async run() {
    if (!this.request) this.start()
    while (!this.done) {
      let r
      for (let k = 0; k < 200 && !this.done; k++) {
        r = this.stepPlayer()
        if (r === 'wait' || this.done) break
        this.stepCops()
        this.stepRules()
        this.t = Math.round((this.t + TICK) * 1000) / 1000
        if (++this.ticks % FRAME_EVERY === 0) this.record()
      }
      if (r === 'wait' && !this.done) await this.waitForAnswer()
      else await new Promise((res) => setImmediate(res))
    }
    this.record()
    return this.done
  }

  waitForAnswer() {
    if (this.pending) return Promise.resolve()
    return new Promise((res) => { this._wake = res })
  }

  submit(id, decision) {
    const ok = this.answer(id, decision)
    if (ok && this._wake) { const w = this._wake; this._wake = null; w() }
    return ok
  }
}
