/**
 * The loop that makes an installation run without a person: poll the Sources, assess what they bring, and run the tickets
 * the assessment accepts.
 *
 * It is a plain async loop, not a daemon protocol: `runLoop` returns when its signal aborts, so a cron job, a shell script,
 * or a coding agent can each call it for one round with `--once`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Engine, type AssessmentOutcome, type Candidate, type Executor, type Outbox, type OutboundMessage, type Policy, type Assessor, type SourceScope,
  type Ticket, type Trigger, type Assignment } from './core/index.ts'
import { runnerFor, type AgentName, type AgentReport, type AgentRunner } from './agents/index.ts'
import { writeEnvironment, runEnvironment, type EnvironmentAccounts } from './infra/environment.ts'
import { run } from './infra/commands.ts'
import type { FileRepositories } from './state/files.ts'
import type { Settings } from './settings.ts'
import { composePrompt } from './prompts.ts'
import { agentLogin, pollNotifications } from './sources/github.ts'
import { sameName } from './infra/text.ts'

/** Where the loop keeps its own bookkeeping, beside the domain state. */
const pollKey = 'github:poll'
const seenKey = (id: string) => `github:seen:${id}`

/** A Source Scope that listens to the configured repository's threads. */
function sourceScope(settings: Settings): SourceScope {
  return {
    scope: input => {
      if (input.source !== 'github') return { listened: false, reason: 'unsupported' }
      const repository = (input.meta.repository as string | undefined) ?? settings.github?.repository
      if (!repository || !settings.github?.enabled) return { listened: false, reason: 'sourceOff' }
      if (!sameName(repository, settings.github.repository)) return { listened: false, reason: 'otherRepository' }
      return { listened: true, observed: false }
    },
  }
}

/** A Policy that admits a person on the allow list who addressed the agent, and nothing else. */
function buildPolicy(settings: Settings): Policy {
  const allowed = new Set((settings.github?.allowed ?? []).map(name => name.toLowerCase()))
  const version = String(allowed.size)
  return {
    version,
    paused: false,
    gate: trigger => {
      if (!trigger.human) return { admissible: false, reason: 'bot' }
      if (!allowed.has(trigger.actor.id.toLowerCase())) return { admissible: false, reason: 'notAllowed' }
      if (!trigger.addressed) return { admissible: false, reason: 'notAddressed' }
      return { admissible: true, strength: 'explicit', basis: { via: 'listed', addressed: 'mention' } }
    },
    revalidate: mandate => mandate.basis.via !== 'bot' && allowed.has(mandate.actor.id.toLowerCase()),
    admitsInferred: () => false,
    evalTimeoutMs: 120_000,
  } as Policy
}

/** Marks a request accepted without a model call: an explicit mention by an allowed person is its own authorization. */
const explicitAssessor: Assessor = { request: candidate => { accepted.push(candidate) }, release: () => {} }
const accepted: Candidate[] = []

/** A failed save of the last round must not stop the next one. */
function outbox(): Outbox {
  const messages = new Map<string, OutboundMessage>()
  return {
    send: message => { if (!messages.has(message.id)) messages.set(message.id, message) },
    status: id => messages.has(id) ? 'pending' : undefined,
    withdraw: id => { messages.delete(id) },
    /** Everything queued so far, for the caller to deliver in order. */
    drain: () => [...messages.values()].sort((a, b) => a.id.localeCompare(b.id)),
  } as Outbox & { drain: () => OutboundMessage[] }
}

/**
 * Runs a ticket on the configured agent.
 *
 * The Engine calls `start` and expects a report through its own callbacks; this keeps the work asynchronous, so the loop
 * never blocks on an agent turn.
 */
class AgentExecutor implements Executor {
  private readonly active = new Map<string, AbortController>()
  constructor(private readonly options: {
    settings: Settings
    runner: AgentRunner
    stateDir: string
    repository: string
    agent: string
    accounts: EnvironmentAccounts
    site: { started(ticketId: string, assignmentId: string): void; reported(ticketId: string, report: { state: string; summary: string; question?: string | null }): void
      failed(ticketId: string, assignmentId: string, summary: string): void }
    prompt: (ticket: Ticket, directory: string) => Promise<string>
  }) {}

  start(ticket: Ticket, assignment: Assignment): void {
    const controller = new AbortController()
    this.active.set(ticket.id, controller)
    void this.execute(ticket, assignment, controller)
  }

  deliver(): void {
    // A ticket runs one turn at a time; a message that arrives mid-turn is read at the next start.
  }

  stop(ticket: Ticket): void {
    this.active.get(ticket.id)?.abort()
    this.active.delete(ticket.id)
  }

  private async execute(ticket: Ticket, assignment: Assignment, controller: AbortController): Promise<void> {
    const { settings, runner, stateDir, accounts, site } = this.options
    const directory = ticket.execution?.directory ?? join(stateDir, 'work', ticket.id)
    try {
      await mkdir(directory, { recursive: true })
      if (settings.executor.prepare) await run('/bin/sh', ['-c', settings.executor.prepare], { env: this.variables(ticket, directory), timeoutMs: 120_000 })
      site.started(ticket.id, assignment.id)
      const prompt = await this.options.prompt(ticket, directory)
      const result = await runner.run({
        prompt,
        cwd: directory,
        env: runEnvironment(accounts, this.variables(ticket, directory)),
        signal: controller.signal,
        timeoutMs: settings.executor.timeoutMinutes * 60_000,
        model: settings.executor.model,
      })
      const report = result.report ?? inferReport(result.finalText, result.ok)
      await appendLog(directory, prompt, result.raw.slice(-20_000), report)
      site.reported(ticket.id, { state: report.state ?? (result.ok ? 'ready' : 'failed'), summary: report.summary, question: report.question ?? null })
    } catch (error) {
      site.failed(ticket.id, assignment.id, `The agent could not run: ${(error as Error).message}`)
    } finally { this.active.delete(ticket.id) }
  }

  private variables(ticket: Ticket, directory: string): Record<string, string> {
    const trigger = ticket.origin
    return {
      SUPERAGENT_TICKET: ticket.id,
      SUPERAGENT_DIR: directory,
      SUPERAGENT_REPOSITORY: this.options.repository,
      SUPERAGENT_TRIGGER: trigger.triggerId,
      DSH_SUPERAGENT_DIR: directory,
      DSH_SUPERAGENT_TICKET: ticket.id,
      DSH_SUPERAGENT_GITHUB_REPOSITORY: this.options.repository,
    }
  }
}

/** Turns an agent that wrote no report into one the Engine can still act on. */
function inferReport(text: string, ok: boolean): AgentReport {
  return {
    summary: text.trim().split('\n').filter(Boolean).at(-1)?.slice(0, 500) || (ok ? 'The agent finished.' : 'The agent failed.'),
    state: ok ? 'ready' : 'failed',
  }
}

async function appendLog(directory: string, prompt: string, raw: string, report: AgentReport): Promise<void> {
  const path = join(directory, '.superagent', 'log.md')
  const entry = ['', `## ${new Date().toISOString()}`, '', '**Report**', '', '```json', JSON.stringify(report, null, 2), '```', '', '**Agent output**', '', '```', raw, '```'].join('\n')
  const previous = await readFile(path, 'utf8').catch(() => '')
  await writeFile(path, `${previous}${entry}\n`).catch(() => {})
}

export interface LoopOptions {
  settings: Settings
  repo: FileRepositories
  signal: AbortSignal
  log: (line: string) => void
  /** Run one round and return, instead of waiting for the poll interval. */
  once?: boolean
}

/** Runs rounds until `signal` aborts; each round polls, assesses, and starts the tickets accepted. */
export async function runLoop(options: LoopOptions): Promise<void> {
  const { settings, repo, signal, log } = options
  const github = settings.github
  if (!github?.enabled) throw new Error('The GitHub Source is off in settings.yaml; nothing to poll.')
  const login = await agentLogin(github.cli, signal)
  const accounts: EnvironmentAccounts = { stateDir: settings.stateDir, githubCli: github.cli, agentLogin: login }
  await writeEnvironment(accounts, settings.executor.blockedCommands)

  const channel = outbox() as Outbox & { drain: () => OutboundMessage[] }
  const pending: Array<{ ticketId: string; report: { state: string; summary: string; question?: string | null } }> = []
  const failures: Array<{ ticketId: string; summary: string }> = []
  const started: Array<{ ticketId: string; assignmentId: string }> = []

  const engine = new Engine({
    repo,
    policy: () => buildPolicy(settings),
    scope: sourceScope(settings),
    assessor: explicitAssessor,
    executor: undefined as unknown as Executor,
    outbox: channel,
  })
  const executor = new AgentExecutor({
    settings, runner: runnerFor(settings.executor.agent as AgentName, settings.executor.binary), stateDir: settings.stateDir,
    repository: github.repository, agent: login, accounts,
    site: {
      started: (ticketId, assignmentId) => started.push({ ticketId, assignmentId }),
      reported: (ticketId, report) => pending.push({ ticketId, report }),
      failed: (ticketId, _assignmentId, summary) => failures.push({ ticketId, summary }),
    },
    prompt: async (ticket, directory) => {
      const trigger = repo.triggers.get(ticket.origin.triggerId)
      return composePrompt({ ticket, trigger, repository: github.repository, agentLogin: login, branchPrefix: settings.branchPrefix,
        instructions: settings.prompts })
    },
  })
  // The Engine takes its Executor at construction and the Executor reports back through the Engine, so the two are joined here.
  ;(engine as unknown as { options: { executor: Executor } }).options.executor = executor

  let since = (repo.getMeta<string>(pollKey) ?? new Date().toISOString())
  while (!signal.aborted) {
    const round = new Date().toISOString()
    try {
      await repo.reload()
      const triggers = await pollNotifications({
        cli: github.cli, repository: github.repository, agent: login, since, signal,
        seen: id => repo.getMeta<boolean>(seenKey(id)) === true,
        mark: id => repo.setMeta(seenKey(id), true),
      })
      for (const trigger of triggers) {
        const result = engine.receive(trigger)
        if (result !== 'duplicate') log(`Received ${trigger.id} from ${trigger.actor.id} on ${trigger.threads[0]!.id}`)
      }
      since = round
      repo.setMeta(pollKey, since)
      // The Engine queues an Eval per new thread; running it hands the candidate to the assessor, which accepts it.
      engine.evaluateDue()
      advance(engine, repo, log, accepted.splice(0))
      settle(engine, { pending, failures, started })
      await repo.flush()
      await send(channel, github.cli, log)
      await repo.flush()
    } catch (error) {
      if (!signal.aborted) log(`Round failed: ${(error as Error).message}\n${(error as Error).stack?.split('\n').slice(1, 4).join('\n')}`)
    }
    if (options.once) return
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, github.pollSeconds * 1000)
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
}

/** Decides the requests the assessor accepted, which starts their tickets. */
function advance(engine: Engine, repo: FileRepositories, log: (line: string) => void, candidates: Candidate[]): void {
  for (const candidate of candidates) {
    const trigger = repo.triggers.get(candidate.triggers[0]!.id)
    if (!trigger) continue
    const name = trigger.text.split('\n')[0]!.replace(/@[\w-]+/g, '').trim().slice(0, 60) || 'Request'
    try {
      const decision = engine.decide(trigger.id, { kind: 'accept', title: name, scope: name, reason: 'explicit' } as AssessmentOutcome)
      log(`Accepted ${trigger.id} as ticket ${decision.ticketId ?? '(none)'}`)
    } catch (error) {
      log(`Could not accept ${trigger.id}: ${(error as Error).message}`)
    }
  }
}

/** Records the reports finished agent turns produced, so a ticket ends without the loop holding work in memory. */
async function settle(engine: Engine, state: { pending: Array<{ ticketId: string; report: { state: string; summary: string; question?: string | null } }>
  failures: Array<{ ticketId: string; summary: string }>; started: Array<{ ticketId: string; assignmentId: string }> }): Promise<void> {
  for (const item of state.started.splice(0)) engine.assignmentStarted(item.ticketId, item.assignmentId)
  for (const item of state.failures.splice(0)) engine.report(item.ticketId, { state: 'failed', summary: item.summary })
  for (const item of state.pending.splice(0)) {
    engine.report(item.ticketId, { state: item.report.state as 'ready', summary: item.report.summary,
      ...item.report.question ? { question: item.report.question } : {} })
  }
}

/** Posts the messages the Engine queued, one comment per message. */
async function send(channel: Outbox & { drain: () => OutboundMessage[] }, cli: string, log: (line: string) => void): Promise<void> {
  const queued = channel.drain()
  if (!queued.length) return
  const channelOf = (message: OutboundMessage): { repository?: string; number?: string } => message.channel.address as { repository?: string; number?: string }
  for (const message of queued) {
    const address = channelOf(message)
    if (!address.number || !address.repository) continue
    try {
      await run(cli, ['api', `repos/${address.repository}/issues/${address.number}/comments`, '-f', `body=${message.text}`])
      log(`Posted a message on ${address.repository}#${address.number}`)
    } catch (error) { log(`Could not post on ${address.repository}#${address.number}: ${(error as Error).message}`) }
  }
}
