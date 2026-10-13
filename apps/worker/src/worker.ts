import * as Cloudflare from "alchemy/Cloudflare";
import * as Http from "alchemy/Http";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { HangarApi } from "./api.ts";
import { Launcher, launcherLayer, ModelSettingsService } from "./launcher.ts";
import { modelRoute } from "./model-route.ts";
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
      .handle("upstream", () => guard(launcher.upstreamCalls))
      .handle("browserOpen", () => guard(launcher.browserOpen))
      .handle("browserTool", ({ payload }) =>
        guard(launcher.browserTool(payload.taskId, payload.ticket, payload.method, payload.url)),
      )
      .handle("browserApprove", ({ payload }) =>
        guard(launcher.browserApprove(payload.taskId, payload.method, payload.url).pipe(Effect.map((approved) => ({ approved })))),
      )
      .handle("browserReceipts", ({ payload }) => guard(launcher.browserReceipts(payload.taskId, payload.ticket)));
  }),
);

const BOX_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'none'",
  "img-src 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

const BOX_PAGE_RULES = [
  `  Content-Security-Policy: ${BOX_PAGE_CSP}`,
  "  Referrer-Policy: no-referrer",
  "  X-Content-Type-Options: nosniff",
];

const PUBLIC_SCRIPT_RULES = ["  Access-Control-Allow-Origin: *", "  X-Content-Type-Options: nosniff"];

const BOX_PAGE_HEADERS = [
  "/box",
  ...BOX_PAGE_RULES,
  "/box.html",
  ...BOX_PAGE_RULES,
  "/assets/*",
  ...PUBLIC_SCRIPT_RULES,
  "",
].join("\n");

const DEFAULT_MODEL_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_MODEL = "qwen3-coder:30b";

const readModelSettings = Effect.gen(function* () {
  const baseUrl = yield* Config.String("HANGAR_MODEL_BASE_URL").pipe(Config.withDefault(DEFAULT_MODEL_BASE_URL));
  const model = yield* Config.String("HANGAR_MODEL").pipe(Config.withDefault(DEFAULT_MODEL));
  const apiKey = yield* Config.Redacted("HANGAR_MODEL_API_KEY").pipe(Config.withDefault(Redacted.make("")));
  return { baseUrl, model, apiKey: Redacted.value(apiKey) };
});

export default class HangarWorker extends Cloudflare.Worker<HangarWorker>()(
  "HangarWorker",
  {
    main: import.meta.url,
    domain: { name: "hangar.coey.dev" },
    workersDev: false,
    access: {
      name: "hangar",
      sessionDuration: "24h",
      policies: [{ decision: "allow", include: [{ email: "Coeyman@gmail.com" }] }],
    },
    assets: {
      directory: `${import.meta.dirname}/../../web/dist`,
      runWorkerFirst: ["/api/*"],
      headers: BOX_PAGE_HEADERS,
      notFoundHandling: "single-page-application",
    },
  },
  Effect.gen(function* () {
    const modelSettings = yield* readModelSettings;
    const fetch = yield* HttpRouter.toHttpEffect(
      Layer.mergeAll(HttpApiBuilder.layer(HangarApi).pipe(Layer.provide(hangarHandlers)), modelRoute).pipe(
        Layer.provide(launcherLayer),
        Layer.provide(Layer.succeed(ModelSettingsService, modelSettings)),
        Layer.provide(Http.Platform),
      ),
    );
    return { fetch };
  }).pipe(
    Effect.provide(HangarPools.layer.pipe(Layer.provide(taskPoolWorkflow))),
  ),
) {}
