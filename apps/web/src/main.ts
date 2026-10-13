import { Array, Duration, Effect, Option, Schema, Stream, pipe } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { Command, Http, Runtime, Subscription, type Update } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { modifyFields } from 'foldkit/struct'

import {
  ApproveBrowserCall,
  BROWSER_RESUME_PROMPT,
  BROWSER_START_PROMPT,
  ConnectBrowserBox,
  LoadBrowserReceipts,
  OpenBrowserBox,
  ResumeBrowserBox,
  SendBrowserPrompt,
} from './browser-lane'
import {
  BrowserLane,
  type BrowserReceipt,
  type TranscriptLine,
  pendingApproval,
  HangarView,
  Lane,
  Launched,
  LaunchPath,
  type Receipt,
  TaskView,
  UpstreamCall,
  isAwaitingApproval,
  isSettled,
} from './domain'

const POLL_INTERVAL_MS = 400


export const Model = Schema.Struct({
  maybeHangar: Schema.Option(HangarView),
  maybePooled: Schema.Option(Lane),
  maybeCold: Schema.Option(Lane),
  upstreamCalls: Schema.Array(UpstreamCall),
  maybeError: Schema.Option(Schema.String),
  isLaunching: Schema.Boolean,
  maybeBrowser: Schema.Option(BrowserLane),
  isOpeningBrowser: Schema.Boolean,
})
export type Model = typeof Model.Type


import { Message } from './messages'
export { Message }


const getJson = <S extends Schema.Top>(path: string, schema: S) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(HttpClientRequest.get(path))
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json)
  })

const postJson = <S extends Schema.Top>(path: string, body: unknown, schema: S) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = HttpClientRequest.post(path).pipe(HttpClientRequest.bodyJsonUnsafe(body))
    const response = yield* client.execute(request)
    return yield* Schema.decodeUnknownEffect(schema)(yield* response.json)
  })

const requestFailed = (label: string) => (cause: unknown) =>
  Effect.succeed(Message.FailedRequest({ error: `${label}: ${String(cause)}` }))

export const LoadHangar = Command.define('LoadHangar', {
  messages: [Message.SucceededLoadHangar, Message.FailedRequest],
  execute: pipe(
    getJson('/api/hangar', HangarView),
    Effect.map(hangar => Message.SucceededLoadHangar({ hangar })),
    Effect.catch(requestFailed('load hangar')),
    Effect.provide(Http.layer),
  ),
})

export const FillHangar = Command.define('FillHangar', {
  messages: [Message.SucceededLoadHangar, Message.FailedRequest],
  execute: pipe(
    postJson('/api/hangar/fill', {}, HangarView),
    Effect.map(hangar => Message.SucceededLoadHangar({ hangar })),
    Effect.catch(requestFailed('fill hangar')),
    Effect.provide(Http.layer),
  ),
})

export const LaunchRace = Command.define('LaunchRace', {
  messages: [Message.SucceededLaunch, Message.FailedRequest],
  execute: pipe(
    Effect.all(
      {
        pooled: postJson('/api/tasks', { path: 'pooled' }, Launched),
        cold: postJson('/api/tasks', { path: 'cold' }, Launched),
      },
      { concurrency: 'unbounded' },
    ),
    Effect.map(({ pooled, cold }) => Message.SucceededLaunch({ pooled, cold })),
    Effect.catch(requestFailed('launch')),
    Effect.provide(Http.layer),
  ),
})

export const LoadTask = Command.define('LoadTask', {
  args: { taskId: Schema.String, runId: Schema.String, path: LaunchPath },
  messages: [Message.SucceededLoadTask, Message.FailedRequest],
  execute: ref =>
    pipe(
      postJson('/api/tasks/view', ref, TaskView),
      Effect.map(view => Message.SucceededLoadTask({ view })),
      Effect.catch(requestFailed('load task')),
      Effect.provide(Http.layer),
    ),
})

export const LoadUpstream = Command.define('LoadUpstream', {
  messages: [Message.SucceededLoadUpstream, Message.FailedRequest],
  execute: pipe(
    getJson('/api/upstream', Schema.Array(UpstreamCall)),
    Effect.map(calls => Message.SucceededLoadUpstream({ calls })),
    Effect.catch(requestFailed('load upstream')),
    Effect.provide(Http.layer),
  ),
})

export const Approve = Command.define('Approve', {
  args: { taskId: Schema.String, runId: Schema.String, path: LaunchPath },
  messages: [Message.CompletedApprove, Message.FailedRequest],
  execute: ref =>
    pipe(
      postJson('/api/tasks/approve', ref, Schema.Struct({ approved: Schema.Boolean })),
      Effect.map(() => Message.CompletedApprove({ path: ref.path })),
      Effect.catch(requestFailed('approve')),
      Effect.provide(Http.layer),
    ),
})


const laneRef = (lane: Lane) => ({
  taskId: lane.launched.taskId,
  runId: lane.launched.runId,
  path: lane.launched.path,
})

const lanes = (model: Model): ReadonlyArray<Lane> => Array.getSomes([model.maybePooled, model.maybeCold])

const withView = (maybeLane: Option.Option<Lane>, view: TaskView) =>
  Option.map(maybeLane, lane =>
    lane.launched.taskId === view.taskId ? Lane.make({ ...lane, maybeView: Option.some(view) }) : lane,
  )

const withApprovalSent = (maybeLane: Option.Option<Lane>) =>
  Option.map(maybeLane, lane => Lane.make({ ...lane, approvalSent: true }))

const newLane = (launched: Launched) =>
  Option.some(Lane.make({ launched, maybeView: Option.none(), approvalSent: false }))

export const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedFill: () => ({ model, commands: [FillHangar()] }),

    ClickedRace: () => ({
      model: modifyFields(model, { isLaunching: () => true, maybeError: () => Option.none() }),
      commands: [LaunchRace()],
    }),

    ClickedApprove: ({ path }) =>
      Option.match(path === 'pooled' ? model.maybePooled : model.maybeCold, {
        onNone: () => ({ model }),
        onSome: lane => ({ model, commands: [Approve(laneRef(lane))] }),
      }),

    Ticked: () => ({
      model,
      commands: [
        LoadHangar(),
        LoadUpstream(),
        ...Option.match(model.maybeBrowser, {
          onNone: () => [],
          onSome: lane => [LoadBrowserReceipts({ ticket: lane.ticket })],
        }),
        ...pipe(
          lanes(model),
          Array.filter(lane => !isSettled(lane)),
          Array.map(lane => LoadTask(laneRef(lane))),
        ),
      ],
    }),

    SucceededLoadHangar: ({ hangar }) => ({
      model: modifyFields(model, { maybeHangar: () => Option.some(hangar) }),
    }),

    SucceededLaunch: ({ pooled, cold }) => ({
      model: modifyFields(model, {
        isLaunching: () => false,
        maybePooled: () => newLane(pooled),
        maybeCold: () => newLane(cold),
      }),
    }),

    SucceededLoadTask: ({ view }) => ({
      model: modifyFields(model, {
        maybePooled: maybeLane => withView(maybeLane, view),
        maybeCold: maybeLane => withView(maybeLane, view),
      }),
    }),

    SucceededLoadUpstream: ({ calls }) => ({
      model: modifyFields(model, { upstreamCalls: () => calls }),
    }),

    CompletedApprove: ({ path }) => ({
      model: modifyFields(model, {
        maybePooled: maybeLane => (path === 'pooled' ? withApprovalSent(maybeLane) : maybeLane),
        maybeCold: maybeLane => (path === 'cold' ? withApprovalSent(maybeLane) : maybeLane),
      }),
    }),

    FailedRequest: ({ error }) => ({
      model: modifyFields(model, { isLaunching: () => false, maybeError: () => Option.some(error) }),
    }),

    ClickedOpenBrowserBox: () => ({
      model: modifyFields(model, { isOpeningBrowser: () => true, maybeBrowser: () => Option.none() }),
      commands: [OpenBrowserBox()],
    }),

    ClickedStartBrowserTask: () =>
      Option.match(model.maybeBrowser, {
        onNone: () => ({ model }),
        onSome: lane => ({
          model: modifyFields(model, { maybeBrowser: () => Option.some(BrowserLane.make({ ...lane, promptSent: true })) }),
          commands: [SendBrowserPrompt({ taskId: lane.ticket.taskId, text: BROWSER_START_PROMPT })],
        }),
      }),

    ClickedApproveBrowserCall: ({ method, url }) =>
      Option.match(model.maybeBrowser, {
        onNone: () => ({ model }),
        onSome: lane => ({ model, commands: [ApproveBrowserCall({ taskId: lane.ticket.taskId, method, url })] }),
      }),

    OpenedBrowserBox: ({ ticket, resumed }) => ({
      model: modifyFields(model, {
        isOpeningBrowser: () => false,
        maybeBrowser: () =>
          Option.some(BrowserLane.make({ ticket, resumed, maybeState: Option.none(), receipts: [], promptSent: resumed })),
      }),
      commands: [LoadBrowserReceipts({ ticket })],
    }),

    NoSavedBrowserBox: () => ({ model }),

    UpdatedBrowserBox: ({ state }) => ({
      model: modifyFields(model, {
        maybeBrowser: maybeLane =>
          Option.map(maybeLane, lane =>
            BrowserLane.make({ ...lane, maybeState: Option.some(state), promptSent: lane.promptSent || state.lines.length > 0 }),
          ),
      }),
    }),

    LoadedBrowserReceipts: ({ receipts }) => ({
      model: modifyFields(model, {
        maybeBrowser: maybeLane => Option.map(maybeLane, lane => BrowserLane.make({ ...lane, receipts })),
      }),
    }),

    SentBrowserPrompt: () => ({ model }),

    ApprovedBrowserCall: () =>
      Option.match(model.maybeBrowser, {
        onNone: () => ({ model }),
        onSome: lane => ({ model, commands: [SendBrowserPrompt({ taskId: lane.ticket.taskId, text: BROWSER_RESUME_PROMPT })] }),
      }),

    FailedBrowserBox: ({ error }) => ({
      model: modifyFields(model, { isOpeningBrowser: () => false, maybeError: () => Option.some(error) }),
    }),
  })


export const init: Runtime.ApplicationInit<Model, Message> = () => ({
  model: {
    maybeHangar: Option.none(),
    maybePooled: Option.none(),
    maybeCold: Option.none(),
    upstreamCalls: [],
    maybeError: Option.none(),
    isLaunching: false,
    maybeBrowser: Option.none(),
    isOpeningBrowser: false,
  },
  commands: [LoadHangar(), LoadUpstream(), ResumeBrowserBox()],
})


export const subscriptions = Subscription.make<Model, Message>()(entry => ({
  poll: entry(
    { isPolling: Schema.Boolean },
    {
      modelToDependencies: () => ({ isPolling: true }),
      dependenciesToStream: () =>
        Stream.tick(Duration.millis(POLL_INTERVAL_MS)).pipe(Stream.drop(1), Stream.map(Message.Ticked)),
    },
  ),
}))


const msBetween = (from: number, to: number): string => `${Math.max(0, to - from).toLocaleString()} ms`

const DECISION_STYLE: Record<Receipt['decision'], string> = {
  allowed: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  refused: 'text-rose-300 border-rose-500/40 bg-rose-500/10',
  'awaiting-approval': 'text-amber-300 border-amber-500/40 bg-amber-500/10',
}

const DECISION_LABEL: Record<Receipt['decision'], string> = {
  allowed: 'allowed',
  refused: 'refused',
  'awaiting-approval': 'needs approval',
}

const SLOT_STYLE: Record<HangarView['slots'][number]['state'], string> = {
  ready: 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200',
  warming: 'border-sky-400/40 bg-sky-400/10 text-sky-200 animate-pulse',
  claimed: 'border-white/10 bg-white/5 text-slate-500',
}

const panel = 'rounded-2xl border border-white/10 bg-white/[0.03] p-6'

const hostAndPath = (rawUrl: string): string => {
  const url = new URL(rawUrl)
  return `${url.host}${url.pathname}`
}

const receiptRow = (receipt: Receipt, index: number, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(`${receipt.at}-${index}`, [h.Class('flex items-center gap-3 font-mono text-xs py-1.5 border-b border-white/5')], [
    h.span([h.Class(`px-2 py-0.5 rounded border w-28 text-center shrink-0 ${DECISION_STYLE[receipt.decision]}`)], [
      DECISION_LABEL[receipt.decision],
    ]),
    h.span([h.Class('text-slate-400 w-14 shrink-0')], [receipt.method]),
    h.span([h.Class('text-slate-200 truncate')], [hostAndPath(receipt.url)]),
    h.span([h.Class('ml-auto text-slate-500 shrink-0 hidden lg:inline')], [receipt.reason]),
  ])

const statLine = (label: string, value: string, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('flex justify-between text-sm')], [
    h.span([h.Class('text-slate-400')], [label]),
    h.span([h.Class('font-mono text-slate-100')], [value]),
  ])

const outputStats = (lane: Lane, view: TaskView, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  view.output === null
    ? []
    : [
        statLine('box', `${view.output.boxId} (${view.output.boxSource})`, h),
        statLine('box ready after', msBetween(lane.launched.launchedAt, view.output.boxReadyAt), h),
        statLine('finished after', msBetween(lane.launched.launchedAt, view.output.finishedAt), h),
        statLine('secrets inside the box', String(view.output.secretEnvNamesInBox.length), h),
      ]

const approveButton = (lane: Lane, h: HtmlBuilder<Message>): Html =>
  isAwaitingApproval(lane)
    ? h.button(
        [
          h.Class('self-start rounded-lg bg-amber-400 text-slate-950 font-semibold px-4 py-2 hover:bg-amber-300'),
          h.OnClick(Message.ClickedApprove({ path: lane.launched.path })),
        ],
        ['Approve: turn on the route'],
      )
    : h.empty

const laneDetail = (lane: Lane, view: TaskView, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('flex flex-col gap-4')], [
    h.div([h.Class('flex flex-col gap-1.5')], [
      statLine('run started via', lane.launched.runVia, h),
      statLine('status', view.status, h),
      ...outputStats(lane, view, h),
    ]),
    approveButton(lane, h),
    h.ul([], Array.map(view.receipts, (receipt, index) => receiptRow(receipt, index, h))),
  ])

const laneBody = (lane: Lane, h: HtmlBuilder<Message>): Html =>
  Option.match(lane.maybeView, {
    onNone: () =>
      h.p([h.Class('text-slate-400 text-sm')], [`Run dispatched in ${lane.launched.dispatchMs} ms…`]),
    onSome: view => laneDetail(lane, view, h),
  })

const laneView = (title: string, subtitle: string, maybeLane: Option.Option<Lane>, h: HtmlBuilder<Message>): Html =>
  h.section([h.Class(`${panel} flex flex-col gap-4 min-h-80`)], [
    h.div([], [
      h.h3([h.Class('text-lg font-semibold text-white')], [title]),
      h.p([h.Class('text-sm text-slate-400')], [subtitle]),
    ]),
    Option.match(maybeLane, {
      onNone: () => h.p([h.Class('text-slate-500 text-sm')], ['Press race to launch.']),
      onSome: lane => laneBody(lane, h),
    }),
  ])

const slotView = (slot: HangarView['slots'][number], h: HtmlBuilder<Message>): Html =>
  h.keyed('div')(slot.boxId, [h.Class(`rounded-xl border px-3 py-2 font-mono text-xs ${SLOT_STYLE[slot.state]}`)], [
    `${slot.boxId} · ${slot.state}`,
  ])

const hangarView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section([h.Class(`${panel} flex flex-col gap-4`)], [
    h.div([h.Class('flex items-center justify-between gap-4')], [
      h.div([], [
        h.h2([h.Class('text-lg font-semibold text-white')], ['The hangar']),
        h.p([h.Class('text-sm text-slate-400')], ['Boxes started ahead of time. No internet. No keys.']),
      ]),
      h.button(
        [
          h.Class('rounded-lg border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/10'),
          h.OnClick(Message.ClickedFill()),
        ],
        ['Fill hangar'],
      ),
    ]),
    Option.match(model.maybeHangar, {
      onNone: () => h.p([h.Class('text-slate-500 text-sm')], ['Loading…']),
      onSome: hangar =>
        h.div(
          [h.Class('flex flex-wrap gap-2')],
          pipe(
            hangar.slots,
            Array.filter(slot => slot.state !== 'claimed'),
            Array.map(slot => slotView(slot, h)),
          ),
        ),
    }),
  ])

const upstreamRow = (call: UpstreamCall, index: number, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(`${call.at}-${index}`, [h.Class('font-mono text-xs py-1 flex gap-3 border-b border-white/5')], [
    h.span([h.Class('text-slate-400 w-14')], [call.method]),
    h.span([h.Class('text-slate-200')], [call.path]),
    h.span([h.Class(`ml-auto ${call.keyAccepted ? 'text-emerald-300' : 'text-rose-300'}`)], [
      call.keyAccepted ? 'key accepted' : 'no key',
    ]),
  ])

const upstreamView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section([h.Class(`${panel} flex flex-col gap-3`)], [
    h.h2([h.Class('text-lg font-semibold text-white')], ['What the outside service saw']),
    h.p([h.Class('text-sm text-slate-400')], [
      'Only calls the referee allowed arrive here. The referee added the key outside the box.',
    ]),
    h.ul(
      [h.Class('flex flex-col')],
      pipe(model.upstreamCalls, Array.takeRight(8), Array.reverse, Array.map((call, index) => upstreamRow(call, index, h))),
    ),
  ])

const BOX_FRAME_SANDBOX = 'allow-scripts'

const transcriptRow = (line: TranscriptLine, index: number, h: HtmlBuilder<Message>): Html => {
  const key = `${index}-${line.kind}`
  switch (line.kind) {
    case 'user':
      return h.keyed('li')(key, [h.Class('text-sky-200 whitespace-pre-wrap')], [`you: ${line.text}`])
    case 'assistant':
      return h.keyed('li')(key, [h.Class('text-slate-100 whitespace-pre-wrap')], [line.text])
    case 'tool-call':
      return h.keyed('li')(key, [h.Class('font-mono text-xs text-violet-300 break-all')], [`→ ${line.name} ${line.args}`])
    case 'tool-result':
      return h.keyed('li')(
        key,
        [h.Class(`font-mono text-xs whitespace-pre-wrap break-all ${line.isError ? 'text-rose-300' : 'text-slate-400'}`)],
        [`← ${line.name}: ${line.text}`],
      )
  }
}

const browserReceiptRow = (receipt: BrowserReceipt, index: number, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(`${receipt.at}-${index}`, [h.Class('flex items-center gap-3 font-mono text-xs py-1.5 border-b border-white/5')], [
    h.span([h.Class(`px-2 py-0.5 rounded border w-28 text-center shrink-0 ${DECISION_STYLE[receipt.decision]}`)], [
      DECISION_LABEL[receipt.decision],
    ]),
    h.span([h.Class('text-slate-400 w-14 shrink-0')], [receipt.method]),
    h.span([h.Class('text-slate-200 truncate')], [receipt.url.startsWith('model:') ? 'model' : hostAndPath(receipt.url)]),
    h.span([h.Class('ml-auto text-slate-500 shrink-0 hidden lg:inline truncate max-w-xs')], [receipt.reason]),
  ])

const browserStatus = (lane: BrowserLane): string =>
  Option.match(lane.maybeState, {
    onNone: () => 'starting the harness in the tab…',
    onSome: state => (state.resumed ? `${state.status} (resumed after reload)` : state.status),
  })

const browserControls = (lane: BrowserLane, h: HtmlBuilder<Message>): Html => {
  const waiting = pendingApproval(lane)
  if (waiting !== undefined) {
    return h.button(
      [
        h.Class('self-start rounded-lg bg-amber-400 text-slate-950 font-semibold px-4 py-2 hover:bg-amber-300'),
        h.OnClick(Message.ClickedApproveBrowserCall({ method: waiting.method, url: waiting.url })),
      ],
      [`Approve: ${waiting.method} ${hostAndPath(waiting.url)}`],
    )
  }
  if (lane.promptSent || Option.isNone(lane.maybeState)) return h.empty
  return h.button(
    [
      h.Class('self-start rounded-lg bg-sky-400 text-slate-950 font-semibold px-4 py-2 hover:bg-sky-300'),
      h.OnClick(Message.ClickedStartBrowserTask()),
    ],
    ['Give the agent its task'],
  )
}

const browserBody = (lane: BrowserLane, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class('flex flex-col gap-4')], [
    h.iframe(
      [
        h.Src('/box'),
        h.Sandbox(BOX_FRAME_SANDBOX),
        h.Title('Agent harness, sandboxed'),
        h.Class('hidden'),
        h.OnMount(ConnectBrowserBox({ ticket: lane.ticket })),
      ],
      [],
    ),
    h.div([h.Class('flex flex-col gap-1.5')], [
      statLine('task', lane.ticket.taskId, h),
      statLine('status', browserStatus(lane), h),
      statLine('model (picked by the referee)', lane.ticket.model, h),
      statLine('keys inside the tab', '0', h),
      statLine(
        'files in the box',
        Option.match(lane.maybeState, { onNone: () => '–', onSome: state => state.files.join(', ') || 'none' }),
        h,
      ),
    ]),
    browserControls(lane, h),
    Option.match(Option.flatMapNullishOr(lane.maybeState, state => state.error), {
      onNone: () => h.empty,
      onSome: error => h.p([h.Class('text-rose-300 text-xs font-mono')], [error]),
    }),
    h.div([h.Class('grid lg:grid-cols-2 gap-6')], [
      h.div([h.Class('flex flex-col gap-2')], [
        h.h4([h.Class('text-sm font-semibold text-white')], ['Agent transcript']),
        h.ul(
          [h.Class('flex flex-col gap-2 text-sm max-h-[28rem] overflow-auto')],
          Option.match(lane.maybeState, {
            onNone: () => [],
            onSome: state => Array.map(state.lines, (line, index) => transcriptRow(line, index, h)),
          }),
        ),
      ]),
      h.div([h.Class('flex flex-col gap-2')], [
        h.h4([h.Class('text-sm font-semibold text-white')], ['Referee receipts']),
        h.ul([], Array.map(lane.receipts, (receipt, index) => browserReceiptRow(receipt, index, h))),
      ]),
    ]),
  ])

const browserView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section([h.Class(`${panel} flex flex-col gap-4`)], [
    h.div([h.Class('flex items-center justify-between gap-4')], [
      h.div([], [
        h.h2([h.Class('text-lg font-semibold text-white')], ['Browser box']),
        h.p([h.Class('text-sm text-slate-400 max-w-2xl')], [
          'The whole agent harness (Pi Durable, its files and a shell) runs in a sandboxed frame in this tab. The frame has no network and no keys. Model calls and API calls go through the same referee. Reload the page mid-run: the run picks up where it stopped.',
        ]),
      ]),
      h.button(
        [
          h.Class('rounded-lg border border-white/20 px-4 py-2 text-sm text-white hover:bg-white/10 disabled:opacity-50 shrink-0'),
          h.OnClick(Message.ClickedOpenBrowserBox()),
          h.Disabled(model.isOpeningBrowser),
        ],
        [Option.isSome(model.maybeBrowser) ? 'New browser box' : 'Open a browser box'],
      ),
    ]),
    Option.match(model.maybeBrowser, {
      onNone: () => h.p([h.Class('text-slate-500 text-sm')], ['No browser box yet.']),
      onSome: lane => browserBody(lane, h),
    }),
  ])

const heroView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header([h.Class('flex flex-col gap-3')], [
    h.p([h.Class('text-xs uppercase tracking-[0.3em] text-sky-300/80')], ['hangar']),
    h.h1([h.Class('text-4xl md:text-5xl font-semibold text-white max-w-3xl')], ['Give an agent a task, not your keys.']),
    h.p([h.Class('text-slate-400 max-w-2xl')], [
      'Hangar keeps locked boxes ready. A task claims one, gets a contract, and runs. Every request the box makes goes to a referee that checks the contract, adds the key, and writes a receipt.',
    ]),
    h.div([h.Class('flex gap-3 pt-2')], [
      h.button(
        [
          h.Class('rounded-lg bg-sky-400 text-slate-950 font-semibold px-5 py-2.5 hover:bg-sky-300 disabled:opacity-50'),
          h.OnClick(Message.ClickedRace()),
          h.Disabled(model.isLaunching),
        ],
        [model.isLaunching ? 'Launching…' : 'Race: ready box vs fresh box'],
      ),
    ]),
    Option.match(model.maybeError, {
      onNone: () => h.empty,
      onSome: error => h.p([h.Class('text-rose-300 text-sm font-mono')], [error]),
    }),
  ])

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Hangar',
  body: h.div([h.Class('min-h-screen bg-[#07090d] text-slate-200 px-6 py-12')], [
    h.div([h.Class('max-w-6xl mx-auto flex flex-col gap-8')], [
      heroView(model, h),
      hangarView(model, h),
      h.div([h.Class('grid md:grid-cols-2 gap-6')], [
        laneView('Ready box', 'Run from the workflow pool, box from the hangar.', model.maybePooled, h),
        laneView('Fresh box', 'Cold workflow start, box started on demand.', model.maybeCold, h),
      ]),
      browserView(model, h),
      upstreamView(model, h),
      h.footer([h.Class('text-xs text-slate-500 pt-4')], [
        'Built on cf-workflow-pool by Dillon Mulroy, with ideas from armada by Ashish Kumar. Effect v4, Foldkit, Alchemy, Cloudflare Containers, Workflows and Durable Objects. The browser box runs Pi Durable by Earendil with just-bash by Vercel Labs.',
      ]),
    ]),
  ]),
})
