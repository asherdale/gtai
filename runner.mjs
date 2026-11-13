import { Chase } from './sim.mjs'
import { api, sse, PROFILES } from './omnara.mjs'

const ANSWER_TIMEOUT = 8000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`

export async function moderate(text) {
  if (!text || !process.env.OPENAI_API_KEY) return true
  try {
    const res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: text }),
    })
    if (!res.ok) return false
    return !(await res.json()).results.some((r) => r.flagged)
  } catch {
    return false
  }
}

async function settleOpenCalls(agentId, text) {
  const list = await api('GET', `/agents/${agentId}/tool-calls?state=ready&type=custom`).catch(() => ({ data: [] }))
  for (const c of list.data ?? []) await api('POST', `/agents/${agentId}/tool-calls/${c.id}/result`, { outcome: 'succeeded', content_blocks: [{ type: 'text', text }] }).catch(() => {})
  return (list.data ?? []).length
}

async function latestSequence(agentId) {
  const page = await api('GET', `/agents/${agentId}/events?before_sequence=0&limit=1`)
  return page.data?.[0]?.sequence ?? 0
}

export async function runAttempt(graph, { agentId = null, model, strategy, start, seed, name, previous = null, onUpdate }) {
  const chase = new Chase(graph, { seed, start })
  chase.start()
  const opening = previous
    ? `Run it back! Your last chase ended at ${fmt(previous.time)} (${previous.reason}). New chase from ${start}, same strategy from the player: "${strategy}"\n\n${chase.request.text}\n\nCall drive with your first decision.`
    : `Your getaway strategy, from the player: "${strategy}"\n\nThe chase starts now at ${start}.\n\n${chase.request.text}\n\nCall drive with your first decision.`
  let after = 0
  if (agentId) {
    try {
      for (let i = 0; i < 3 && (await settleOpenCalls(agentId, 'That chase is over. Do not call drive until a new chase starts.')); i++) await sleep(2500)
      after = await latestSequence(agentId)
      await api('POST', `/agents/${agentId}/inputs`, { content_blocks: [{ type: 'text', text: opening }] })
    } catch {
      agentId = null; after = 0
    }
  }
  if (!agentId) {
    const created = await api('POST', '/agents', { profile: PROFILES[model], name: `chase ${name || ''}`.trim(), message: opening })
    agentId = created.agent?.id ?? created.id
  }

  let stalls = 0, errors = 0, fail
  const failed = new Promise((_, reject) => { fail = reject })
  failed.catch(() => {})
  const handled = new Set(), inputs = new Map()
  let openCall = null, timer = null
  const postResult = async (callId, text) => {
    try { await api('POST', `/agents/${agentId}/tool-calls/${callId}/result`, { outcome: 'succeeded', content_blocks: [{ type: 'text', text }] }) }
    catch (e) { console.error('tool result failed', agentId, String(e).slice(0, 200)) }
  }
  const armTimeout = (req) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (chase.done || !chase.request || chase.request.id !== req.id || chase.pending) return
      const o = chase.straightestExit(req.node, req.arriving)
      chase.submit(req.id, { exit: req.options.find((x) => x.e === o.e)?.label ?? 'A', speed: chase.player.mode === 'pull_over' ? 'floor_it' : chase.player.mode, say: '', timeout: true })
      const ev = chase.events.at(-1); if (ev?.kind === 'decision') ev.moderated = true
    }, ANSWER_TIMEOUT)
  }
  chase.onRequest = (req) => { armTimeout(req); if (openCall) { const c = openCall; openCall = null; postResult(c, req.text) } }
  armTimeout(chase.request)

  let sentFrames = 0, sentEvents = 0
  const flush = (final) => {
    const frames = chase.frames.slice(sentFrames)
    const evs = []
    while (sentEvents < chase.events.length) {
      const e = chase.events[sentEvents]
      if (e.kind === 'decision' && !e.moderated && !final) break
      evs.push(e.kind === 'decision' ? { t: e.t, kind: 'decision', node: e.node, exit: e.exit, speed: e.speed, special: e.special, say: e.say } : e)
      sentEvents++
    }
    sentFrames = chase.frames.length
    if (frames.length || evs.length || final) onUpdate?.({ frames, events: evs, result: final ? chase.done : null })
  }
  const ticker = setInterval(() => flush(false), 150)

  const runP = chase.run().then(async (done) => {
    clearTimeout(timer)
    const text = `BUSTED at ${fmt(done.time)} (${done.reason}). The chase is over. Do not call drive again; reply with one final line.`
    if (openCall) { const c = openCall; openCall = null; await postResult(c, text) }
    return done
  })

  const ctrl = new AbortController()
  const pump = (async () => {
    while (!ctrl.signal.aborted) {
      try {
        for await (const { event, data } of sse(`/agents/${agentId}/events/stream?after_sequence=${after}`, ctrl.signal)) {
          if (data.sequence) after = Math.max(after, data.sequence)
          if (event === 'model_output') for (const c of (data.content_blocks ?? []).filter((b) => b.type === 'tool_call')) if (c.tool_call_id) inputs.set(c.tool_call_id, c.input ?? {})
          if (event === 'tool_call_update' && data.state === 'ready') {
            const known = inputs.get(data.tool_call_id)
            const list = known ? { data: [{ id: data.tool_call_id, input: known }] } : await api('GET', `/agents/${agentId}/tool-calls?state=ready&type=custom`)
            for (const call of list.data ?? []) {
              if (handled.has(call.id)) continue
              handled.add(call.id)
              if (chase.done) { await postResult(call.id, 'The chase is already over. Do not call drive again.'); continue }
              const input = call.input ?? {}, req = chase.request
              if (req && !chase.pending) {
                openCall = call.id
                const say = String(input.say ?? '').slice(0, 80)
                chase.submit(req.id, { exit: String(input.exit ?? 'A'), speed: input.speed, special: input.special, say })
                const ev = chase.events.findLast((e) => e.kind === 'decision' && e.id === req.id)
                if (ev) moderate(say).then((ok) => { if (!ok) ev.say = '…'; ev.moderated = true })
              } else await postResult(call.id, req ? req.text : 'Wait for the next situation.')
            }
          } else if (event === 'model_output' && !chase.done) {
            const calls = (data.content_blocks ?? []).filter((b) => b.type === 'tool_call')
            const nudge = () => api('POST', `/agents/${agentId}/inputs`, { content_blocks: [{ type: 'text', text: `The chase is still on. Call drive for this intersection.\n\n${chase.request.text}` }] })
            if (calls.length) { stalls = 0; errors = 0 }
            else if (data.stop_reason === 'error') {
              if (++errors > 1) return fail(new Error(`model error: ${(data.content_blocks ?? []).find((b) => b.type === 'error')?.text ?? 'unknown'}`))
              if (chase.request && !chase.pending) await nudge()
            } else if (data.stop_reason === 'end_turn' && chase.request && !chase.pending && stalls < 3) {
              stalls++
              await nudge()
            }
          }
        }
      } catch {
        if (ctrl.signal.aborted) break
        await sleep(500)
      }
    }
  })()

  let result
  try {
    result = await Promise.race([runP, failed])
  } catch (e) {
    clearTimeout(timer); clearInterval(ticker); ctrl.abort(); chase.done ??= { time: chase.t, reason: 'error' }; chase._wake?.()
    throw e
  }
  for (let i = 0; i < 20 && chase.events.some((e) => e.kind === 'decision' && !e.moderated); i++) await sleep(150)
  clearInterval(ticker)
  flush(true)
  await sleep(1500)
  await settleOpenCalls(agentId, `BUSTED at ${fmt(result.time)} (${result.reason}). The chase is over. Do not call drive again.`)
  ctrl.abort()
  await pump.catch(() => {})
  return {
    agentId,
    record: {
      result,
      frames: chase.frames,
      events: chase.events.map((e) => (e.kind === 'decision' ? { t: e.t, kind: 'decision', node: e.node, exit: e.exit, speed: e.speed, special: e.special, say: e.say, latency: e.latency } : e)),
    },
  }
}

