import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  type Contract,
  type Decision,
  matchGrant,
  type Receipt,
  type Step,
  StepOutcome,
} from "./contract.ts";
import { Ledger } from "./ledger.ts";
import { Upstream } from "./upstream.ts";

export class BoxContainer extends Cloudflare.Container<BoxContainer>()("BoxContainer", {
  context: `${import.meta.dirname}/../box`,
}) {}

const BoxRunResult = Schema.Struct({
  results: Schema.Array(StepOutcome),
  secretEnvNames: Schema.Array(Schema.String),
});
const decodeBoxRunResult = Schema.decodeUnknownEffect(Schema.fromJsonString(BoxRunResult));

const CONTRACT_KEY = "contract";
const APPROVED_KEY = "approved";

const refusal = (status: number, reason: string) =>
  HttpServerResponse.text(JSON.stringify({ refused: true, reason }), {
    status,
    contentType: "application/json",
  });

export class Box extends Cloudflare.DurableObject<Box>()(
  "Box",
  Effect.gen(function* () {
    const container = yield* BoxContainer;
    const state = yield* Cloudflare.DurableObjectState;
    const env = yield* Cloudflare.WorkerEnvironment;
    const upstreams = yield* Upstream;
    const ledgers = yield* Ledger;
    const storage = state.raw.storage;

    return Effect.gen(function* () {
      const self = Cloudflare.fromCloudflareFetcher(env.Box.get(state.id));
      const { fetch } = yield* container.getTcpPort(8080);
      const upstream = upstreams.getByName("demo");

      const contract = Effect.promise(() => storage.get<Contract>(CONTRACT_KEY));
      const approvedUrls = Effect.promise(async () => (await storage.get<Array<string>>(APPROVED_KEY)) ?? []);
      const record = (receipt: Receipt) => ledgers.getByName(receipt.taskId).append(receipt);

      const decide = (method: string, rawUrl: string) =>
        Effect.gen(function* () {
          const current = yield* contract;
          const url = new URL(rawUrl);
          const taskId = current?.taskId ?? "unassigned";
          const receiptFor = (decision: Decision, reason: string): Receipt => ({
            at: Date.now(),
            taskId,
            method,
            url: rawUrl,
            decision,
            reason,
            upstreamStatus: null,
          });
          if (!current) return { receipt: receiptFor("refused", "box has no task"), forward: false };
          const grant = matchGrant(current, method, url);
          if (!grant) return { receipt: receiptFor("refused", "not in the contract"), forward: false };
          const approved = yield* approvedUrls;
          if (grant.needsApproval && !approved.includes(`${method} ${rawUrl}`)) {
            return { receipt: receiptFor("awaiting-approval", "grant needs a human approval"), forward: false };
          }
          return { receipt: receiptFor("allowed", `grant ${grant.method} ${grant.pathPrefix}`), forward: true };
        });

      const referee = Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const rawUrl = `http://${request.headers.host}${request.url}`;
        const { receipt, forward } = yield* decide(request.method, rawUrl);
        if (!forward) {
          yield* record(receipt);
          return refusal(receipt.decision === "awaiting-approval" ? 409 : 403, receipt.reason);
        }
        const key = yield* upstream.keyForReferee();
        const reply = yield* upstream.handle(request.method, new URL(rawUrl).pathname, `Bearer ${key}`);
        yield* record({ ...receipt, upstreamStatus: reply.status });
        return HttpServerResponse.text(reply.body, { status: reply.status, contentType: "application/json" });
      });

      const runInBox = (steps: ReadonlyArray<Step>) =>
        Effect.gen(function* () {
          const response = yield* fetch(
            HttpClientRequest.post("http://box/run").pipe(
              HttpClientRequest.bodyJsonUnsafe({ calls: steps }),
            ),
          );
          const decoded = yield* decodeBoxRunResult(yield* response.text);
          return {
            results: decoded.results.map((outcome) => ({ ...outcome })),
            secretEnvNames: [...decoded.secretEnvNames],
          };
        });

      return {
        fetch: referee,
        warm: () => container.interceptAllOutboundHttp(self).pipe(Effect.andThen(runInBox([])), Effect.orDie),
        assign: (next: Contract) =>
          Effect.promise(async () => {
            await storage.put(CONTRACT_KEY, next);
            await storage.put(APPROVED_KEY, []);
          }),
        approve: (method: string, url: string) =>
          Effect.promise(async () => {
            const existing = (await storage.get<Array<string>>(APPROVED_KEY)) ?? [];
            await storage.put(APPROVED_KEY, [...existing, `${method} ${url}`]);
          }),
        run: (steps: ReadonlyArray<Step>) =>
          container.interceptAllOutboundHttp(self).pipe(Effect.andThen(runInBox(steps)), Effect.orDie),
        retire: () => container.destroy().pipe(Effect.andThen(Effect.promise(() => storage.deleteAll()))),
      };
    });
  }).pipe(Effect.provide(Cloudflare.Containers.layer(BoxContainer, { enableInternet: false }))),
) {}
