import type { StoreChange, StoredEntry } from './file-store'

export interface BoxGrant {
  readonly method: string
  readonly host: string
  readonly pathPrefix: string
  readonly needsApproval: boolean
}

export interface BoxTask {
  readonly taskId: string
  readonly goal: string
  readonly grants: ReadonlyArray<BoxGrant>
  readonly workspaceFiles: Readonly<Record<string, string>>
  readonly startPrompt: string
}

export interface HttpReply {
  readonly status: number
  readonly contentType: string
  readonly body: string
}

export type BoxRequest =
  | { readonly kind: 'store.load' }
  | { readonly kind: 'store.apply'; readonly changes: ReadonlyArray<StoreChange> }
  | { readonly kind: 'model'; readonly body: string }
  | { readonly kind: 'tool'; readonly method: string; readonly url: string }

export type BoxReply =
  | { readonly kind: 'store.load'; readonly entries: ReadonlyArray<StoredEntry> }
  | { readonly kind: 'done' }
  | { readonly kind: 'http'; readonly reply: HttpReply }
  | { readonly kind: 'error'; readonly message: string }

export type TranscriptLine =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'tool-call'; readonly name: string; readonly args: string }
  | { readonly kind: 'tool-result'; readonly name: string; readonly text: string; readonly isError: boolean }

export interface BoxView {
  readonly status: 'starting' | 'running' | 'idle' | 'failed'
  readonly lines: ReadonlyArray<TranscriptLine>
  readonly files: ReadonlyArray<string>
  readonly resumed: boolean
  readonly error: string | null
}

export type HostToBox =
  | { readonly kind: 'start'; readonly task: BoxTask }
  | { readonly kind: 'submit'; readonly text: string; readonly requestId: string }
  | { readonly kind: 'reply'; readonly id: number; readonly reply: BoxReply }

export type BoxToHost =
  | { readonly kind: 'request'; readonly id: number; readonly request: BoxRequest }
  | { readonly kind: 'view'; readonly view: BoxView }
  | { readonly kind: 'ready' }

export const BOX_HELLO = 'hangar-box-hello'
export const HOST_PING = 'hangar-host-ping'
export const PORT_HANDSHAKE = 'hangar-box-port'
