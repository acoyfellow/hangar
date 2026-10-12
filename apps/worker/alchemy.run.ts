import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import HangarWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "Hangar",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* HangarWorker;
    return { url: worker.url.as<string>() };
  }),
);
