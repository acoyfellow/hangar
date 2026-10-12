# Hangar

Give an agent a task, not your keys.

![Hangar running a ready box and a fresh box side by side](receipts/race-finished.png)

Hangar keeps locked agent boxes ready. A task claims one, gets a contract, and runs. The box has no internet. Every request it sends goes to a referee outside the box. The referee checks the request against the contract, adds the key, and writes a receipt. The box never holds the key.

## What the demo shows

Press **Race** and two copies of the same task start at once:

- **Ready box.** The run comes from a pool of Workflow runs that already started. The box comes from the hangar, already started.
- **Fresh box.** The run starts cold. The box starts on demand.

Each task tries five requests. The referee decides each one:

| Request | Decision |
| --- | --- |
| `GET /v1/workers/hello` | allowed |
| `POST /v1/workers/hello/deploy` | allowed |
| `DELETE /v1/workers/billing` | refused, not in the contract |
| `GET example.com/exfiltrate` | refused, not in the contract |
| `POST /v1/workers/hello/route` | waits for a human, then allowed |

The outside service only sees allowed requests, and each one carries the key that the referee added.

## Run it

You need Node 22+, pnpm, and Docker (colima works).

```sh
git clone --recurse-submodules https://github.com/acoyfellow/hangar
cd hangar
pnpm install
pnpm dev
```

Open http://127.0.0.1:1337. In another terminal, run the proof:

```sh
pnpm proof
```

`pnpm proof` runs six tasks through the API, then drives the website in headless Chrome. It exits 0 only when every check passes, and writes [`receipts/gate.json`](receipts/gate.json).

Last local run: a ready box was ready a median **23 ms** after launch; a fresh box took **1,033 ms**.

`alchemy dev` reads the built website once at startup. After you change `apps/web`, stop and run `pnpm dev` again.

## How it works

| Part | File | Job |
| --- | --- | --- |
| Box | `apps/worker/box/`, `src/box.ts` | A container with internet off. Its outgoing requests go to its own Durable Object, which is the referee. |
| Referee | `src/box.ts` | Matches each request to a grant in the contract. Refuses, holds for approval, or forwards with the key. |
| Hangar | `src/hangar.ts` | Keeps three boxes started. A claim hands one out and starts a refill. |
| Task run | `src/task-run.ts` | One Workflow per task: claim a box, run the steps, wait for approval, run the approved steps, retire the box. |
| Ledger | `src/ledger.ts` | Receipts per task. They outlive the box. |
| Service | `src/upstream.ts` | A stand-in for a real API. It owns the key and records every call it gets. |
| Website | `apps/web` | Foldkit app served by the same Worker. |

## Built on

- [cf-workflow-pool](https://github.com/dmmulroy/cf-workflow-pool) by Dillon Mulroy: the pool of started Workflow runs. Included as a git submodule at a pinned commit and used as is.
- [armada](https://github.com/AshishKumar4/armada) by Ashish Kumar: the idea of starting boxes before you need them and handing them out from a queue. No code copied.
- [Alchemy](https://alchemy.run) 2.0.0-beta.81, with upstream fix [`a7dd0b3`](https://github.com/alchemy-run/alchemy/commit/a7dd0b37acd2012be4a2c935bf5e4175f4cd4cc4) applied as a pnpm patch so container request interception works locally.
- [Effect](https://effect.website) v4 on the backend and [Foldkit](https://foldkit.dev) on the front end.

## Not done yet

- It runs locally only. The deploy to hangar.coey.dev and its Access policy are not set up.
- Container snapshots, which armada uses, are not used. Local dev cannot make them.
- The agent in the box is a script that sends a fixed list of requests, not a model.
- The service is a stand-in. A real API needs its key stored as a Worker secret.
