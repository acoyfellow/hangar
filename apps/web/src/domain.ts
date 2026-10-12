import { Schema } from 'effect'

export const LaunchPath = Schema.Literals(['pooled', 'cold'])
export type LaunchPath = typeof LaunchPath.Type

export const BoxSlot = Schema.Struct({
  boxId: Schema.String,
  state: Schema.Literals(['warming', 'ready', 'claimed']),
  taskId: Schema.NullOr(Schema.String),
  readyAt: Schema.NullOr(Schema.Number),
})
export type BoxSlot = typeof BoxSlot.Type

export const HangarView = Schema.Struct({
  slots: Schema.Array(BoxSlot),
  readyCount: Schema.Number,
})
export type HangarView = typeof HangarView.Type

export const Launched = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.String,
  path: LaunchPath,
  runVia: Schema.String,
  launchedAt: Schema.Number,
  dispatchMs: Schema.Number,
})
export type Launched = typeof Launched.Type

export const Receipt = Schema.Struct({
  at: Schema.Number,
  taskId: Schema.String,
  method: Schema.String,
  url: Schema.String,
  decision: Schema.Literals(['allowed', 'refused', 'awaiting-approval']),
  reason: Schema.String,
  upstreamStatus: Schema.NullOr(Schema.Number),
})
export type Receipt = typeof Receipt.Type

export const TaskOutput = Schema.Struct({
  taskId: Schema.String,
  boxId: Schema.String,
  boxSource: Schema.Literals(['ready', 'fresh']),
  boxReadyAt: Schema.Number,
  firstStepAt: Schema.Number,
  finishedAt: Schema.Number,
  secretEnvNamesInBox: Schema.Array(Schema.String),
})
export type TaskOutput = typeof TaskOutput.Type

export const TaskView = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.String,
  path: LaunchPath,
  status: Schema.String,
  output: Schema.NullOr(TaskOutput),
  error: Schema.NullOr(Schema.String),
  receipts: Schema.Array(Receipt),
})
export type TaskView = typeof TaskView.Type

export const UpstreamCall = Schema.Struct({
  at: Schema.Number,
  method: Schema.String,
  path: Schema.String,
  keyAccepted: Schema.Boolean,
})
export type UpstreamCall = typeof UpstreamCall.Type

export const Lane = Schema.Struct({
  launched: Launched,
  maybeView: Schema.Option(TaskView),
  approvalSent: Schema.Boolean,
})
export type Lane = typeof Lane.Type

export const isAwaitingApproval = (lane: Lane): boolean =>
  !lane.approvalSent &&
  lane.maybeView._tag === 'Some' &&
  lane.maybeView.value.receipts.some(receipt => receipt.decision === 'awaiting-approval')

export const isSettled = (lane: Lane): boolean =>
  lane.maybeView._tag === 'Some' &&
  ['complete', 'errored', 'terminated'].includes(lane.maybeView.value.status)
