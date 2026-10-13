import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { demoContract, matchGrant, type Contract, type Decision, type Receipt } from "./contract.ts";
import { Ledger } from "./ledger.ts";
import { Upstream } from "./upstream.ts";

export const BROWSER_BOX_PREFIX = "browser-";
export const MODEL_CALL_URL = "model://hangar/chat/completions";
export const MODEL_TOKEN_BUDGET = 60_000;

export interface ModelSettings {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

export interface BrowserTicket {
  readonly taskId: string;
  readonly ticket: string;
  readonly contract: Contract;
  readonly model: string;
  readonly tokenBudget: number;
}

interface TicketState {
  readonly ticket: string;
  readonly contract: Contract;
  readonly tokensUsed: number;
  readonly approved: ReadonlyArray<string>;
}

export interface ToolCallReply {
  readonly status: number;
  readonly body: string;
}

export interface ModelReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

const TICKET_KEY = "ticket";

const issueTicket = () => `hbt_${crypto.randomUUID().replaceAll("-", "")}`;

const receiptFor = (taskId: string, method: string, url: string, decision: Decision, reason: string): Receipt => ({
  at: Date.now(),
  taskId,
  method,
  url,
  decision,
  reason,
  upstreamStatus: null,
});

const usedTokens = (body: string): number => {
  for (const line of body.split("\n")) {
    const data = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
    if (!data.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(data) as { usage?: { total_tokens?: number } };
      if (parsed.usage?.total_tokens !== undefined) return parsed.usage.total_tokens;
    } catch {
      continue;
    }
  }
  return 0;
};

export class BrowserBox extends Cloudflare.DurableObject<BrowserBox>()(
  "BrowserBox",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const ledgers = yield* Ledger;
    const upstreams = yield* Upstream;
    const storage = state.raw.storage;

    return Effect.gen(function* () {
      const upstream = upstreams.getByName("demo");
      const current = Effect.promise(() => storage.get<TicketState>(TICKET_KEY));
      const save = (next: TicketState) => Effect.promise(() => storage.put(TICKET_KEY, next));
      const record = (receipt: Receipt) => ledgers.getByName(receipt.taskId).append(receipt);

      const authorized = (taskId: string, ticket: string) =>
        Effect.map(current, (held) => (held !== undefined && held.ticket === ticket ? held : undefined));

      return {
        open: (taskId: string, model: string) =>
          Effect.gen(function* () {
            const contract = demoContract(taskId);
            const ticket = issueTicket();
            yield* save({ ticket, contract, tokensUsed: 0, approved: [] });
            const opened: BrowserTicket = { taskId, ticket, contract, model, tokenBudget: MODEL_TOKEN_BUDGET };
            return opened;
          }),

        approve: (method: string, url: string) =>
          Effect.gen(function* () {
            const held = yield* current;
            if (held === undefined) return false;
            yield* save({ ...held, approved: [...held.approved, `${method} ${url}`] });
            return true;
          }),

        callTool: (taskId: string, ticket: string, method: string, rawUrl: string) =>
          Effect.gen(function* () {
            const held = yield* authorized(taskId, ticket);
            if (held === undefined) {
              return { status: 401, body: JSON.stringify({ refused: true, reason: "bad ticket" }) } as ToolCallReply;
            }
            const url = new URL(rawUrl);
            const grant = matchGrant(held.contract, method, url);
            if (grant === undefined) {
              yield* record(receiptFor(taskId, method, rawUrl, "refused", "not in the contract"));
              return { status: 403, body: JSON.stringify({ refused: true, reason: "not in the contract" }) } as ToolCallReply;
            }
            if (grant.needsApproval && !held.approved.includes(`${method} ${rawUrl}`)) {
              yield* record(receiptFor(taskId, method, rawUrl, "awaiting-approval", "grant needs a human approval"));
              return {
                status: 409,
                body: JSON.stringify({ refused: true, reason: "waiting for a human to approve this call; try again after approval" }),
              } as ToolCallReply;
            }
            const key = yield* upstream.keyForReferee();
            const reply = yield* upstream.handle(method, url.pathname, `Bearer ${key}`);
            yield* record({
              ...receiptFor(taskId, method, rawUrl, "allowed", `grant ${grant.method} ${grant.pathPrefix}`),
              upstreamStatus: reply.status,
            });
            return reply as ToolCallReply;
          }),

        callModel: (taskId: string, ticket: string, requestBody: string, settings: ModelSettings) =>
          Effect.gen(function* () {
            const held = yield* authorized(taskId, ticket);
            const refusedReply = (status: number, error: string): ModelReply => ({
              status,
              contentType: "application/json",
              body: JSON.stringify({ error }),
            });
            if (held === undefined) return refusedReply(401, "bad ticket");
            if (held.tokensUsed >= MODEL_TOKEN_BUDGET) {
              yield* record(receiptFor(taskId, "POST", MODEL_CALL_URL, "refused", "token budget spent"));
              return refusedReply(429, "token budget spent");
            }
            const request = JSON.parse(requestBody) as Record<string, unknown>;
            const pinned = JSON.stringify({ ...request, model: settings.model });
            const response = yield* Effect.promise(() =>
              fetch(`${settings.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  ...(settings.apiKey === "" ? {} : { authorization: `Bearer ${settings.apiKey}` }),
                },
                body: pinned,
              }),
            );
            const body = yield* Effect.promise(() => response.text());
            const tokens = usedTokens(body);
            yield* save({ ...held, tokensUsed: held.tokensUsed + tokens });
            yield* record({
              ...receiptFor(
                taskId,
                "POST",
                MODEL_CALL_URL,
                "allowed",
                `model ${settings.model}, ${tokens} tokens, ${held.tokensUsed + tokens}/${MODEL_TOKEN_BUDGET} used`,
              ),
              upstreamStatus: response.status,
            });
            const reply: ModelReply = {
              status: response.status,
              contentType: response.headers.get("content-type") ?? "application/json",
              body,
            };
            return reply;
          }),

        receipts: (taskId: string, ticket: string) =>
          Effect.gen(function* () {
            const held = yield* authorized(taskId, ticket);
            if (held === undefined) return [] as ReadonlyArray<Receipt>;
            return yield* ledgers.getByName(taskId).list();
          }),
      };
    });
  }),
) {}
