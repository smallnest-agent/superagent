/**
 * Runs one agent process and collects its streams.
 *
 * Every runner shares this: it starts the CLI with the prompt on stdin, collects stdout and stderr under a size cap, honours
 * the abort signal and the timeout, and returns the exit code. What differs between agents is only their argv and the shape
 * of their events, which each runner turns into `AgentResult`.
 */
import { spawn } from 'node:child_process'

export interface ProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
}

const CAP = 4 << 20

export function runProcess(program: string, argv: string[], options: {
  cwd: string
  env: Record<string, string>
  stdin: string
  signal: AbortSignal
  timeoutMs?: number | undefined
}): Promise<ProcessResult> {
  return new Promise(resolve => {
    const child = spawn(program, argv, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    const append = (current: string, chunk: Buffer): string => current.length >= CAP ? current : current + chunk.toString('utf8').slice(0, CAP - current.length)
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    const finish = (exitCode: number): void => {
      clearTimeout(timer)
      options.signal.removeEventListener('abort', stop)
      resolve({ exitCode, stdout, stderr, timedOut, aborted })
    }
    const stop = (): void => { aborted = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref() }
    const timer = setTimeout(() => { timedOut = true; stop() }, options.timeoutMs ?? 30 * 60_000)
    options.signal.addEventListener('abort', stop, { once: true })
    child.on('error', error => { stderr += `\n${String(error)}`; finish(-1) })
    child.on('close', code => finish(code ?? -1))
    // The prompt goes in whole and the stream closes, which is how every supported agent learns it should stop at the end of a turn.
    child.stdin.end(options.stdin)
  })
}
