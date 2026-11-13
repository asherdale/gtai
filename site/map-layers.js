export const AREA = { park: 'rgba(76,178,132,0.22)', wood: 'rgba(56,150,110,0.32)', sand: 'rgba(235,205,150,0.16)', water: '#12143a' }
export const AREA_SMALL = { park: 'rgba(76,178,132,0.28)', wood: 'rgba(56,150,110,0.38)', sand: 'rgba(235,205,150,0.18)', water: '#12143a' }

export function paintSea(mask, ctx, fadeCells, edge) {
  const img = ctx.createImageData(mask.w, mask.h)
  mask.rows.forEach((runs, j) => {
    let i = 0
    runs.forEach((n, k) => {
      if (k % 2 === 0) for (let q = i; q < i + n; q++) img.data.set([18, 20, 52, 255 * Math.min(1, Math.min(q, j, mask.w - 1 - q, mask.h - 1 - j) / fadeCells)], (j * mask.w + q) * 4)
      i += n
    })
  })
  ctx.putImageData(img, 0, 0)
  ctx.setTransform(1 / mask.cell, 0, 0, 1 / mask.cell, -mask.x0 / mask.cell, -mask.y0 / mask.cell)
  fadeEdges(ctx, [edge[0], -1e7, 1e7, edge[3]], [mask.x0, mask.y0, mask.x0 + mask.w * mask.cell, mask.y0 + mask.h * mask.cell])
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

export function areaTiles(F, Path2D) {
  const tiles = new Map()
  for (const kind in AREA) for (const r of F[kind]) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]) }
    const k = `${Math.floor((x0 + x1) / 2000)},${Math.floor((y0 + y1) / 2000)}`
    let tl = tiles.get(k); if (!tl) tiles.set(k, (tl = { x0, y0, x1, y1, paths: {} }))
    tl.x0 = Math.min(tl.x0, x0); tl.y0 = Math.min(tl.y0, y0); tl.x1 = Math.max(tl.x1, x1); tl.y1 = Math.max(tl.y1, y1)
    const p = (tl.paths[kind] ??= new Path2D())
    for (let i = 0; i < r.length; i += 2) i ? p.lineTo(r[i], r[i + 1]) : p.moveTo(r[i], r[i + 1])
    p.closePath()
  }
  return [...tiles.values()]
}

export function drawAreas(ctx, tiles, colors, view) {
  for (const tl of tiles) if (tl.x1 >= view[0] && tl.x0 <= view[2] && tl.y1 >= view[1] && tl.y0 <= view[3]) for (const kind in tl.paths) { ctx.fillStyle = colors[kind]; ctx.fill(tl.paths[kind]) }
}

export function coastPath(F, Path2D) {
  const p = new Path2D()
  for (const l of F.coast) for (let i = 0; i < l.length; i += 2) i ? p.lineTo(l[i], l[i + 1]) : p.moveTo(l[i], l[i + 1])
  return p
}

export const mapEdge = ([x0, y0, x1, y1]) => [x0, y0 - 400, x1 + 600, y1]

export function strokeCoast(ctx, path, px, glow, [x0, y0, x1, y1]) {
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.clip()
  if (glow) { ctx.lineWidth = 6 * px; ctx.strokeStyle = 'rgba(140,120,230,0.16)'; ctx.stroke(path) }
  ctx.lineWidth = 1.5 * px; ctx.strokeStyle = 'rgba(190,175,255,0.5)'; ctx.stroke(path)
  ctx.restore()
}

export function fadeEdges(ctx, [x0, y0, x1, y1], view, width = 300) {
  ctx.save(); ctx.globalCompositeOperation = 'destination-in'
  for (const [a, b, gradient] of [[x0, x1, (a, b) => ctx.createLinearGradient(a, 0, b, 0)], [y0, y1, (a, b) => ctx.createLinearGradient(0, a, 0, b)]]) {
    const g = gradient(a, b), f = Math.min(0.45, width / (b - a))
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(f, '#000'); g.addColorStop(1 - f, '#000'); g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g; ctx.fillRect(view[0], view[1], view[2] - view[0], view[3] - view[1])
  }
  ctx.restore()
}
