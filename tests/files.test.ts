import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Thread, Ticket } from '../src/core/index.ts'
import { FileRepositories } from '../src/state/files.ts'

const dirs: string[] = []
const repos: FileRepositories[] = []
async function fresh(): Promise<FileRepositories> {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-'))
  dirs.push(dir)
  const repo = new FileRepositories(dir)
  await repo.open()
  repos.push(repo)
  return repo
}
// A commit runs on a queue after `atomic` returns, so drain it before the directory goes away.
afterEach(async () => {
  await Promise.all(repos.splice(0).map(repo => repo.flush()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const ticket = (id: string, extra: Partial<Ticket> = {}): Ticket => ({
  id, title: `Ticket ${id}`, decisionId: 'd1',
  mandate: { strength: 'explicit', basis: 'explicit', policyVersion: 'v1', at: '2026-01-01T00:00:00.000Z', triggerId: 't1' } as unknown as Ticket['mandate'],
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  origin: { triggerId: 't1', triggerIds: ['t1'] },
  ...extra,
})

const thread = (key: string, extra: Partial<Thread> = {}): Thread => ({
  key, ref: { source: 'github', id: key.split(':')[1] ?? key }, createdAt: '2026-01-01T00:00:00.000Z',
  subscriptions: [], correlated: [], pending: [], meta: {}, ...extra,
})

describe('FileRepositories', () => {
  it('keeps a ticket readable on disk after a commit', async () => {
    const repo = await fresh()
    repo.atomic(() => repo.tickets.save(ticket('t-1')))
    await repo.flush()
    const stored = JSON.parse(await readFile(join(repo.stateDir, 'tickets', 't-1', 'ticket.json'), 'utf8'))
    expect(stored.title).toBe('Ticket t-1')
  })

  it('shows a write inside the same transaction but drops it when the transaction fails', async () => {
    const repo = await fresh()
    expect(() => repo.atomic(() => {
      repo.tickets.save(ticket('t-2'))
      expect(repo.tickets.get('t-2')).toBeDefined()
      throw new Error('boom')
    })).toThrow('boom')
    expect(repo.tickets.get('t-2')).toBeUndefined()
  })

  it('separates open from ended tickets and active from idle ones', async () => {
    const repo = await fresh()
    repo.atomic(() => {
      repo.tickets.save(ticket('open-active', { undelivered: ['x'] }))
      repo.tickets.save(ticket('open-idle'))
      repo.tickets.save(ticket('ended', { ended: { at: '2026-01-02T00:00:00.000Z', by: 'human', outcome: 'completed' } }))
    })
    expect(repo.tickets.open().map(t => t.id).sort()).toEqual(['open-active', 'open-idle'])
    expect(repo.tickets.active().map(t => t.id)).toEqual(['open-active'])
  })

  it('reloads state another process wrote', async () => {
    const first = await fresh()
    const second = new FileRepositories(first.stateDir)
    await second.open()
    first.atomic(() => first.tickets.save(ticket('shared')))
    await first.flush()
    expect(second.tickets.get('shared')).toBeUndefined()
    await second.reload()
    expect(second.tickets.get('shared')?.title).toBe('Ticket shared')
  })

  it('finds only the threads waiting for work', async () => {
    const repo = await fresh()
    repo.atomic(() => {
      repo.threads.save(thread('github:1', { pending: ['t1'] }))
      repo.threads.save(thread('github:2'))
    })
    expect(repo.threads.active().map(t => t.key)).toEqual(['github:1'])
  })
})
