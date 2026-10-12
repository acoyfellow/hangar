# Hangar plan

Hangar keeps agent boxes ready and locked. A task claims a ready box, gets a contract, and runs. The box has no internet. Every request it sends goes to a referee that checks the contract, adds the key, and writes a receipt.

## Built on

- cf-workflow-pool by Dillon Mulroy: one pre-started Workflow run per task. Installed from GitHub at a pinned commit.
- armada by Ashish Kumar: the pull model and pre-started containers. Ideas only, credited.
- Alchemy 2.0.0-beta.81 with upstream fix a7dd0b3 applied as a pnpm patch for local outbound interception.

## Slices

1. Box: container with no internet, outbound requests go to the Box Durable Object. Done.
2. Referee: contract per task (allowed method + host + path prefix), fake upstream service, key added only by the referee, receipts in Durable Object SQLite.
3. Hangar pool: Hangar Durable Object keeps N boxes started; claim hands one out with one SQL update; refill after each claim.
4. Task run: cf-workflow-pool run per task: claim box, run steps, wait for approval event when a step needs it, finish, destroy box.
5. API: Effect HttpApi for launch, approve, status, receipts, race.
6. Web: Foldkit app served by the same Worker.
7. Proof: one script that runs the whole demo locally and exits 0 only when every check passes.

## Proof checks

- A pooled launch reaches its first step faster than a cold launch.
- An allowed call reaches the fake upstream with the key; the box never sees the key.
- An off-contract call is refused by the referee before any upstream call.
- A step that needs approval waits until approved, then runs.
- Each decision is in the receipts.
