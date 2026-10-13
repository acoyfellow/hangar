import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Conversation, Harness } from '@earendil-works/pi-durable'

import { BrowserExecutionEnv } from './browser-env'
import { openHarness, rootAgent, WORKSPACE } from './harness'
import { PortClient, PortFileStore } from './port-client'
import { BOX_HELLO, type BoxTask, type BoxView, HOST_PING, type HostToBox, PORT_HANDSHAKE } from './protocol'
import { transcriptLines } from './transcript'

const context = BACKGROUND_CONTEXT

interface Running {
  readonly env: BrowserExecutionEnv
  readonly harness: Harness
  readonly root: Conversation
  readonly resumed: boolean
}

const listFiles = async (env: BrowserExecutionEnv, directory: string): Promise<ReadonlyArray<string>> => {
  const listed = await env.listDir(directory, context)
  if (!listed.ok) return []
  const nested = await Promise.all(
    listed.value.map(info => (info.kind === 'directory' ? listFiles(env, info.path) : Promise.resolve([info.path]))),
  )
  return nested.flat().sort()
}

const start = async (client: PortClient, task: BoxTask): Promise<Running> => {
  const env = await BrowserExecutionEnv.open({ id: `browser-box:${task.taskId}`, cwd: WORKSPACE, store: new PortFileStore(client) })
  const harnessFound = await env.exists('/harness', context)
  const resumed = harnessFound.ok && harnessFound.value
  if (!resumed) {
    for (const [path, content] of Object.entries(task.workspaceFiles)) await env.writeFile(path, content, context)
  }
  const harness = await openHarness({
    env,
    goal: task.goal,
    grants: task.grants,
    callModel: body => client.http({ kind: 'model', body }),
    callTool: (method, url) => client.http({ kind: 'tool', method, url }),
    context,
  })
  const root = await harness.root(context, { agent: rootAgent })
  harness.resume()
  return { env, harness, root, resumed }
}

const publishViews = async (client: PortClient, running: Running): Promise<(message: string) => void> => {
  const view = await running.root.viewState(context)
  let failure: string | null = null
  const publish = async () => {
    const live = view.value.docs['pi.live'] as { run?: unknown } | undefined
    const status: BoxView['status'] = failure !== null ? 'failed' : live?.run === undefined ? 'idle' : 'running'
    client.send({
      kind: 'view',
      view: {
        status,
        lines: transcriptLines(view.value.entries),
        files: await listFiles(running.env, WORKSPACE),
        resumed: running.resumed,
        error: failure,
      },
    })
  }
  view.subscribe(() => void publish())
  await publish()
  return message => {
    failure = message
    void publish()
  }
}

const failedView = (message: string): BoxView => ({ status: 'failed', lines: [], files: [], resumed: false, error: message })

const connect = (port: MessagePort) => {
  const client = new PortClient(port)
  let running: Promise<Running> | undefined
  let reportFailure: (message: string) => void = message => client.send({ kind: 'view', view: failedView(message) })
  port.onmessage = async (event: MessageEvent<HostToBox>) => {
    const message = event.data
    if (message.kind === 'reply') return client.receive(message.id, message.reply)
    if (message.kind === 'start') {
      running ??= start(client, message.task)
      try {
        reportFailure = await publishViews(client, await running)
      } catch (error) {
        reportFailure(String(error))
      }
      return
    }
    if (message.kind === 'submit' && running !== undefined) {
      const { root } = await running
      const submission = await root.submit({ type: 'input', content: message.text, requestId: message.requestId }, context)
      const settled = await submission.wait(context)
      if (settled.status === 'unanswered') reportFailure(`run ended without an answer: ${JSON.stringify(settled.reason ?? settled)}`)
    }
  }
  port.start()
  client.send({ kind: 'ready' })
}

let connected = false

addEventListener('message', (event: MessageEvent) => {
  if (event.source !== parent) return
  if (event.data === HOST_PING && !connected) return parent.postMessage(BOX_HELLO, '*')
  if (event.data !== PORT_HANDSHAKE || connected || event.ports[0] === undefined) return
  connected = true
  connect(event.ports[0])
})

parent.postMessage(BOX_HELLO, '*')
