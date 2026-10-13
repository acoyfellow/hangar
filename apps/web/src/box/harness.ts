import type { Context } from '@earendil-works/chord'
import {
  type Api,
  createModels,
  createProvider,
  type FetchFunction,
  type Model,
  type ProviderStreams,
  Type,
} from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createRegistry, defineExtension, defineTool, Harness, section } from '@earendil-works/pi-durable'
import { JsonlStorage } from '@earendil-works/pi-durable/storage/jsonl'
import { CodingTools } from '@earendil-works/pi-durable/tools'

import type { BrowserExecutionEnv } from './browser-env'
import type { BoxGrant, HttpReply } from './protocol'

export const PROVIDER_ID = 'hangar-referee'
export const MODEL_ID = 'referee-pinned'
export const HARNESS_DIRECTORY = '/harness'
export const WORKSPACE = '/work'
const UNREACHABLE_BASE_URL = 'https://referee.invalid/v1'

export type ModelCaller = (body: string) => Promise<HttpReply>
export type ToolCaller = (method: string, url: string) => Promise<HttpReply>

const refereeModel: Model<'openai-completions'> = {
  id: MODEL_ID,
  name: 'Model behind the Hangar referee',
  api: 'openai-completions',
  provider: PROVIDER_ID,
  baseUrl: UNREACHABLE_BASE_URL,
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, supportsStore: false },
}

const noKeyAuth = {
  apiKey: { name: 'No key: the referee outside the box holds it', resolve: async () => ({ auth: { apiKey: 'none' } }) },
}

const requestBody = async (input: Parameters<FetchFunction>[0], init: Parameters<FetchFunction>[1]): Promise<string> => {
  if (typeof init?.body === 'string') return init.body
  if (input instanceof Request) return input.text()
  return new Response(init?.body ?? null).text()
}

export const bridgedFetch =
  (callModel: ModelCaller): FetchFunction =>
  async (input, init) => {
    const reply = await callModel(await requestBody(input, init))
    return new Response(reply.body, { status: reply.status, headers: { 'content-type': reply.contentType } })
  }

const throughReferee = (streams: ProviderStreams, fetch: FetchFunction): ProviderStreams => ({
  stream: (model: Model<Api>, context, options) => streams.stream(model, context, { ...options, fetch }),
  streamSimple: (model: Model<Api>, context, options) => streams.streamSimple(model, context, { ...options, fetch }),
})

export const callApiTool = (callTool: ToolCaller) =>
  defineTool({
    name: 'call_api',
    description:
      'Send an HTTP request outside the box. A referee checks every request against your contract and adds credentials. Calls outside the contract are refused. Some calls wait for a human: on status 409, stop and say you are waiting for approval.',
    parameters: Type.Object({
      method: Type.Union([Type.Literal('GET'), Type.Literal('POST'), Type.Literal('DELETE')]),
      url: Type.String({ description: 'Full URL, for example http://api.hangar.test/v1/workers/hello' }),
    }),
    execute: async args => {
      const reply = await callTool(args.method, args.url)
      return { content: [{ type: 'text', text: `status ${reply.status}\n${reply.body}` }] }
    },
  })

const contractSection = (goal: string, grants: ReadonlyArray<BoxGrant>) =>
  section('contract', () =>
    [
      `Goal: ${goal}`,
      'Your contract allows only these calls (method, host, path prefix):',
      ...grants.map(
        grant => `- ${grant.method} ${grant.host}${grant.pathPrefix}${grant.needsApproval ? ' (needs human approval)' : ''}`,
      ),
      'You have no internet and no keys. Use call_api for every outside call. Work in /work.',
    ].join('\n'),
  )

export interface HarnessWiring {
  readonly env: BrowserExecutionEnv
  readonly goal: string
  readonly grants: ReadonlyArray<BoxGrant>
  readonly callModel: ModelCaller
  readonly callTool: ToolCaller
  readonly context: Context
  readonly streams?: ProviderStreams
}

export const openHarness = async (wiring: HarnessWiring): Promise<Harness> => {
  const models = createModels()
  models.setProvider(
    createProvider({
      id: PROVIDER_ID,
      auth: noKeyAuth,
      models: [refereeModel],
      api: throughReferee(wiring.streams ?? openAICompletionsApi(), bridgedFetch(wiring.callModel)),
    }),
  )
  const registry = createRegistry()
  registry.install(CodingTools)
  registry.install(
    defineExtension({
      name: 'hangar-contract',
      tools: [callApiTool(wiring.callTool)],
      sections: [contractSection(wiring.goal, wiring.grants)],
    }),
  )
  const storage = await JsonlStorage.open(HARNESS_DIRECTORY, wiring.env, wiring.context)
  return Harness.open(
    storage,
    {
      models,
      registry,
      env: () => wiring.env,
      settings: { retry: { maxRetries: 1 }, toolExecution: 'sequential' },
    },
    wiring.context,
  )
}

export const rootAgent = { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, cwd: WORKSPACE } as const
