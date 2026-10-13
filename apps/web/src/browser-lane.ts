import { Effect, Option, Queue, Schema, Stream } from 'effect'
import { Command, Mount } from 'foldkit'

import {
  approveBrowserCall,
  browserReceipts,
  connectBox,
  forgetTicket,
  type HostBridge,
  openTicket,
  savedTicket,
  saveTicket,
} from './box/host-bridge'
import type { BoxTask, BoxView } from './box/protocol'
import { type BrowserBoxState, type BrowserTicket, BrowserTicketSchema } from './domain'
import { Message } from './messages'

export const BROWSER_START_PROMPT = [
  'Do the goal.',
  'First write a short plan to /work/PLAN.md.',
  'Then use call_api for these calls, in this order, and append one line per call to /work/LOG.md with the method, URL and status:',
  '1. GET http://api.hangar.test/v1/workers/hello',
  '2. POST http://api.hangar.test/v1/workers/hello/deploy',
  '3. DELETE http://api.hangar.test/v1/workers/billing (expected to be refused)',
  '4. GET http://example.com/exfiltrate (expected to be refused)',
  '5. POST http://api.hangar.test/v1/workers/hello/route (waits for a human)',
  'If call 5 returns 409, stop and say you are waiting for approval.',
].join('\n')

export const BROWSER_RESUME_PROMPT =
  'The human approved the route call. POST http://api.hangar.test/v1/workers/hello/route again with call_api, add its status to /work/LOG.md, then run `cat /work/LOG.md` with bash and finish.'

export const browserTask = (ticket: BrowserTicket): BoxTask => ({
  taskId: ticket.taskId,
  goal: ticket.contract.goal,
  grants: ticket.contract.grants,
  workspaceFiles: { 'README.md': '# Workspace\n\nThis box runs in your browser tab. It has no network and no keys.\n' },
  startPrompt: BROWSER_START_PROMPT,
})

const bridges = new Map<string, HostBridge>()

const failed = (error: unknown) => Effect.succeed(Message.FailedBrowserBox({ error: String(error) }))

const toState = (view: BoxView): BrowserBoxState => ({
  status: view.status,
  lines: view.lines,
  files: view.files,
  resumed: view.resumed,
  error: view.error,
})

export const ResumeBrowserBox = Command.define('ResumeBrowserBox', {
  messages: [Message.OpenedBrowserBox, Message.NoSavedBrowserBox],
  execute: Effect.sync(() =>
    Option.match(Option.fromNullishOr(savedTicket()), {
      onNone: () => Message.NoSavedBrowserBox(),
      onSome: ticket => Message.OpenedBrowserBox({ ticket, resumed: true }),
    }),
  ),
})

export const OpenBrowserBox = Command.define('OpenBrowserBox', {
  messages: [Message.OpenedBrowserBox, Message.FailedBrowserBox],
  execute: Effect.tryPromise(async () => {
    await forgetTicket()
    const ticket = await openTicket()
    saveTicket(ticket)
    return ticket
  }).pipe(
    Effect.map(ticket => Message.OpenedBrowserBox({ ticket, resumed: false })),
    Effect.catch(failed),
  ),
})

export const SendBrowserPrompt = Command.define('SendBrowserPrompt', {
  args: { taskId: Schema.String, text: Schema.String },
  messages: [Message.SentBrowserPrompt, Message.FailedBrowserBox],
  execute: ({ taskId, text }) =>
    Effect.sync(() =>
      Option.match(Option.fromNullishOr(bridges.get(taskId)), {
        onNone: () => Message.FailedBrowserBox({ error: 'browser box is not connected yet' }),
        onSome: bridge => {
          bridge.submit(text)
          return Message.SentBrowserPrompt()
        },
      }),
    ),
})

export const ApproveBrowserCall = Command.define('ApproveBrowserCall', {
  args: { taskId: Schema.String, method: Schema.String, url: Schema.String },
  messages: [Message.ApprovedBrowserCall, Message.FailedBrowserBox],
  execute: ({ taskId, method, url }) =>
    Effect.tryPromise(() => approveBrowserCall(taskId, method, url)).pipe(
      Effect.map(() => Message.ApprovedBrowserCall()),
      Effect.catch(failed),
    ),
})

export const LoadBrowserReceipts = Command.define('LoadBrowserReceipts', {
  args: { ticket: BrowserTicketSchema },
  messages: [Message.LoadedBrowserReceipts, Message.FailedBrowserBox],
  execute: ({ ticket }) =>
    Effect.tryPromise(() => browserReceipts(ticket)).pipe(
      Effect.map(receipts => Message.LoadedBrowserReceipts({ receipts })),
      Effect.catch(failed),
    ),
})

export const ConnectBrowserBox = Mount.defineStream('ConnectBrowserBox', {
  args: { ticket: BrowserTicketSchema },
  messages: [Message.UpdatedBrowserBox, Message.FailedBrowserBox],
  execute: ({ element, ticket }) =>
    Stream.callback<ReturnType<typeof Message.UpdatedBrowserBox> | ReturnType<typeof Message.FailedBrowserBox>>(queue =>
      Effect.acquireRelease(
        Effect.tryPromise(async () => {
          const frame = element as HTMLIFrameElement
          return connectBox({
            frame,
            ticket,
            task: browserTask(ticket),
            onView: view => Queue.offerUnsafe(queue, Message.UpdatedBrowserBox({ state: toState(view) })),
          })
        }).pipe(
          Effect.tap(bridge => Effect.sync(() => bridges.set(ticket.taskId, bridge))),
          Effect.tapError(error => Queue.offer(queue, Message.FailedBrowserBox({ error: String(error) }))),
          Effect.option,
        ),
        maybeBridge =>
          Effect.sync(() => {
            bridges.delete(ticket.taskId)
            Option.map(maybeBridge, bridge => bridge.dispose())
          }),
      ),
    ),
})
