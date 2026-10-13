import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Launcher } from "./launcher.ts";

export const MODEL_ROUTE = "/api/browser/model/:taskId/:ticket/chat/completions";

const ModelRouteParams = Schema.Struct({ taskId: Schema.String, ticket: Schema.String });

const failed = (cause: unknown) =>
  HttpServerResponse.text(JSON.stringify({ error: String(cause) }), { status: 502, contentType: "application/json" });

export const modelRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const launcher = yield* Launcher;
    yield* router.add(
      "POST",
      MODEL_ROUTE,
      Effect.gen(function* () {
        const { taskId, ticket } = yield* HttpRouter.schemaPathParams(ModelRouteParams);
        const request = yield* HttpServerRequest;
        const body = yield* request.text;
        const reply = yield* launcher.browserModel(taskId, ticket, body);
        return HttpServerResponse.text(reply.body, { status: reply.status, contentType: reply.contentType });
      }).pipe(Effect.catchCause((cause) => Effect.succeed(failed(cause)))),
    );
  }),
);
