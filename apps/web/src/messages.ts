import { Schema } from 'effect'
import { defineMessageUnion } from 'foldkit/message'

import {
  BrowserBoxState,
  BrowserReceipt,
  BrowserTicketSchema,
  HangarView,
  Launched,
  LaunchPath,
  TaskView,
  UpstreamCall,
} from './domain'

export const Message = defineMessageUnion({
  ClickedFill: {},
  ClickedRace: {},
  ClickedApprove: { path: LaunchPath },
  Ticked: {},
  SucceededLoadHangar: { hangar: HangarView },
  SucceededLaunch: { pooled: Launched, cold: Launched },
  SucceededLoadTask: { view: TaskView },
  SucceededLoadUpstream: { calls: Schema.Array(UpstreamCall) },
  CompletedApprove: { path: LaunchPath },
  FailedRequest: { error: Schema.String },
  ClickedOpenBrowserBox: {},
  ClickedStartBrowserTask: {},
  ClickedApproveBrowserCall: { method: Schema.String, url: Schema.String },
  OpenedBrowserBox: { ticket: BrowserTicketSchema, resumed: Schema.Boolean },
  NoSavedBrowserBox: {},
  UpdatedBrowserBox: { state: BrowserBoxState },
  LoadedBrowserReceipts: { receipts: Schema.Array(BrowserReceipt) },
  SentBrowserPrompt: {},
  ApprovedBrowserCall: {},
  FailedBrowserBox: { error: Schema.String },
})
export type Message = typeof Message.Type
