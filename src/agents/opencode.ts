/** Runs a task on opencode (`opencode run`), which prints JSON events with `--format json`. */
import { runProcess } from './process.ts'
import { readReport, type AgentResult, type AgentRunner, type AgentRun } from './types.ts'

export class OpencodeRunner implements AgentRunner {
  readonly name = 'opencode'
  constructor(private readonly binary = 'opencode') {}

  async available(): Promise<boolean> {
    const result = await runProcess(this.binary, ['--version'], {
      cwd: process.cwd(), env: { ...process.env as Record<string, string> }, stdin: '', signal: AbortSignal.timeout(10_000),
    })
    return result.exitCode === 0
  }

  async run(run: AgentRun): Promise<AgentResult> {
    const argv = ['run', '--format', 'json', '--dir', run.cwd, ...run.model ? ['--model', run.model] : [], '-']
    const result = await runProcess(this.binary, argv, { cwd: run.cwd, env: run.env, stdin: run.prompt, signal: run.signal, timeoutMs: run.timeoutMs })
    const report = await readReport(run.cwd)
    return {
      ok: result.exitCode === 0 && !result.timedOut,
      finalText: lastText(result.stdout),
      ...report ? { report } : {},
      exitCode: result.exitCode,
      raw: result.stdout,
    }
  }
}

/** Reads the last assistant text part from an opencode JSON event stream. */
function lastText(stdout: string): string {
  let last = ''
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as { type?: string; part?: { type?: string; text?: string } }
      if (event.type === 'text' && typeof event.part?.text === 'string') last = event.part.text
    } catch { /* a partial line is not fatal */ }
  }
  return last
}
