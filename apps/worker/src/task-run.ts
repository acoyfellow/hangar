import { WorkflowPool, WorkflowPoolRegistry } from "@cf-workflow-pool/wf-pool";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { Box } from "./box.ts";
import { type Step, type StepOutcome, TaskInput, TaskOutput } from "./contract.ts";
import { Hangar } from "./hangar.ts";

export const APPROVAL_EVENT = "approval";
export const COLD_BOX_PREFIX = "cold-";

export class TaskPool extends WorkflowPool<TaskPool>()("TaskPool", {
  input: TaskInput,
  output: TaskOutput,
  poolSize: 4,
  replenishAtSize: 2,
  warmedTimeout: "50 seconds",
}) {}

export class TaskWorkflow extends Cloudflare.Workflow<TaskWorkflow>()(
  "TaskWorkflow",
  Effect.gen(function* () {
    const hangars = yield* Hangar;
    const boxes = yield* Box;
    return runTask(hangars, boxes);
  }),
) {}

export const taskPoolWorkflow = TaskPool.make(
  Effect.gen(function* () {
    const hangars = yield* Hangar;
    const boxes = yield* Box;
    return runTask(hangars, boxes);
  }),
);

export class HangarPools extends WorkflowPoolRegistry<HangarPools>()("HangarPools", { task: TaskPool }) {}

const plainFailure = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) => Effect.die(new Error(`${label}: ${Cause.pretty(cause).slice(0, 800)}`))),
  );

const awaitingApproval = (outcome: StepOutcome) => outcome.status === 409;

type HangarStubs = Effect.Success<typeof Hangar>;
type BoxStubs = Effect.Success<typeof Box>;

const runTask =
  (hangars: HangarStubs, boxes: BoxStubs) =>
  (input: TaskInput) =>
    Effect.gen(function* () {
      const { contract } = input;
      const hangar = hangars.getByName("main");

      const claimed = yield* Cloudflare.Workflows.task(
        "claim-box",
        plainFailure(
          "claim-box",
          Effect.gen(function* () {
            const firstStepAt = Date.now();
            const claim = input.boxSource === "ready" ? yield* hangar.claim(contract.taskId) : { boxId: null };
            const boxId = claim.boxId ?? `${COLD_BOX_PREFIX}${contract.taskId}`;
            const box = boxes.getByName(boxId);
            if (claim.boxId === null) yield* box.warm();
            yield* box.assign(contract);
            return { boxId, boxSource: claim.boxId === null ? ("fresh" as const) : ("ready" as const), firstStepAt, boxReadyAt: Date.now() };
          }),
        ),
      );
      const box = boxes.getByName(claimed.boxId);

      const first = yield* Cloudflare.Workflows.task("run-steps", plainFailure("run-steps", box.run(input.steps)));
      const pending: ReadonlyArray<Step> = input.steps.filter((_, index) => {
        const outcome = first.results[index];
        return outcome !== undefined && awaitingApproval(outcome);
      });

      let outcomes: ReadonlyArray<StepOutcome> = first.results;
      if (pending.length > 0) {
        yield* Cloudflare.Workflows.waitForEvent(APPROVAL_EVENT, { type: APPROVAL_EVENT, timeout: "10 minutes" });
        const approved = yield* Cloudflare.Workflows.task(
          "run-approved",
          plainFailure(
            "run-approved",
            Effect.gen(function* () {
              yield* Effect.forEach(pending, (step) => box.approve(step.method, step.url), { discard: true });
              return yield* box.run(pending);
            }),
          ),
        );
        let next = 0;
        outcomes = first.results.map((outcome) => (awaitingApproval(outcome) ? (approved.results[next++] ?? outcome) : outcome));
      }

      yield* Cloudflare.Workflows.task(
        "retire-box",
        plainFailure(
          "retire-box",
          Effect.gen(function* () {
            yield* box.retire();
            if (claimed.boxSource === "ready") yield* hangar.release(claimed.boxId);
            return true;
          }),
        ),
      );

      return {
        taskId: contract.taskId,
        boxId: claimed.boxId,
        boxSource: claimed.boxSource,
        boxReadyAt: claimed.boxReadyAt,
        firstStepAt: claimed.firstStepAt,
        finishedAt: Date.now(),
        outcomes,
        secretEnvNamesInBox: first.secretEnvNames,
      };
    });
