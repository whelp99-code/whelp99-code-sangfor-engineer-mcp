#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

const root = resolve(import.meta.dirname, "..");
const archive = resolve(process.argv[2]);
const output = resolve(process.argv[3] ?? "data/evals/issue-21/rehearsal.json");
const expectedArchiveSha256 = process.env.ISSUE_21_EXPECTED_ARCHIVE_SHA256;
if (!expectedArchiveSha256) throw new Error("ISSUE_21_EXPECTED_ARCHIVE_SHA256 is required");
const productionIndex = join(root, "data/rag/index.json");
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
if (sha256(archive) !== expectedArchiveSha256) throw new Error("candidate archive identity mismatch");

const productionBefore = sha256(productionIndex);
const rehearsalRoot = mkdtempSync(join(tmpdir(), "sangfor-issue21-rehearsal-"));
const layout = join(rehearsalRoot, "layout");
const deploy = join(rehearsalRoot, "deploy");
mkdirSync(layout);
mkdirSync(deploy);
const untar = (args) => {
  const result = spawnSync("tar", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
};
untar(["-xf", archive, "-C", layout]);
const index = JSON.parse(readFileSync(join(layout, "index.json"), "utf8"));
const imageDigest = index.manifests[0].digest;
const manifest = JSON.parse(readFileSync(join(layout, "blobs/sha256", imageDigest.slice(7)), "utf8"));
const layerDigest = manifest.layers[0].digest;
untar(["-xf", join(layout, "blobs/sha256", layerDigest.slice(7)), "-C", deploy]);

const started = performance.now();
const child = spawn(join(deploy, "usr/local/bin/node"), [join(deploy, "app/node_modules/tsx/dist/cli.mjs"), join(deploy, "app/apps/mcp-server/src/index.ts")], {
  cwd: join(deploy, "app"),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    PATH: `${join(deploy, "usr/local/bin")}:/usr/bin:/bin`,
    NODE_ENV: "production",
    MCP_PROBE: "1",
    HOME: join(rehearsalRoot, "home"),
    SANGFOR_RAG_INDEX_PATH: join(rehearsalRoot, "unmounted-index.json"),
  },
});
const lines = createInterface({ input: child.stdout });
let toolCount = 0;
let initializeOk = false;
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const smoke = new Promise((resolveSmoke, reject) => {
  const timeout = setTimeout(() => reject(new Error("packaged MCP smoke timeout")), 15_000);
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === 1 && message.result) {
      initializeOk = true;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    }
    if (message.id === 2) {
      toolCount = message.result?.tools?.length ?? 0;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      resolveSmoke();
    }
  });
  child.on("error", reject);
  child.on("exit", (code) => {
    if (!toolCount) reject(new Error(`packaged MCP exited before smoke completed: code=${code} stderr=${stderr}`));
  });
});
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "issue-21-rehearsal", version: "1.0" } } })}\n`);
await smoke;
await new Promise((resolveExit) => child.once("exit", resolveExit));
const latencyMs = performance.now() - started;
if (!initializeOk || toolCount < 5) throw new Error(`packaged MCP smoke failed: initialize=${initializeOk} tools=${toolCount} stderr=${stderr}`);

rmSync(rehearsalRoot, { recursive: true, force: false });
const removed = !existsSync(rehearsalRoot);
const productionAfter = sha256(productionIndex);
if (!removed || productionBefore !== productionAfter) throw new Error("rollback or production preservation check failed");

const result = {
  schemaVersion: 1,
  candidateArchiveSha256: expectedArchiveSha256,
  imageDigest,
  layerDigest,
  isolatedDeployPathRemoved: rehearsalRoot,
  firstDeploy: { initializeOk, toolsListed: toolCount, latencyMs },
  removalRollback: { candidatePathAbsent: removed, productionIndexPreserved: true },
  productionIndex: { beforeSha256: productionBefore, afterSha256: productionAfter },
  limitation: "No OCI runtime was installed; rehearsal extracted the OCI layer into a unique temporary directory and executed its packaged Node binary with a minimal isolated environment.",
};
writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o444 });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
