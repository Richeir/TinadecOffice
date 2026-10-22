/**
 * Which storage scope can resolve the mode version a session is bound to?
 *
 * Reads two Tinadec stores read-only: the user scope (`~/.tinadec/data/tinadec.db`) and the
 * RouterAPI project scope (`<project>/.tinadec/data/tinadec.db`). For every session in the
 * project scope it prints whether the bound mode version exists there — the check Core's roster
 * freeze performs before it admits a run, and the reason a send comes back as mode_unavailable.
 *
 * Usage: node probe.mjs [userDb] [projectDb]
 */
import { DatabaseSync } from 'node:sqlite'

const userDb = process.argv[2] ?? 'C:/Users/lincu/.tinadec/data/tinadec.db'
const projectDb = process.argv[3] ?? 'C:/git/agent/RouterAPI/.tinadec/data/tinadec.db'

const open = (file) => {
  const db = new DatabaseSync(file, { readOnly: true })
  return (sql, params = []) => db.prepare(sql).all(...params)
}

const user = open(userDb)
const project = open(projectDb)

const sessions = project(`
  select s.id, s.title, s.mode_version_id, s.updated_at
  from sessions s where s.mode_version_id is not null
  order by s.updated_at desc limit 12
`)

console.log(`user scope:    ${userDb}`)
console.log(`project scope: ${projectDb}\n`)
console.log('session, bound version, resolves in project scope, resolves in user scope')
for (const session of sessions) {
  const local = project('select v.id, v.status, m.slug from mode_versions v left join agent_modes m on m.id = v.agent_mode_id where v.id = ?', [session.mode_version_id])
  const global = user('select v.id, v.status, m.slug from mode_versions v left join agent_modes m on m.id = v.agent_mode_id where v.id = ?', [session.mode_version_id])
  console.log([
    `${session.id} ${session.updated_at}`,
    session.mode_version_id,
    local.length ? `${local[0].status}/${local[0].slug}` : 'MISSING',
    global.length ? `${global[0].status}/${global[0].slug}` : 'missing',
  ].join(' | '))
}

const counts = (q) => q("select count(*) as n from mode_versions where status = 'published'")[0].n
console.log(`\npublished versions: project ${counts(project)}, user ${counts(user)}`)
