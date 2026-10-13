import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { demoContract, demoSteps, type Receipt, type TaskOutput } from "./contract.ts";
import { BROWSER_BOX_PREFIX, BrowserBox, type BrowserTicket, type ModelReply, type ModelSettings, type ToolCallReply } from "./browser-box.ts";
import { Hangar, type HangarView } from "./hangar.ts";
import { Ledger } from "./ledger.ts";
import { APPROVAL_EVENT, HangarPools, TaskWorkflow } from "./task-run.ts";
import { Upstream, type UpstreamCall } from "./upstream.ts";

export type LaunchPath = "pooled" | "cold";

export interface Launched {
  readonly taskId: string;
  readonly runId: string;
  readonly path: LaunchPath;
  readonly runVia: string;
  readonly launchedAt: number;
  readonly dispatchMs: number;
}

export interface TaskView {
  readonly taskId: string;
  readonly runId: string;
  readonly path: LaunchPath;
  readonly status: string;
  readonly output: TaskOutput | null;
  readonly error: string | null;
  readonly receipts: ReadonlyArray<Receipt>;
}

export interface ILauncher {
  readonly fill: Effect.Effect<HangarView>;
  readonly view: Effect.Effect<HangarView>;
  readonly launch: (path: LaunchPath) => Effect.Effect<Launched, unknown>;
  readonly approve: (runId: string, path: LaunchPath) => Effect.Effect<void, unknown>;
  readonly task: (taskId: string, runId: string, path: LaunchPath) => Effect.Effect<TaskView, unknown>;
  readonly upstreamCalls: Effect.Effect<ReadonlyArray<UpstreamCall>>;
  readonly browserOpen: Effect.Effect<BrowserTicket, unknown>;
  readonly browserTool: (taskId: string, ticket: string, method: string, url: string) => Effect.Effect<ToolCallReply, unknown>;
  readonly browserModel: (taskId: string, ticket: string, body: string) => Effect.Effect<ModelReply, unknown>;
  readonly browserApprove: (taskId: string, method: string, url: string) => Effect.Effect<boolean, unknown>;
  readonly browserReceipts: (taskId: string, ticket: string) => Effect.Effect<ReadonlyArray<Receipt>, unknown>;
}

export class ModelSettingsService extends Context.Service<ModelSettingsService, ModelSettings>()(
  "hangar/ModelSettings",
) {}

export class Launcher extends Context.Service<Launcher, ILauncher>()("hangar/Launcher") {}

export const launcherLayer = Layer.effect(
  Launcher,
  Effect.gen(function* () {
    const pools = yield* HangarPools;
    const taskWorkflow = yield* TaskWorkflow;
    const hangars = yield* Hangar;
    const ledgers = yield* Ledger;
    const upstreams = yield* Upstream;
    const browserBoxes = yield* BrowserBox;
    const modelSettings = yield* ModelSettingsService;
    const hangar = () => hangars.getByName("main");
    const browserBox = (taskId: string) => browserBoxes.getByName(taskId);

    const launch = (path: LaunchPath) =>
      Effect.gen(function* () {
        const taskId = `t-${crypto.randomUUID().slice(0, 8)}`;
        const launchedAt = Date.now();
        const input = {
          contract: demoContract(taskId),
          boxSource: path === "pooled" ? ("ready" as const) : ("fresh" as const),
          steps: demoSteps,
          launchedAt,
        };
        if (path === "pooled") {
          const dispatched = yield* pools.task.dispatch(input, { idempotencyKey: taskId });
          return { taskId, runId: dispatched.runId, path, runVia: dispatched.via, launchedAt, dispatchMs: Date.now() - launchedAt };
        }
        const instance = yield* taskWorkflow.create({ id: taskId, params: input });
        return { taskId, runId: instance.id, path, runVia: "cold", launchedAt, dispatchMs: Date.now() - launchedAt };
      });

    const runStatus = (runId: string, path: LaunchPath) =>
      Effect.gen(function* () {
        if (path === "pooled") {
          const status = yield* pools.task.status(runId);
          if (status._tag === "Errored") yield* Effect.logError("task run errored", status.error);
          return {
            status: status._tag.toLowerCase(),
            output: status._tag === "Complete" ? (status.output as TaskOutput) : null,
            error: status._tag === "Errored" ? JSON.stringify(status.error) : null,
          };
        }
        const instance = yield* taskWorkflow.get(runId);
        const status = yield* instance.status();
        return {
          status: status.status,
          output: (status.output as TaskOutput | undefined) ?? null,
          error: status.error ? JSON.stringify(status.error) : null,
        };
      });

    return Launcher.of({
      fill: Effect.suspend(() => hangar().fill()),
      view: Effect.suspend(() => hangar().view()),
      launch,
      approve: (runId, path) =>
        path === "pooled"
          ? pools.task.sendEvent(runId, { type: APPROVAL_EVENT, payload: { approvedAt: Date.now() } })
          : Effect.flatMap(taskWorkflow.get(runId), (instance) =>
              instance.sendEvent({ type: APPROVAL_EVENT, payload: { approvedAt: Date.now() } }),
            ),
      task: (taskId, runId, path) =>
        Effect.gen(function* () {
          const { status, output, error } = yield* runStatus(runId, path);
          const receipts = yield* ledgers.getByName(taskId).list();
          return { taskId, runId, path, status, output, error, receipts };
        }),
      upstreamCalls: Effect.suspend(() => upstreams.getByName("demo").calls()),
      browserOpen: Effect.suspend(() => {
        const taskId = `${BROWSER_BOX_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
        return browserBox(taskId).open(taskId, modelSettings.model);
      }),
      browserTool: (taskId, ticket, method, url) =>
        Effect.suspend(() => browserBox(taskId).callTool(taskId, ticket, method, url)),
      browserModel: (taskId, ticket, body) =>
        Effect.suspend(() => browserBox(taskId).callModel(taskId, ticket, body, modelSettings)),
      browserApprove: (taskId, method, url) => Effect.suspend(() => browserBox(taskId).approve(method, url)),
      browserReceipts: (taskId, ticket) => Effect.suspend(() => browserBox(taskId).receipts(taskId, ticket)),
    });
  }),
);
