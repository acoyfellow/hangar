import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type { Receipt } from "./contract.ts";

const RECEIPTS_KEY = "receipts";

export class Ledger extends Cloudflare.DurableObject<Ledger>()(
  "Ledger",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const storage = state.raw.storage;

    return Effect.succeed({
      append: (receipt: Receipt) =>
        Effect.promise(async () => {
          const existing = (await storage.get<Array<Receipt>>(RECEIPTS_KEY)) ?? [];
          await storage.put(RECEIPTS_KEY, [...existing, receipt]);
        }),
      list: () => Effect.promise(async () => (await storage.get<Array<Receipt>>(RECEIPTS_KEY)) ?? []),
    });
  }),
) {}
