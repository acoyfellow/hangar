import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { Box } from "./box.ts";

export const BOX_POOL_SIZE = 3;

export interface BoxSlot {
  readonly boxId: string;
  readonly state: "warming" | "ready" | "claimed";
  readonly taskId: string | null;
  readonly readyAt: number | null;
}

export interface HangarView {
  readonly slots: ReadonlyArray<BoxSlot>;
  readonly readyCount: number;
}

const SLOTS_KEY = "slots";

export class Hangar extends Cloudflare.DurableObject<Hangar>()(
  "Hangar",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const boxes = yield* Box;
    const storage = state.raw.storage;

    return Effect.gen(function* () {
      const runtimeContext = yield* Effect.context<Alchemy.RuntimeContext>();
      const slots = Effect.promise(async () => (await storage.get<Array<BoxSlot>>(SLOTS_KEY)) ?? []);
      const save = (next: ReadonlyArray<BoxSlot>) => Effect.promise(() => storage.put(SLOTS_KEY, next));

      const update = (boxId: string, change: (slot: BoxSlot) => BoxSlot) =>
        Effect.gen(function* () {
          const current = yield* slots;
          yield* save(current.map((slot) => (slot.boxId === boxId ? change(slot) : slot)));
        });

      const warmOne = (boxId: string) =>
        boxes
          .getByName(boxId)
          .warm()
          .pipe(
            Effect.andThen(update(boxId, (slot) => ({ ...slot, state: "ready", readyAt: Date.now() }))),
            Effect.catchCause((cause) =>
              Effect.logWarning(`box ${boxId} did not warm`, cause).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    const current = yield* slots;
                    yield* save(current.filter((slot) => slot.boxId !== boxId));
                  }),
                ),
              ),
            ),
          );

      const refill = Effect.gen(function* () {
        const current = yield* slots;
        const open = current.filter((slot) => slot.state !== "claimed").length;
        const missing = Math.max(0, BOX_POOL_SIZE - open);
        const added: Array<BoxSlot> = Array.from({ length: missing }, () => ({
          boxId: `box-${crypto.randomUUID().slice(0, 8)}`,
          state: "warming",
          taskId: null,
          readyAt: null,
        }));
        if (added.length === 0) return;
        yield* save([...current, ...added]);
        yield* Effect.forEach(added, (slot) => warmOne(slot.boxId), { concurrency: "unbounded", discard: true });
      });

      const view = Effect.map(slots, (current): HangarView => ({
        slots: current,
        readyCount: current.filter((slot) => slot.state === "ready").length,
      }));

      return {
        view: () => view.pipe(Effect.provideContext(runtimeContext)),
        fill: () => refill.pipe(Effect.andThen(view), Effect.provideContext(runtimeContext)),
        claim: (taskId: string) =>
          Effect.gen(function* () {
            const current = yield* slots;
            const ready = current.find((slot) => slot.state === "ready");
            if (!ready) return { boxId: null as string | null, via: "cold" as const };
            yield* save(
              current.map((slot) => (slot.boxId === ready.boxId ? { ...slot, state: "claimed" as const, taskId } : slot)),
            );
            yield* state.waitUntil(refill).pipe(Effect.provideContext(runtimeContext));
            return { boxId: ready.boxId as string | null, via: "ready" as const };
          }),
        release: (boxId: string) =>
          Effect.gen(function* () {
            const current = yield* slots;
            yield* save(current.filter((slot) => slot.boxId !== boxId));
          }),
      };
    });
  }),
) {}
