import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const PREFIX = process.env.PROFILE_PREFIX || 'gtai'
const MODEL = /model:\s*\n\s+provider_config:\s*(\S+)\s*\n\s+name:\s*(\S+)/
const omnara = (...args) => JSON.parse(execFileSync('npx', ['-y', 'omnara', ...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
const list = (r) => r.data ?? r

const granted = new Set(list(omnara('grant', 'models', 'list')).map((g) => `${g.model.provider_config}/${g.model.name}`))
const lines = []
for (const file of readdirSync('agents').filter((f) => /^driver-.+\.yaml$/.test(f)).sort()) {
  const key = file.slice('driver-'.length, -'.yaml'.length), [, provider, model] = readFileSync(`agents/${file}`, 'utf8').match(MODEL)
  if (!granted.has(`${provider}/${model}`)) { console.log(`skipped ${key}: ${provider}/${model} isn't granted to this project`); continue }
  const name = `${PREFIX}-driver-${key}`, existing = list(omnara('profiles', 'list', '--name', name))[0]
  const profile = existing ? omnara('profiles', 'update', existing.id, '--file', `agents/${file}`) : omnara('profiles', 'create', '--name', name, '--file', `agents/${file}`)
  lines.push(`${key} ${existing?.id ?? profile.id}`)
  console.log(`${existing ? 'updated' : 'created'} ${name} (${model})`)
}
if (!lines.length) throw new Error('No driver models are granted to this project. See README.md.')
writeFileSync('agents/profiles.txt', lines.join('\n') + '\n')
console.log(`wrote agents/profiles.txt with ${lines.length} drivers`)
