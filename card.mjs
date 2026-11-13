import { createCanvas, GlobalFonts, Path2D } from '@napi-rs/canvas'
import { AREA_SMALL, paintSea, areaTiles, drawAreas, coastPath, strokeCoast, fadeEdges, mapEdge } from './site/map-layers.js'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const FONTS = fileURLToPath(new URL('./site/fonts/', import.meta.url))
GlobalFonts.registerFromPath(FONTS + 'bungee.woff2', 'Bungee')
GlobalFonts.registerFromPath(FONTS + 'rubik.woff2', 'Rubik')

const W = 1200, H = 630, MAP_X = 540
const ROADS = { alley: ['#4f4174', 1], residential: ['#6a5996', 1.6], main: ['#b3a3e3', 3], freeway: ['#d9cdfa', 4.5] }
const F = JSON.parse(readFileSync(new URL('./data/features.json', import.meta.url), 'utf8')), M = F.mask
const areas = areaTiles(F, Path2D), coast = coastPath(F, Path2D)
let sea = null
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

function star(ctx, cx, cy, r) {
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, rr = i % 2 ? r * 0.45 : r
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
  }
  ctx.closePath()
}

function outlined(ctx, text, x, y, fill, stroke, shadow) {
  ctx.lineJoin = 'round'
  ctx.fillStyle = '#1b1426'; ctx.fillText(text, x, y + shadow)
  ctx.strokeStyle = '#1b1426'; ctx.lineWidth = stroke; ctx.strokeText(text, x, y)
  ctx.fillStyle = fill; ctx.fillText(text, x, y)
}

function drawMap(ctx, graph, cx, cy, scale) {
  const P = (x, y) => [MAP_X + (W - MAP_X) / 2 + (x - cx) * scale, H / 2 + (y - cy) * scale]
  const halfW = (W - MAP_X) / 2 / scale + 200, halfH = H / 2 / scale + 200, world = [scale, 0, 0, scale, MAP_X + (W - MAP_X) / 2 - cx * scale, H / 2 - cy * scale]
  const view = [cx - halfW, cy - halfH, cx + halfW, cy + halfH], layer = createCanvas(W, H), main = ctx
  if (!sea) { sea = createCanvas(M.w, M.h); paintSea(M, sea.getContext('2d'), 40, mapEdge(graph.bounds)) }
  main.save(); main.setTransform(...world); main.drawImage(sea, M.x0, M.y0, M.w * M.cell, M.h * M.cell); main.restore()
  ctx = layer.getContext('2d')
  ctx.save(); ctx.setTransform(...world)
  drawAreas(ctx, areas, AREA_SMALL, view)
  strokeCoast(ctx, coast, 1 / scale, false, mapEdge(graph.bounds))
  ctx.restore()
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  for (const cls of ['alley', 'residential', 'main', 'freeway']) {
    const [color, width] = ROADS[cls]; ctx.strokeStyle = color; ctx.lineWidth = width
    ctx.shadowColor = '#b59bff'; ctx.shadowBlur = cls === 'main' || cls === 'freeway' ? 10 : 0
    ctx.beginPath()
    for (const e of graph.edges) {
      if (e.cls !== cls) continue
      const [ax, ay] = e.pts[0]
      if (Math.abs(ax - cx) > halfW || Math.abs(ay - cy) > halfH) continue
      e.pts.forEach(([x, y], k) => { const [a, b] = P(x, y); k ? ctx.lineTo(a, b) : ctx.moveTo(a, b) })
    }
    ctx.stroke()
  }
  ctx.shadowBlur = 0
  ctx.setTransform(...world); fadeEdges(ctx, mapEdge(graph.bounds), view)
  main.drawImage(layer, 0, 0)
  return P
}

function backdrop(ctx) {
  const bg = ctx.createRadialGradient(MAP_X + 330, H / 2, 40, MAP_X + 330, H / 2, 800)
  bg.addColorStop(0, '#3a2a63'); bg.addColorStop(1, '#170f2b')
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
}

function frameUi(ctx) {
  const fade = ctx.createLinearGradient(MAP_X - 120, 0, MAP_X + 140, 0)
  fade.addColorStop(0, '#170f2b'); fade.addColorStop(1, '#170f2b00')
  ctx.fillStyle = fade; ctx.fillRect(0, 0, MAP_X + 140, H)
  ctx.fillStyle = '#170f2b'; ctx.fillRect(0, 0, MAP_X - 120, H)
  const top = ctx.createLinearGradient(0, 0, 0, 130)
  top.addColorStop(0, '#ff8a5ccc'); top.addColorStop(1, '#ff5fa000')
  ctx.fillStyle = top; ctx.fillRect(0, 0, W, 130)
  ctx.font = '30px Bungee'; outlined(ctx, 'GTAI: VIBE CITY', 56, 72, '#ffd23f', 6, 4)
}

export function renderCard(graph, rec) {
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d')
  backdrop(ctx)
  const route = rec.frames.map((f) => [f[1], f[2]])
  const xs = route.map((p) => p[0]), ys = route.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const span = Math.max(3500, (maxX - minX) * 1.35, (maxY - minY) * 1.35)
  const scale = Math.min(W - MAP_X, H) / span
  const P = drawMap(ctx, graph, (minX + maxX) / 2, (minY + maxY) / 2, scale)

  ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  ctx.strokeStyle = '#ff4fa3'; ctx.lineWidth = 7; ctx.shadowColor = '#ff4fa3'; ctx.shadowBlur = 18
  ctx.beginPath(); route.forEach(([x, y], k) => { const [a, b] = P(x, y); k ? ctx.lineTo(a, b) : ctx.moveTo(a, b) }); ctx.stroke()
  ctx.shadowBlur = 0; ctx.strokeStyle = '#ffe3f1'; ctx.lineWidth = 2
  ctx.beginPath(); route.forEach(([x, y], k) => { const [a, b] = P(x, y); k ? ctx.lineTo(a, b) : ctx.moveTo(a, b) }); ctx.stroke()

  const last = rec.frames.at(-1)
  ;(last[6] ?? []).forEach(([x, y], i) => {
    const [a, b] = P(x, y), rgb = i % 2 ? '42,107,255' : '255,42,77'
    ctx.fillStyle = `rgba(${rgb},0.35)`; ctx.beginPath(); ctx.arc(a, b, 11, 0, 7); ctx.fill()
    ctx.fillStyle = `rgb(${rgb})`; ctx.beginPath(); ctx.arc(a, b, 5, 0, 7); ctx.fill()
  })
  const [sx, sy] = P(...route[0])
  ctx.fillStyle = '#ffd23f'; ctx.strokeStyle = '#1b1426'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(sx, sy, 9, 0, 7); ctx.fill(); ctx.stroke()
  const [bx, by] = P(...route.at(-1))
  ctx.fillStyle = '#ff2a4d'; ctx.shadowColor = '#ff2a4d'; ctx.shadowBlur = 20; ctx.beginPath(); ctx.arc(bx, by, 15, 0, 7); ctx.fill(); ctx.shadowBlur = 0
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(bx - 6, by - 6); ctx.lineTo(bx + 6, by + 6); ctx.moveTo(bx + 6, by - 6); ctx.lineTo(bx - 6, by + 6); ctx.stroke()

  frameUi(ctx)
  const { meta, result } = rec
  ctx.font = '900 26px Rubik'; ctx.fillStyle = '#fff'; ctx.fillText('My AI agent survived', 60, 170)
  ctx.font = '150px Bungee'; outlined(ctx, fmt(result.time), 52, 320, '#ffd23f', 10, 9)
  for (let i = 0; i < 5; i++) {
    star(ctx, 84 + i * 58, 372, 24)
    ctx.fillStyle = i < result.stars ? '#ffd23f' : '#3a2f52'; ctx.fill()
    ctx.strokeStyle = '#1b1426'; ctx.lineWidth = 4; ctx.stroke()
  }
  const who = meta.name && meta.name !== 'anonymous' ? '@' + meta.name : null
  let y = 460
  if (who) { ctx.font = '900 40px Rubik'; ctx.fillStyle = '#fff'; ctx.fillText(who, 60, y); y += 38 }
  ctx.font = '500 24px Rubik'; ctx.fillStyle = '#d9cdfa'; ctx.fillText(meta.slug ?? meta.model, 60, y)
  ctx.font = '700 22px Rubik'; ctx.fillStyle = '#ffc2dc'; ctx.fillText(`Busted: ${result.reason}`, 60, 575)
  return canvas.toBuffer('image/png')
}

export function renderGenericCard(graph) {
  const canvas = createCanvas(W, H), ctx = canvas.getContext('2d')
  backdrop(ctx)
  const xs = graph.nodes.map((n) => n[0]), ys = graph.nodes.map((n) => n[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  drawMap(ctx, graph, (minX + maxX) / 2, (minY + maxY) / 2, (Math.min(W - MAP_X, H) / Math.max(maxX - minX, maxY - minY)) * 1.05)
  frameUi(ctx)
  const lines = [['HOW LONG CAN', '#fff'], ['YOUR AI AGENT', '#fff'], ['SURVIVE A', '#fff'], ['5-STAR', '#ffd23f']]
  ctx.font = '62px Bungee'
  const size = Math.min(62, Math.floor((62 * 450) / Math.max(...lines.map(([l]) => ctx.measureText(l).width))))
  ctx.font = `${size}px Bungee`
  lines.forEach(([line, color], i) => outlined(ctx, line, 56, 196 + i * (size + 12), color, 8, 6))
  ctx.font = '38px Bungee'; outlined(ctx, 'WANTED LEVEL?', 56, 196 + 4 * (size + 12) - 6, '#fff', 7, 5)
  for (let i = 0; i < 5; i++) { star(ctx, 84 + i * 58, 196 + 4 * (size + 12) + 58, 22); ctx.fillStyle = '#ffd23f'; ctx.fill(); ctx.strokeStyle = '#1b1426'; ctx.lineWidth = 4; ctx.stroke() }
  return canvas.toBuffer('image/png')
}
