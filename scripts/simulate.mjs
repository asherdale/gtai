import { loadGraph, Chase } from '../sim.mjs'
const g = loadGraph()
const STARTS = ['Lombard Street', 'Painted Ladies', "Fisherman's Wharf", 'Union Square', 'Ferry Building', 'Chinatown', 'Salesforce Tower', 'Oracle Park', 'Palace of Fine Arts', 'Haight-Ashbury', 'Castro', 'Dolores Park', 'Twin Peaks']
const policies = {
  straight: (c, req) => ({ exit: c.straightestExit(req.node, req.arriving) ? req.options.find((o) => o.e === c.straightestExit(req.node, req.arriving).e)?.label : 'A', speed: 'floor_it' }),
  random: (c, req) => ({ exit: req.options[Math.floor(Math.random() * req.options.length)].label, speed: 'floor_it' }),
  stealth: (c, req) => {
    const copPos = c.cops.map((k) => c.pos(k))
    const score = (o) => { const n = g.nodes[o.to]; return Math.min(...copPos.map(([x, y]) => Math.hypot(n[0] - x, n[1] - y))) - (o.back ? 200 : 0) - (c.roadblocks.some((r) => r.node === o.to) ? 1e6 : 0) }
    const best = req.options.reduce((b, o) => (score(o) > score(b) ? o : b))
    return { exit: best.label, speed: 'cruise' }
  },
  parker: (c, req) => {
    const copPos = c.cops.map((k) => c.pos(k)), alley = req.options.find((o) => o.cls === 'alley')
    if (!c.seen && Math.min(...copPos.map(([x, y]) => Math.hypot(g.nodes[req.node][0] - x, g.nodes[req.node][1] - y))) > 300) return { exit: 'A', speed: 'pull_over' }
    const score = (o) => { const n = g.nodes[o.to]; return Math.min(...copPos.map(([x, y]) => Math.hypot(n[0] - x, n[1] - y))) + (o.cls === 'alley' ? 100 : 0) - (o.back ? 200 : 0) - (c.roadblocks.some((r) => r.node === o.to) ? 1e6 : 0) }
    return { exit: req.options.reduce((b, o) => (score(o) > score(b) ? o : b)).label, speed: 'floor_it' }
  },
  evade: (c, req) => {
    const copPos = c.cops.map((k) => c.pos(k))
    const score = (o) => { const n = g.nodes[o.to]; return Math.min(...copPos.map(([x, y]) => Math.hypot(n[0] - x, n[1] - y))) + (o.cls === 'alley' && c.seen ? 80 : 0) + (o.cls === 'freeway' ? 60 : 0) - (o.back ? 200 : 0) - (c.roadblocks.some((r) => r.node === o.to) ? 1e6 : 0) }
    const best = req.options.reduce((b, o) => (score(o) > score(b) ? o : b))
    return { exit: best.label, speed: c.seen ? 'floor_it' : 'cruise', special: 'jump' }
  },
}
for (const [name, pol] of Object.entries(policies)) {
  const times = [], reasons = {}, stars = []
  for (let seed = 1; seed <= 30; seed++) {
    const c = new Chase(g, { seed, start: STARTS[seed % STARTS.length] })
    c.onRequest = (req) => setImmediate(() => c.submit(req.id, pol(c, req)))
    const r = await c.run()
    times.push(r.time); stars.push(r.stars); reasons[r.reason] = (reasons[r.reason] ?? 0) + 1
  }
  times.sort((a, b) => a - b)
  const q = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))]
  console.log(`${name.padEnd(8)} median ${q(0.5)}s  p10 ${q(0.1)}s  p90 ${q(0.9)}s  max ${times.at(-1)}s  avg stars ${(stars.reduce((a, b) => a + b) / stars.length).toFixed(1)}`, reasons)
}
