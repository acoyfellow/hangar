import 'fake-indexeddb/auto'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { describe, expect, it } from 'vitest'

import { BrowserExecutionEnv } from './browser-env'
import { IndexedDbFileStore } from './file-store'
import { openHarness, rootAgent, type ModelCaller, type ToolCaller } from './harness'
import type { HttpReply } from './protocol'

const context = BACKGROUND_CONTEXT

type ScriptedTurn =
  | { readonly toolCall: { readonly name: string; readonly args: Record<string, unknown> } }
  | { readonly text: string }

const sse = (chunks: ReadonlyArray<unknown>): HttpReply => ({
  status: 200,
  contentType: 'text/event-stream',
  body: `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
})

const replyFor = (turn: ScriptedTurn, index: number): HttpReply => {
  const base = { id: `turn-${index}`, object: 'chat.completion.chunk', created: 0, model: 'scripted' }
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  if ('text' in turn) {
    return sse([
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: turn.text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
    ])
  }
  const call = { index: 0, id: `call-${index}`, type: 'function', function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.args) } }
  return sse([
    { ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] }, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage },
  ])
}

const scriptedModel = (turns: ReadonlyArray<ScriptedTurn>) => {
  const requests: Array<Record<string, unknown>> = []
  const callModel: ModelCaller = async body => {
    requests.push(JSON.parse(body) as Record<string, unknown>)
    const turn = turns[requests.length - 1]
    if (turn === undefined) throw new Error(`model called ${requests.length} times; script has ${turns.length} turns`)
    return replyFor(turn, requests.length - 1)
  }
  return { callModel, requests }
}

const refereeStub = () => {
  const calls: Array<string> = []
  const callTool: ToolCaller = async (method, url) => {
    calls.push(`${method} ${url}`)
    const allowed = url.startsWith('http://api.hangar.test/v1/workers/hello') && method !== 'DELETE'
    return allowed
      ? { status: 200, contentType: 'application/json', body: '{"ok":true}' }
      : { status: 403, contentType: 'application/json', body: '{"refused":true,"reason":"not in the contract"}' }
  }
  return { callTool, calls }
}

const until = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 500 && !condition(); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  if (!condition()) throw new Error('condition never became true')
}

const grants = [{ method: 'GET', host: 'api.hangar.test', pathPrefix: '/v1/workers/hello', needsApproval: false }]

const boxOver = async (databaseName: string) => {
  const store = await IndexedDbFileStore.open(databaseName)
  const env = await BrowserExecutionEnv.open({ id: 'harness-test', cwd: '/work', store })
  return { store, env }
}

describe('Pi Durable harness in the browser box', () => {
  it('runs a task with coding tools, a bash shell and the referee-only call_api tool', async () => {
    const model = scriptedModel([
      { toolCall: { name: 'write', args: { path: '/work/PLAN.md', content: '1. check hello\n' } } },
      { toolCall: { name: 'call_api', args: { method: 'GET', url: 'http://api.hangar.test/v1/workers/hello' } } },
      { toolCall: { name: 'call_api', args: { method: 'GET', url: 'http://example.com/exfiltrate' } } },
      { toolCall: { name: 'bash', args: { command: 'echo "hello: 200" >> /work/LOG.md && cat /work/PLAN.md /work/LOG.md' } } },
      { text: 'Done. Hello is up; the exfiltrate call was refused.' },
    ])
    const referee = refereeStub()
    const { store, env } = await boxOver(`harness-${crypto.randomUUID()}`)
    const harness = await openHarness({ env, goal: 'Check hello', grants, callModel: model.callModel, callTool: referee.callTool, context })
    const root = await harness.root(context, { agent: rootAgent })

    const settled = await (await root.submit({ type: 'input', content: 'go' }, context)).wait(context)

    expect(settled.status).toBe('done')
    expect(referee.calls).toEqual(['GET http://api.hangar.test/v1/workers/hello', 'GET http://example.com/exfiltrate'])
    expect(await env.readTextFile('/work/LOG.md', context)).toEqual({ ok: true, value: 'hello: 200\n' })
    const offeredTools = (model.requests[0]!['tools'] as Array<{ function: { name: string } }>).map(tool => tool.function.name).sort()
    expect(offeredTools).toEqual(['bash', 'call_api', 'edit', 'read', 'write'])
    const lastRequest = JSON.stringify(model.requests[model.requests.length - 1])
    expect(lastRequest).toContain('not in the contract')
    expect(lastRequest).toContain('1. check hello')
    await harness.close(context)
    store.close()
  })

  it('continues an interrupted run after the tab reloads, from what IndexedDB kept', async () => {
    const databaseName = `harness-${crypto.randomUUID()}`
    let releaseModel: () => void = () => undefined
    const blockedUntilReload = new Promise<void>(resolve => {
      releaseModel = resolve
    })
    const firstTab = scriptedModel([{ toolCall: { name: 'write', args: { path: '/work/step1.txt', content: 'one' } } }])
    let stalled = false
    const stallingModel: ModelCaller = async body => {
      if (firstTab.requests.length >= 1) {
        stalled = true
        await blockedUntilReload
        throw new Error('tab closed')
      }
      return firstTab.callModel(body)
    }
    const before = await boxOver(databaseName)
    const harness = await openHarness({
      env: before.env,
      goal: 'two steps',
      grants,
      callModel: stallingModel,
      callTool: refereeStub().callTool,
      context,
    })
    const root = await harness.root(context, { agent: rootAgent })
    const submission = await root.submit({ type: 'input', content: 'do two steps', requestId: 'job-1' }, context)
    await until(() => firstTab.requests.length === 1 && stalled)
    before.store.close()
    releaseModel()

    const secondTab = scriptedModel([
      { toolCall: { name: 'write', args: { path: '/work/step2.txt', content: 'two' } } },
      { text: 'Both steps done.' },
    ])
    const after = await boxOver(databaseName)
    expect(await after.env.readTextFile('/work/step1.txt', context)).toEqual({ ok: true, value: 'one' })
    const reopened = await openHarness({
      env: after.env,
      goal: 'two steps',
      grants,
      callModel: secondTab.callModel,
      callTool: refereeStub().callTool,
      context,
    })
    const sameRoot = await reopened.root(context)
    reopened.resume()
    const again = await sameRoot.submit({ type: 'input', content: 'do two steps', requestId: 'job-1' }, context)
    expect(again.id).toBe(submission.id)
    const settled = await again.wait(context)

    expect(settled.status).toBe('done')
    expect(await after.env.readTextFile('/work/step2.txt', context)).toEqual({ ok: true, value: 'two' })
    const resumedRequest = JSON.stringify(secondTab.requests[0])
    expect(resumedRequest).toContain('do two steps')
    expect(resumedRequest).toContain('step1.txt')
    expect(secondTab.requests).toHaveLength(2)
    await reopened.close(context)
    after.store.close()
  })
})
