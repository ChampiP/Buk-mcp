const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && entry.name.endsWith(".test.js") ? [path] : [];
  }).sort();
}

const files = testFiles(join(__dirname, "dist", "test"));
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) {
  process.stderr.write("BUK MCP tests could not start.\n");
  process.exit(1);
}
process.exit(result.status ?? 1);
