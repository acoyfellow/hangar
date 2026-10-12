import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export interface UpstreamCall {
  readonly at: number;
  readonly method: string;
  readonly path: string;
  readonly keyAccepted: boolean;
}

export interface UpstreamReply {
  readonly status: number;
  readonly body: string;
}

const KEY_STORAGE = "key";
const CALLS_STORAGE = "calls";

const issueKey = () => `hgr_${crypto.randomUUID().replaceAll("-", "")}`;

export class Upstream extends Cloudflare.DurableObject<Upstream>()(
  "Upstream",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const storage = state.raw.storage;

    const key = Effect.promise(async () => {
      const existing = await storage.get<string>(KEY_STORAGE);
      if (existing) return existing;
      const created = issueKey();
      await storage.put(KEY_STORAGE, created);
      return created;
    });

    const calls = Effect.promise(async () => (await storage.get<Array<UpstreamCall>>(CALLS_STORAGE)) ?? []);

    const record = (call: UpstreamCall) =>
      Effect.promise(async () => {
        const existing = (await storage.get<Array<UpstreamCall>>(CALLS_STORAGE)) ?? [];
        await storage.put(CALLS_STORAGE, [...existing, call].slice(-200));
      });

    return Effect.succeed({
      keyForReferee: () => key,
      calls: () => calls,
      handle: (method: string, path: string, authorization: string | null) =>
        Effect.gen(function* () {
          const expected = yield* key;
          const keyAccepted = authorization === `Bearer ${expected}`;
          yield* record({ at: Date.now(), method, path, keyAccepted });
          const reply: UpstreamReply = keyAccepted
            ? { status: 200, body: JSON.stringify({ ok: true, method, path }) }
            : { status: 401, body: JSON.stringify({ ok: false, error: "missing or wrong key" }) };
          return reply;
        }),
    });
  }),
) {}
