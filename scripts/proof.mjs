import { writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const baseUrl = process.env.HANGAR_URL ?? "http://127.0.0.1:1337";
const receiptsDir = new URL("../receipts/", import.meta.url);
const checks = [];

const check = (name, passed, detail) => {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const api = async (path, body) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${await response.text()}`);
  return response.json();
};

const waitFor = async (read, done, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
};

const runTask = async (path) => {
  const launched = await api("/api/tasks", { path });
  const ref = { taskId: launched.taskId, runId: launched.runId, path };
  const view = () => api("/api/tasks/view", ref);
  const waiting = await waitFor(view, (v) => v.receipts.some((r) => r.decision === "awaiting-approval"), 60_000);
  await api("/api/tasks/approve", ref);
  const finished = await waitFor(view, (v) => v.status === "complete" || v.status === "errored", 60_000);
  return { launched, waiting, finished };
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const upstreamBefore = await api("/api/upstream");
await api("/api/hangar/fill", {});
const hangar = await waitFor(() => api("/api/hangar"), (h) => h.readyCount >= 3, 120_000);
check("hangar holds 3 ready boxes", hangar.readyCount >= 3, `${hangar.readyCount} ready`);

const samples = [];
for (const path of ["pooled", "cold", "pooled", "cold", "pooled", "cold"]) {
  await api("/api/hangar/fill", {});
  await waitFor(() => api("/api/hangar"), (h) => h.readyCount >= 1, 60_000);
  samples.push(await runTask(path));
}

const pooled = samples.filter((s) => s.launched.path === "pooled");
const cold = samples.filter((s) => s.launched.path === "cold");
const boxReadyMs = (s) => s.finished.output.boxReadyAt - s.launched.launchedAt;

check("every task finished", samples.every((s) => s.finished.status === "complete"), samples.map((s) => s.finished.status).join(","));
check("pooled runs came from the warmed workflow pool", pooled.every((s) => s.launched.runVia === "warmed"), pooled.map((s) => s.launched.runVia).join(","));
check("pooled tasks used a ready box", pooled.every((s) => s.finished.output.boxSource === "ready"));
check("cold tasks started a fresh box", cold.every((s) => s.finished.output.boxSource === "fresh"));
const pooledMedian = median(pooled.map(boxReadyMs));
const coldMedian = median(cold.map(boxReadyMs));
check("ready box is faster than fresh box", pooledMedian < coldMedian, `median ${pooledMedian} ms vs ${coldMedian} ms`);

const sample = pooled[0].finished;
const decisionOf = (method, path) =>
  sample.receipts.filter((r) => r.method === method && r.url.endsWith(path)).map((r) => r.decision);
check("allowed call reached the service", decisionOf("POST", "/v1/workers/hello/deploy").includes("allowed"));
check("off-contract DELETE refused before the service", decisionOf("DELETE", "/v1/workers/billing").join() === "refused");
check("call to another host refused", decisionOf("GET", "/exfiltrate").join() === "refused");
check(
  "route change waited for approval, then ran",
  decisionOf("POST", "/v1/workers/hello/route").join() === "awaiting-approval,allowed",
);
check("no secret names inside any box", samples.every((s) => s.finished.output.secretEnvNamesInBox.length === 0));

const upstreamAfter = await api("/api/upstream");
const newCalls = upstreamAfter.slice(upstreamBefore.length);
check("service saw only allowed paths", newCalls.every((c) => c.path.startsWith("/v1/workers/hello")), `${newCalls.length} calls`);
check("every call the service saw carried the key", newCalls.every((c) => c.keyAccepted));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
await page.goto(baseUrl);
await page.getByText("ready", { exact: false }).first().waitFor({ timeout: 30_000 });
await page.getByRole("button", { name: /Race/ }).click();
const approveButtons = page.getByRole("button", { name: /Approve/ });
await approveButtons.nth(1).waitFor({ timeout: 60_000 });
await page.screenshot({ path: new URL("race-waiting.png", receiptsDir).pathname, fullPage: true });
await approveButtons.first().click();
await approveButtons.first().click();
await page.getByText("finished after").nth(1).waitFor({ timeout: 60_000 });
await page.screenshot({ path: new URL("race-finished.png", receiptsDir).pathname, fullPage: true });
check("website shows both lanes finished", (await page.getByText("finished after").count()) === 2);
await browser.close();

const passed = checks.every((c) => c.passed);
const summary = {
  gate: passed ? "pass" : "fail",
  at: new Date().toISOString(),
  baseUrl,
  boxReadyMedianMs: { ready: pooledMedian, fresh: coldMedian },
  samples: samples.map((s) => ({
    path: s.launched.path,
    runVia: s.launched.runVia,
    boxSource: s.finished.output.boxSource,
    boxReadyMs: boxReadyMs(s),
    finishedMs: s.finished.output.finishedAt - s.launched.launchedAt,
  })),
  checks,
};
await writeFile(new URL("gate.json", receiptsDir), `${JSON.stringify(summary, null, 2)}\n`);
console.log(passed ? "\nGATE PASS" : "\nGATE FAIL");
process.exit(passed ? 0 : 1);
