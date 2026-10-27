import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { fileURLToPath } from "node:url";
import { recipes } from "./recipes.mjs";

const serverPath = fileURLToPath(new URL("../dist/src/main.js", import.meta.url));
const privateDirectory = fileURLToPath(new URL("./private/", import.meta.url));
const xmlPath = fileURLToPath(new URL("./private/buk-tenant.xml", import.meta.url));

if (recipes.length !== 10 || new Set(recipes.map((item) => item.id)).size !== 10) {
  throw new Error("Expected exactly ten recipes with unique IDs");
}

function makeMetrics() {
  return { calls: 0, upstreamCalls: 0, responseBytes: 0, seconds: 0, tools: new Map() };
}

async function executeRecipe(client, entry) {
  const metrics = makeMetrics();
  const started = performance.now();
  const call = async (tool, args) => {
    metrics.calls++;
    metrics.tools.set(tool, (metrics.tools.get(tool) ?? 0) + 1);
    let result;
    try {
      result = await client.callTool({ name: tool, arguments: args });
    } catch {
      throw new Error(`${tool} call failed`);
    }
    metrics.responseBytes += Buffer.byteLength(JSON.stringify(result));
    const payload = result.structuredContent;
    metrics.upstreamCalls += Number(payload?.meta?.upstream_calls ?? 0);
    if (result.isError || !payload || typeof payload !== "object") {
      throw new Error(`${tool} returned an MCP error`);
    }
    return payload;
  };

  try {
    const answer = await entry.recipe(call);
    if (!(typeof answer === "number" && Number.isFinite(answer)) &&
        !(typeof answer === "string" && answer.length > 0 && answer.length <= 100)) {
      throw new Error("Recipe did not return one short aggregate value");
    }
    return { ok: true, answer, metrics: { ...metrics, seconds: (performance.now() - started) / 1000 } };
  } catch {
    return { ok: false, metrics: { ...metrics, seconds: (performance.now() - started) / 1000 } };
  }
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function display(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { PATH: process.env.PATH, BUK_AUTH_TOKEN: process.env.BUK_AUTH_TOKEN },
});
const client = new Client({ name: "buk-evaluation-runner", version: "1.0.0" });
let passResults;
try {
  await client.connect(transport);
  passResults = [[], []];
  for (let pass = 0; pass < 2; pass++) {
    for (const entry of recipes) {
      passResults[pass].push(await executeRecipe(client, entry));
    }
  }
} finally {
  await client.close();
}

const stableEntries = [];
for (let index = 0; index < recipes.length; index++) {
  const entry = recipes[index];
  const first = passResults[0][index];
  const second = passResults[1][index];
  const stable = first.ok && second.ok && Object.is(first.answer, second.answer);
  const combinedTools = new Set([
    ...first.metrics.tools.keys(),
    ...second.metrics.tools.keys(),
  ]);
  const toolText = [...combinedTools].sort().join(",") || "none";
  const answerText = stable ? display(first.answer) : "UNAVAILABLE";
  console.log([
    `id=${entry.id}`,
    `answer=${answerText}`,
    `tools=${toolText}`,
    `calls=${first.metrics.calls}/${second.metrics.calls}`,
    `upstream=${first.metrics.upstreamCalls}/${second.metrics.upstreamCalls}`,
    `bytes=${first.metrics.responseBytes}/${second.metrics.responseBytes}`,
    `seconds=${first.metrics.seconds.toFixed(2)}/${second.metrics.seconds.toFixed(2)}`,
    `stable=${stable ? "yes" : "no"}`,
    "complete_asserted=yes",
  ].join(" | "));

  if (stable) {
    stableEntries.push(
      `  <qa_pair>\n` +
      `    <question>${xmlEscape(entry.question)}</question>\n` +
      `    <answer>${xmlEscape(first.answer)}</answer>\n` +
      `  </qa_pair>`,
    );
  }
}

await mkdir(privateDirectory, { recursive: true });
await writeFile(xmlPath, `<evaluation>\n${stableEntries.join("\n")}\n</evaluation>\n`, "utf8");
console.log(`stable_xml_pairs=${stableEntries.length}/10`);
if (stableEntries.length !== 10) process.exitCode = 1;
