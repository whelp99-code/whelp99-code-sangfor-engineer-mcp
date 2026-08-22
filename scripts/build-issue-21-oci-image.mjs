#!/usr/bin/env node
import { cpSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? join(root, "data/evals/issue-21"));
const epoch = "1970-01-01T00:00:00.000Z";
const nodeRoot = process.env.ISSUE_21_NODE_ROOT
  ? resolve(process.env.ISSUE_21_NODE_ROOT)
  : dirname(dirname(process.execPath));
const nodeVersion = process.versions.node;
const sourceManifest = "data/evals/issue-19/reviewed-source-manifest.sha256-0c657f7278d3cf497dcec5c3e55b72ebff5cac891c1b0f19ab64e0527462fb13.json";
const sourceManifestSha256 = "0c657f7278d3cf497dcec5c3e55b72ebff5cac891c1b0f19ab64e0527462fb13";

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout?.trim() ?? "";
}

function copy(source, destination, dereference = false) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, dereference
    ? { recursive: true, dereference: true }
    : { recursive: true, verbatimSymlinks: true });
}

const actualManifestSha256 = sha256(readFileSync(join(root, sourceManifest)));
if (actualManifestSha256 !== sourceManifestSha256) throw new Error("reviewed source manifest identity mismatch");

mkdirSync(out, { recursive: true });
const staging = mkdtempSync(join(tmpdir(), "sangfor-issue21-"));
const rootfs = join(staging, "rootfs");
const layout = join(staging, "oci");

try {
  copy(join(nodeRoot, "bin/node"), join(rootfs, "usr/local/bin/node"));
  copy(join(nodeRoot, "lib/node_modules/corepack"), join(rootfs, "usr/local/lib/node_modules/corepack"));
  mkdirSync(join(rootfs, "usr/local/bin"), { recursive: true });
  symlinkSync("../lib/node_modules/corepack/dist/pnpm.js", join(rootfs, "usr/local/bin/pnpm"));

  for (const library of [
    "/usr/lib/x86_64-linux-gnu/libdl.so.2",
    "/usr/lib/x86_64-linux-gnu/libstdc++.so.6",
    "/usr/lib/x86_64-linux-gnu/libm.so.6",
    "/usr/lib/x86_64-linux-gnu/libgcc_s.so.1",
    "/usr/lib/x86_64-linux-gnu/libpthread.so.0",
    "/usr/lib/x86_64-linux-gnu/libc.so.6",
    "/lib64/ld-linux-x86-64.so.2",
  ]) copy(library, join(rootfs, library));

  for (const path of ["apps", "packages", "dist", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", sourceManifest]) {
    copy(join(root, path), join(rootfs, "app", path));
  }
  // pnpm's workspace links may be absolute in a retained working tree. Resolve
  // them into the layer so the candidate never depends on the build host path.
  copy(join(root, "node_modules"), join(rootfs, "app/node_modules"), true);
  symlinkSync("../../.pnpm/node_modules/esbuild", join(rootfs, "app/node_modules/tsx/node_modules/esbuild"));
  const flattenedModules = join(rootfs, "app/node_modules/.pnpm/node_modules");
  for (const name of readdirSync(flattenedModules)) {
    if (name.startsWith("@")) {
      if (name === "@sangfor") continue;
      mkdirSync(join(rootfs, "app/node_modules", name), { recursive: true });
      for (const scopedName of readdirSync(join(flattenedModules, name))) {
        const destination = join(rootfs, "app/node_modules", name, scopedName);
        if (!existsSync(destination)) symlinkSync(`../.pnpm/node_modules/${name}/${scopedName}`, destination);
      }
    } else {
      const destination = join(rootfs, "app/node_modules", name);
      if (!existsSync(destination)) symlinkSync(`.pnpm/node_modules/${name}`, destination);
    }
  }
  // Replace host-absolute workspace links with image-relative links.
  mkdirSync(join(rootfs, "app/node_modules/@sangfor"), { recursive: true });
  for (const area of ["apps", "packages"]) {
    for (const directory of readdirSync(join(root, area))) {
      const manifestPath = join(root, area, directory, "package.json");
      if (!existsSync(manifestPath)) continue;
      const name = JSON.parse(readFileSync(manifestPath, "utf8")).name;
      if (typeof name === "string" && name.startsWith("@sangfor/")) {
        symlinkSync(`../../${area}/${directory}`, join(rootfs, "app/node_modules/@sangfor", name.slice("@sangfor/".length)));
      }
    }
  }

  const layerTar = join(staging, "layer.tar");
  run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", layerTar, "-C", rootfs, "."]);
  const layer = readFileSync(layerTar);
  const layerDigest = sha256(layer);

  const config = Buffer.from(JSON.stringify({
    created: epoch,
    architecture: "amd64",
    os: "linux",
    config: {
      Env: ["NODE_ENV=production", "PATH=/usr/local/bin:/usr/bin:/bin"],
      Entrypoint: ["/usr/local/bin/node", "/app/node_modules/tsx/dist/cli.mjs", "/app/apps/mcp-server/src/index.ts"],
      WorkingDir: "/app",
      Labels: {
        "org.opencontainers.image.title": "sangfor-engineer-mcp",
        "org.opencontainers.image.revision": "c86dd4968157e70c3ed9e08561533b947a3c1884",
        "org.opencontainers.image.source-manifest.sha256": sourceManifestSha256,
        "org.opencontainers.image.index-contract": "external-read-only;production-sha256=0aa185ef482e284647b11daefe0a989ca25a7f0389161bcb0f5ffb89e063ee45;e5-candidate-sha256=9f3409ee18bfa8ddc171362018db4e6a88a45eae8b6cb51285ea0d0e9b78377d",
        "org.opencontainers.image.node": nodeVersion,
        "org.opencontainers.image.pnpm": "10.28.1",
      },
    },
    rootfs: { type: "layers", diff_ids: [`sha256:${layerDigest}`] },
    history: [{ created: epoch, created_by: "scripts/build-issue-21-oci-image.mjs" }],
  }));
  const configDigest = sha256(config);
  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: `sha256:${configDigest}`, size: config.length },
    layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: `sha256:${layerDigest}`, size: layer.length }],
    annotations: { "org.opencontainers.image.ref.name": "sangfor-engineer-mcp:issue-21-candidate" },
  }));
  const manifestDigest = sha256(manifest);

  mkdirSync(join(layout, "blobs/sha256"), { recursive: true });
  writeFileSync(join(layout, "oci-layout"), `${JSON.stringify({ imageLayoutVersion: "1.0.0" })}\n`);
  writeFileSync(join(layout, "blobs/sha256", layerDigest), layer);
  writeFileSync(join(layout, "blobs/sha256", configDigest), config);
  writeFileSync(join(layout, "blobs/sha256", manifestDigest), manifest);
  writeFileSync(join(layout, "index.json"), `${JSON.stringify({
    schemaVersion: 2,
    manifests: [{ mediaType: "application/vnd.oci.image.manifest.v1+json", digest: `sha256:${manifestDigest}`, size: manifest.length, annotations: { "org.opencontainers.image.ref.name": "sangfor-engineer-mcp:issue-21-candidate" } }],
  })}\n`);

  const archive = join(out, `sangfor-engineer-mcp.issue-21.oci.sha256-${manifestDigest}.tar`);
  run("tar", ["--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner", "-cf", archive, "-C", layout, "."]);
  chmodSync(archive, 0o444);

  const result = {
    schemaVersion: 1,
    sourceManifest: { path: sourceManifest, sha256: sourceManifestSha256 },
    runtime: { node: nodeVersion, nodeSha256: sha256(readFileSync(join(nodeRoot, "bin/node"))), pnpm: "10.28.1" },
    image: {
      format: "OCI image layout archive",
      reference: "sangfor-engineer-mcp:issue-21-candidate",
      id: `sha256:${configDigest}`,
      digest: `sha256:${manifestDigest}`,
      layerDigest: `sha256:${layerDigest}`,
      archive,
      archiveSha256: sha256(readFileSync(archive)),
      archiveBytes: readFileSync(archive).length,
    },
    indexIdentityContract: {
      bundled: false,
      mount: "/app/data/rag/index.json",
      access: "external read-only",
      productionSha256: "0aa185ef482e284647b11daefe0a989ca25a7f0389161bcb0f5ffb89e063ee45",
      e5CandidateSha256: "9f3409ee18bfa8ddc171362018db4e6a88a45eae8b6cb51285ea0d0e9b78377d",
    },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
