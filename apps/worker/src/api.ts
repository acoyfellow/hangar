import * as Schema from "effect/Schema";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { Receipt, TaskOutput } from "./contract.ts";

export const LaunchPath = Schema.Literals(["pooled", "cold"]);

export const BoxSlot = Schema.Struct({
  boxId: Schema.String,
  state: Schema.Literals(["warming", "ready", "claimed"]),
  taskId: Schema.NullOr(Schema.String),
  readyAt: Schema.NullOr(Schema.Number),
});

export const HangarView = Schema.Struct({
  slots: Schema.Array(BoxSlot),
  readyCount: Schema.Number,
});

export const Launched = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.String,
  path: LaunchPath,
  runVia: Schema.String,
  launchedAt: Schema.Number,
  dispatchMs: Schema.Number,
});

export const TaskView = Schema.Struct({
  taskId: Schema.String,
  runId: Schema.String,
  path: LaunchPath,
  status: Schema.String,
  output: Schema.NullOr(TaskOutput),
  error: Schema.NullOr(Schema.String),
  receipts: Schema.Array(Receipt),
});

export const UpstreamCall = Schema.Struct({
  at: Schema.Number,
  method: Schema.String,
  path: Schema.String,
  keyAccepted: Schema.Boolean,
});

export const HangarFailure = Schema.Struct({ message: Schema.String });

const TaskRef = Schema.Struct({ taskId: Schema.String, runId: Schema.String, path: LaunchPath });

export const HangarApi = HttpApi.make("HangarApi").add(
  HttpApiGroup.make("hangar")
    .add(HttpApiEndpoint.get("view", "/api/hangar", { success: HangarView, error: HangarFailure }))
    .add(HttpApiEndpoint.post("fill", "/api/hangar/fill", { success: HangarView, error: HangarFailure }))
    .add(
      HttpApiEndpoint.post("launch", "/api/tasks", {
        payload: Schema.Struct({ path: LaunchPath }),
        success: Launched,
        error: HangarFailure,
      }),
    )
    .add(
      HttpApiEndpoint.post("task", "/api/tasks/view", {
        payload: TaskRef,
        success: TaskView,
        error: HangarFailure,
      }),
    )
    .add(
      HttpApiEndpoint.post("approve", "/api/tasks/approve", {
        payload: TaskRef,
        success: Schema.Struct({ approved: Schema.Boolean }),
        error: HangarFailure,
      }),
    )
    .add(
      HttpApiEndpoint.get("upstream", "/api/upstream", {
        success: Schema.Array(UpstreamCall),
        error: HangarFailure,
      }),
    ),
);
