import { Schema } from "effect";

export const UPSTREAM_HOST = "api.hangar.test";

export const Grant = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "DELETE"]),
  host: Schema.String,
  pathPrefix: Schema.String,
  needsApproval: Schema.Boolean,
});
export type Grant = typeof Grant.Type;

export const Contract = Schema.Struct({
  taskId: Schema.String,
  goal: Schema.String,
  grants: Schema.Array(Grant),
});
export type Contract = typeof Contract.Type;

export const Step = Schema.Struct({
  method: Schema.Literals(["GET", "POST", "DELETE"]),
  url: Schema.String,
});
export type Step = typeof Step.Type;

export const BoxSource = Schema.Literals(["ready", "fresh"]);
export type BoxSource = typeof BoxSource.Type;

export const TaskInput = Schema.Struct({
  contract: Contract,
  boxSource: BoxSource,
  steps: Schema.Array(Step),
  launchedAt: Schema.Number,
});
export type TaskInput = typeof TaskInput.Type;

export const Decision = Schema.Literals(["allowed", "refused", "awaiting-approval"]);
export type Decision = typeof Decision.Type;

export const Receipt = Schema.Struct({
  at: Schema.Number,
  taskId: Schema.String,
  method: Schema.String,
  url: Schema.String,
  decision: Decision,
  reason: Schema.String,
  upstreamStatus: Schema.NullOr(Schema.Number),
});
export type Receipt = typeof Receipt.Type;

export const StepOutcome = Schema.Struct({
  method: Schema.String,
  url: Schema.String,
  status: Schema.Number,
  body: Schema.String,
});
export type StepOutcome = typeof StepOutcome.Type;

export const TaskOutput = Schema.Struct({
  taskId: Schema.String,
  boxId: Schema.String,
  boxSource: BoxSource,
  boxReadyAt: Schema.Number,
  firstStepAt: Schema.Number,
  finishedAt: Schema.Number,
  outcomes: Schema.Array(StepOutcome),
  secretEnvNamesInBox: Schema.Array(Schema.String),
});
export type TaskOutput = typeof TaskOutput.Type;

export const matchGrant = (contract: Contract, method: string, url: URL): Grant | undefined =>
  contract.grants.find(
    (grant) => grant.method === method && grant.host === url.host && url.pathname.startsWith(grant.pathPrefix),
  );

export const demoContract = (taskId: string): Contract => ({
  taskId,
  goal: "Deploy the hello Worker and turn on its URL. Touch nothing else.",
  grants: [
    { method: "GET", host: UPSTREAM_HOST, pathPrefix: "/v1/workers/hello", needsApproval: false },
    { method: "POST", host: UPSTREAM_HOST, pathPrefix: "/v1/workers/hello/deploy", needsApproval: false },
    { method: "POST", host: UPSTREAM_HOST, pathPrefix: "/v1/workers/hello/route", needsApproval: true },
  ],
});

export const demoSteps: ReadonlyArray<Step> = [
  { method: "GET", url: `http://${UPSTREAM_HOST}/v1/workers/hello` },
  { method: "POST", url: `http://${UPSTREAM_HOST}/v1/workers/hello/deploy` },
  { method: "DELETE", url: `http://${UPSTREAM_HOST}/v1/workers/billing` },
  { method: "GET", url: "http://example.com/exfiltrate" },
  { method: "POST", url: `http://${UPSTREAM_HOST}/v1/workers/hello/route` },
];
