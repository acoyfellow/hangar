import * as Cloudflare from "alchemy/Cloudflare";
import * as Http from "alchemy/Http";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HangarApi } from "./api.ts";
import { Launcher, launcherLayer } from "./launcher.ts";
import { HangarPools, taskPoolWorkflow } from "./task-run.ts";

const failure = (cause: unknown) => ({ message: cause instanceof Error ? cause.message : String(cause) });

const hangarHandlers = HttpApiBuilder.group(HangarApi, "hangar", (handlers) =>
  Effect.gen(function* () {
    const launcher = yield* Launcher;
    const guard = <A>(effect: Effect.Effect<A, unknown>) => effect.pipe(Effect.mapError(failure));

    return handlers
      .handle("view", () => guard(launcher.view))
      .handle("fill", () => guard(launcher.fill))
      .handle("launch", ({ payload }) => guard(launcher.launch(payload.path)))
      .handle("task", ({ payload }) => guard(launcher.task(payload.taskId, payload.runId, payload.path)))
      .handle("approve", ({ payload }) =>
        guard(launcher.approve(payload.runId, payload.path).pipe(Effect.as({ approved: true }))),
      )
      .handle("upstream", () => guard(launcher.upstreamCalls));
  }),
);

export default class HangarWorker extends Cloudflare.Worker<HangarWorker>()(
  "HangarWorker",
  {
    main: import.meta.url,
    assets: {
      directory: `${import.meta.dirname}/../../web/dist`,
      runWorkerFirst: ["/api/*"],
      notFoundHandling: "single-page-application",
    },
  },
  Effect.gen(function* () {
    const fetch = yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(HangarApi).pipe(
        Layer.provide(hangarHandlers),
        Layer.provide(launcherLayer),
        Layer.provide(Http.Platform),
      ),
    );
    return { fetch };
  }).pipe(
    Effect.provide(HangarPools.layer.pipe(Layer.provide(taskPoolWorkflow))),
  ),
) {}
