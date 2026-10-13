import { IndexedDbFileStore } from './file-store'
import {
  type BoxReply,
  type BoxRequest,
  type BoxTask,
  type BoxToHost,
  type BoxView,
  type HostToBox,
  type HttpReply,
  BOX_HELLO,
  HOST_PING,
  PORT_HANDSHAKE,
} from './protocol'

export interface BrowserTicket {
  readonly taskId: string
  readonly ticket: string
  readonly contract: { readonly goal: string; readonly grants: BoxTask['grants'] }
  readonly model: string
  readonly tokenBudget: number
}

export interface HostBridge {
  readonly submit: (text: string) => void
  readonly dispose: () => void
}

const SAVED_TICKET_KEY = 'hangar.browser-box.ticket'
const ALLOWED_REQUESTS = new Set<BoxRequest['kind']>(['store.load', 'store.apply', 'model', 'tool'])

export const savedTicket = (): BrowserTicket | undefined => {
  const raw = localStorage.getItem(SAVED_TICKET_KEY)
  return raw === null ? undefined : (JSON.parse(raw) as BrowserTicket)
}

export const saveTicket = (ticket: BrowserTicket): void => localStorage.setItem(SAVED_TICKET_KEY, JSON.stringify(ticket))

export const forgetTicket = async (): Promise<void> => {
  const ticket = savedTicket()
  localStorage.removeItem(SAVED_TICKET_KEY)
  if (ticket !== undefined) {
    await new Promise<void>(resolve => {
      const request = indexedDB.deleteDatabase(databaseName(ticket.taskId))
      request.onsuccess = () => resolve()
      request.onerror = () => resolve()
      request.onblocked = () => resolve()
    })
  }
}

const databaseName = (taskId: string) => `hangar-browser-box-${taskId}`

const postJson = async (path: string, body: unknown): Promise<HttpReply> => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, contentType: response.headers.get('content-type') ?? 'application/json', body: await response.text() }
}

export const openTicket = async (): Promise<BrowserTicket> => {
  const reply = await postJson('/api/browser/open', {})
  if (reply.status !== 200) throw new Error(`open ticket: ${reply.status} ${reply.body}`)
  return JSON.parse(reply.body) as BrowserTicket
}

const answer = async (ticket: BrowserTicket, store: IndexedDbFileStore, request: BoxRequest): Promise<BoxReply> => {
  switch (request.kind) {
    case 'store.load':
      return { kind: 'store.load', entries: await store.load() }
    case 'store.apply':
      await store.apply(request.changes)
      return { kind: 'done' }
    case 'model':
      return {
        kind: 'http',
        reply: await postJson(`/api/browser/model/${ticket.taskId}/${ticket.ticket}/chat/completions`, JSON.parse(request.body)),
      }
    case 'tool': {
      const relayed = await postJson('/api/browser/tool', {
        taskId: ticket.taskId,
        ticket: ticket.ticket,
        method: request.method,
        url: request.url,
      })
      const decided = JSON.parse(relayed.body) as { status: number; body: string }
      return { kind: 'http', reply: { status: decided.status, contentType: 'application/json', body: decided.body } }
    }
  }
}

export const connectBox = async (options: {
  readonly frame: HTMLIFrameElement
  readonly ticket: BrowserTicket
  readonly task: BoxTask
  readonly onView: (view: BoxView) => void
}): Promise<HostBridge> => {
  const store = await IndexedDbFileStore.open(databaseName(options.ticket.taskId))
  const channel = new MessageChannel()
  const port = channel.port1
  const send = (message: HostToBox) => port.postMessage(message)
  port.onmessage = async (event: MessageEvent<BoxToHost>) => {
    const message = event.data
    if (message.kind === 'ready') return send({ kind: 'start', task: options.task })
    if (message.kind === 'view') return options.onView(message.view)
    if (message.kind !== 'request' || !ALLOWED_REQUESTS.has(message.request.kind)) return
    try {
      send({ kind: 'reply', id: message.id, reply: await answer(options.ticket, store, message.request) })
    } catch (error) {
      send({ kind: 'reply', id: message.id, reply: { kind: 'error', message: String(error) } })
    }
  }
  port.start()
  let portHandedOver = false
  const onHello = (event: MessageEvent) => {
    if (portHandedOver || event.source !== options.frame.contentWindow || event.data !== BOX_HELLO) return
    portHandedOver = true
    options.frame.contentWindow?.postMessage(PORT_HANDSHAKE, '*', [channel.port2])
  }
  addEventListener('message', onHello)
  options.frame.contentWindow?.postMessage(HOST_PING, '*')
  return {
    submit: text => send({ kind: 'submit', text, requestId: crypto.randomUUID() }),
    dispose: () => {
      removeEventListener('message', onHello)
      port.close()
      store.close()
    },
  }
}

export const approveBrowserCall = async (taskId: string, method: string, url: string): Promise<void> => {
  const reply = await postJson('/api/browser/approve', { taskId, method, url })
  if (reply.status !== 200) throw new Error(`approve: ${reply.status} ${reply.body}`)
}

export const browserReceipts = async (ticket: BrowserTicket) => {
  const reply = await postJson('/api/browser/receipts', { taskId: ticket.taskId, ticket: ticket.ticket })
  return JSON.parse(reply.body) as ReadonlyArray<{
    at: number
    method: string
    url: string
    decision: 'allowed' | 'refused' | 'awaiting-approval'
    reason: string
    upstreamStatus: number | null
  }>
}
