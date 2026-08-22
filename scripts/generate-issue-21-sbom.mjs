#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? "data/evals/issue-21/sbom.cdx.json");
const result = spawnSync("pnpm", ["list", "--prod", "--json", "--depth", "Infinity"], { cwd: root, encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr);
const tree = JSON.parse(result.stdout)[0];
const components = new Map();

function visit(dependencies = {}) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    const version = dependency.version ?? "unknown";
    const key = `${name}@${version}`;
    components.set(key, {
      type: "library",
      name,
      version,
      purl: `pkg:npm/${name.replace("@", "%40").replace("/", "%2F")}@${version}`,
      "bom-ref": `pkg:npm/${name}@${version}`,
    });
    visit(dependency.dependencies);
  }
}
visit(tree.dependencies);

const sourceManifestSha256 = "0c657f7278d3cf497dcec5c3e55b72ebff5cac891c1b0f19ab64e0527462fb13";
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    component: { type: "application", name: tree.name, version: tree.version },
    properties: [
      { name: "sangfor:source-manifest-sha256", value: sourceManifestSha256 },
      { name: "sangfor:lockfile-sha256", value: createHash("sha256").update(await import("node:fs").then(({ readFileSync }) => readFileSync(resolve(root, "pnpm-lock.yaml")))).digest("hex") },
      { name: "sangfor:node", value: "20.20.2" },
      { name: "sangfor:pnpm", value: "10.28.1" },
    ],
  },
  components: [...components.values()].sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"])),
};
writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`);
chmodSync(output, 0o444);
process.stdout.write(`${JSON.stringify({ output, components: bom.components.length, sha256: createHash("sha256").update(JSON.stringify(bom, null, 2) + "\n").digest("hex") })}\n`);
