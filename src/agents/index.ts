/**
 * The runner registry: which coding-agent CLIs a configuration may name, and how a name becomes a runner.
 *
 * Adding an agent means one file that implements `AgentRunner` and one line in `RUNNERS`. Nothing else in the project knows
 * which agent ran a ticket, which is what keeps the rest of the system portable.
 */
import { ClaudeRunner } from './claude.ts'
import { CodexRunner } from './codex.ts'
import { OpencodeRunner } from './opencode.ts'
import type { AgentRunner } from './types.ts'

export type AgentName = 'claude' | 'codex' | 'opencode'

const FACTORIES: Record<AgentName, () => AgentRunner> = {
  claude: () => new ClaudeRunner(),
  codex: () => new CodexRunner(),
  opencode: () => new OpencodeRunner(),
}

export const AGENT_NAMES = Object.keys(FACTORIES) as AgentName[]

/** Builds the runner a configuration names. */
export function runnerFor(name: AgentName, binary?: string): AgentRunner {
  if (binary) {
    const Runner = { claude: ClaudeRunner, codex: CodexRunner, opencode: OpencodeRunner }[name]
    return new Runner(binary)
  }
  return FACTORIES[name]()
}

/** Which registered agents are installed, for `superagent doctor`. */
export async function installed(): Promise<Record<AgentName, boolean>> {
  const entries = await Promise.all(AGENT_NAMES.map(async name => [name, await runnerFor(name).available()] as const))
  return Object.fromEntries(entries) as Record<AgentName, boolean>
}

export type { AgentReport, AgentResult, AgentRun, AgentRunner } from './types.ts'
export { REPORT_FILE, readReport, reportInstructions } from './types.ts'
