/**
 * Proves a real coding agent satisfies the runner contract: it runs in the ticket's directory and leaves a readable report.
 * Skipped unless SUPERAGENT_LIVE=1, because it starts a real agent and costs tokens.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runnerFor, type AgentName } from '../src/agents/index.ts'

const live = process.env.SUPERAGENT_LIVE === '1'
const agent = (process.env.SUPERAGENT_AGENT ?? 'codex') as AgentName
const dirs: string[] = []

afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

describe.skipIf(!live)('a live agent', () => {
  it(`${agent} writes the report the runner reads`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'superagent-live-'))
    dirs.push(cwd)
    await mkdir(join(cwd, '.superagent'), { recursive: true })
    await writeFile(join(cwd, 'README.md'), '# Fixture\n')

    const runner = runnerFor(agent)
    const result = await runner.run({
      prompt: [
        'Read README.md, then write .superagent/report.json with the JSON object',
        '{"summary": "<the first heading in README.md>", "state": "ready"}.',
        'Do not change any other file.',
      ].join('\n'),
      cwd,
      env: { ...process.env as Record<string, string> },
      signal: AbortSignal.timeout(240_000),
      timeoutMs: 240_000,
    })

    expect(result.ok, result.raw.slice(-800)).toBe(true)
    expect(result.report?.summary?.trim()).toBe('Fixture')
    expect(JSON.parse(await readFile(join(cwd, '.superagent', 'report.json'), 'utf8')).state).toBe('ready')
  }, 300_000)
})
