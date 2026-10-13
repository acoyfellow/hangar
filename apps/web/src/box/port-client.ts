import type { FileStore, StoreChange, StoredEntry } from './file-store'
import type { BoxReply, BoxRequest, BoxToHost, HttpReply } from './protocol'

export class PortClient {
  private nextId = 1
  private readonly waiting = new Map<number, (reply: BoxReply) => void>()

  constructor(private readonly port: MessagePort) {}

  receive(id: number, reply: BoxReply): void {
    const resolve = this.waiting.get(id)
    if (resolve === undefined) return
    this.waiting.delete(id)
    resolve(reply)
  }

  send(message: BoxToHost): void {
    this.port.postMessage(message)
  }

  request(request: BoxRequest): Promise<BoxReply> {
    const id = this.nextId++
    return new Promise(resolve => {
      this.waiting.set(id, resolve)
      this.send({ kind: 'request', id, request })
    })
  }

  async http(request: BoxRequest): Promise<HttpReply> {
    const reply = await this.request(request)
    if (reply.kind === 'http') return reply.reply
    throw new Error(reply.kind === 'error' ? reply.message : `unexpected reply ${reply.kind}`)
  }
}

export class PortFileStore implements FileStore {
  constructor(private readonly client: PortClient) {}

  async load(): Promise<ReadonlyArray<StoredEntry>> {
    const reply = await this.client.request({ kind: 'store.load' })
    if (reply.kind === 'store.load') return reply.entries
    throw new Error(reply.kind === 'error' ? reply.message : 'store load failed')
  }

  async apply(changes: ReadonlyArray<StoreChange>): Promise<void> {
    if (changes.length === 0) return
    const reply = await this.client.request({ kind: 'store.apply', changes })
    if (reply.kind === 'error') throw new Error(reply.message)
  }
}
