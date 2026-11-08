/**
 * The prompt a ticket's agent receives.
 *
 * It is assembled here rather than read from files so that an installation has one thing to read: `settings.yaml`. The
 * team-editable part is `prompts.instructions`, which the operator writes in their own words.
 */
import type { Ticket, Trigger } from './core/index.ts'
import { reportInstructions } from './agents/types.ts'

export interface PromptInput {
  ticket: Ticket
  trigger: Trigger | undefined
  repository: string
  agentLogin: string
  branchPrefix: string
  /** The operator's own instructions, appended before the report contract. */
  instructions: string
}

/** Composes the prompt for one ticket: who asked, what they asked, and what the agent must not assume. */
export function composePrompt(input: PromptInput): string {
  const { ticket, trigger, repository, agentLogin, branchPrefix, instructions } = input
  const asked = trigger
    ? `A person wrote this in ${trigger.url ?? trigger.channel?.thread ?? 'the source conversation'}:\n\n${quote(trigger.text)}`
    : `The ticket has no source message; work on the title alone:\n\n${quote(ticket.title)}`
  return [
    `# Ticket ${ticket.id}`,
    '',
    `You work on the repository \`${repository}\`. Your GitHub account is \`${agentLogin}\`; every GitHub action you take is`,
    'visible to the team under that name.',
    '',
    '## The request',
    '',
    asked,
    '',
    '## How to work',
    '',
    `- Work only in this directory. It is a worktree of the repository on a new branch.`,
    `- Put your branch under \`${branchPrefix}\` followed by a short name, and open a pull request from it when done.`,
    '- Run the tests the repository has. Do not claim a check passed unless you ran it.',
    '- Do not merge the pull request. A person merges it.',
    '- If the request needs a decision you cannot make, stop and ask one concrete question.',
    '',
    ...instructions.trim() ? ['## Team instructions', '', instructions.trim(), ''] : [],
    reportInstructions(),
  ].join('\n')
}

/** Indents a person's message so the agent reads it as quoted material, not as instructions to this prompt. */
function quote(text: string): string {
  const body = text.trim() || '(empty message)'
  return body.split('\n').map(line => `> ${line}`).join('\n')
}
