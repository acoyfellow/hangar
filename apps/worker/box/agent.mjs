import * as http from "node:http";

const fetchOutcome = async ({ method = "GET", url }) => {
  try {
    const response = await fetch(url, { method });
    return { method, url, status: response.status, body: (await response.text()).slice(0, 500) };
  } catch (error) {
    return { method, url, status: 0, body: String(error.cause ?? error).slice(0, 200) };
  }
};

const secretEnvNames = () =>
  Object.keys(process.env).filter((name) => /token|secret|key|auth|pass/i.test(name));

const readJson = async (request) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  const url = new URL(request.url, "http://box");
  if (url.pathname === "/run" && request.method === "POST") {
    const { calls } = await readJson(request);
    const results = [];
    for (const call of calls) results.push(await fetchOutcome(call));
    response.end(JSON.stringify({ results, secretEnvNames: secretEnvNames() }));
    return;
  }
  response.end(JSON.stringify({ ready: true }));
});

server.listen(8080);
