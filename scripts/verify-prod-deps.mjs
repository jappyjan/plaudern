#!/usr/bin/env node
// Guards against the class of crash where a workspace lib declares a third-party
// dependency that isn't resolvable in the deployed API image.
//
// Why this can happen: the production image (apps/api/Dockerfile) ships the
// compiled server as a FLAT `dist/server/...` tree next to a single top-level
// `node_modules`. At runtime Node resolves every `require(...)` by walking up to
// that one `node_modules`. So a dependency declared only in a lib (e.g.
// `mailparser` in @plaudern/email-ingest) is reachable at runtime ONLY if the
// deploy lifts it to the top level. `deploy:api` pins `node-linker=hoisted` to
// do exactly that; this script proves it holds for every transitive prod dep, so
// a future dependency added to any lib can't silently crash-loop the server.
//
// It reproduces the Dockerfile's deploy (via the shared `deploy:api` script) into
// a temp dir, then asserts every third-party runtime dependency of every
// workspace package reachable from @plaudern/api resolves from that deploy's
// top-level node_modules — the exact resolution the runtime performs.
//
// Usage:
//   node scripts/verify-prod-deps.mjs            # runs the deploy itself
//   node scripts/verify-prod-deps.mjs --dir DIR  # checks an existing deploy dir
//     (DIR must contain node_modules, e.g. the Dockerfile's /prod output)

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_PACKAGE = '@plaudern/api';
// Globs from pnpm-workspace.yaml, expanded manually to avoid a glob dep.
const WORKSPACE_DIRS = ['apps', 'libs', 'libs/backend'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Map every workspace package name -> { dir, pkg } by scanning the workspace globs. */
function loadWorkspacePackages() {
  const byName = new Map();
  for (const globDir of WORKSPACE_DIRS) {
    const base = join(repoRoot, globDir);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgPath = join(base, entry.name, 'package.json');
      if (!existsSync(pkgPath)) continue;
      const pkg = readJson(pkgPath);
      if (pkg.name) byName.set(pkg.name, { dir: join(base, entry.name), pkg });
    }
  }
  return byName;
}

/**
 * BFS the workspace dependency graph from the root package and collect every
 * third-party (non-workspace) runtime dependency encountered along the way.
 * Returns a Map<depName, Set<declaringWorkspacePkg>> for actionable errors.
 */
function collectThirdPartyDeps(workspace) {
  const thirdParty = new Map();
  const visited = new Set();
  const queue = [ROOT_PACKAGE];
  while (queue.length) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    const node = workspace.get(name);
    if (!node) throw new Error(`Workspace package "${name}" not found on disk`);
    // Only `dependencies` ship at runtime. devDependencies are stripped by --prod;
    // peerDependencies are the consumer's contract (satisfied by @plaudern/api).
    for (const depName of Object.keys(node.pkg.dependencies ?? {})) {
      if (workspace.has(depName)) {
        queue.push(depName); // another workspace package — traverse into it
      } else {
        if (!thirdParty.has(depName)) thirdParty.set(depName, new Set());
        thirdParty.get(depName).add(name);
      }
    }
  }
  return thirdParty;
}

function deployToTemp() {
  const dir = mkdtempSync(join(tmpdir(), 'plaudern-proddeps-'));
  console.log(`→ Reproducing the production deploy into ${dir} (pnpm deploy:api)…`);
  execFileSync('pnpm', ['deploy:api', dir], { cwd: repoRoot, stdio: 'inherit' });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function main() {
  const argDirFlag = process.argv.indexOf('--dir');
  let deployDir;
  let cleanup = () => {};
  if (argDirFlag !== -1) {
    deployDir = resolve(process.argv[argDirFlag + 1] ?? '');
  } else {
    ({ dir: deployDir, cleanup } = deployToTemp());
  }

  const nodeModules = join(deployDir, 'node_modules');
  if (!existsSync(nodeModules)) {
    console.error(`✗ No node_modules found at ${nodeModules}`);
    process.exit(1);
  }

  const workspace = loadWorkspacePackages();
  const thirdParty = collectThirdPartyDeps(workspace);

  // Resolve each dep exactly as the runtime does: from the deploy's top-level
  // node_modules (the only node_modules the flat dist tree can reach).
  const requireFrom = createRequire(join(nodeModules, 'noop.js'));
  const missing = [];
  for (const [dep, declaredBy] of thirdParty) {
    try {
      requireFrom.resolve(dep, { paths: [nodeModules] });
    } catch {
      missing.push({ dep, declaredBy: [...declaredBy] });
    }
  }

  try {
    if (missing.length) {
      console.error(
        `\n✗ ${missing.length} production dependenc${missing.length === 1 ? 'y is' : 'ies are'} ` +
          `NOT resolvable from the deployed top-level node_modules.\n` +
          `  The API would crash-loop with MODULE_NOT_FOUND at runtime.\n`,
      );
      for (const { dep, declaredBy } of missing) {
        console.error(`  • ${dep}  (declared by: ${declaredBy.join(', ')})`);
      }
      console.error(
        `\n  Ensure the deploy hoists them (deploy:api uses node-linker=hoisted) and\n` +
          `  that each is a real, installed dependency of its declaring package.\n`,
      );
      process.exit(1);
    }
    console.log(
      `✓ All ${thirdParty.size} third-party production dependencies reachable from ` +
        `${ROOT_PACKAGE} resolve from the deployed top-level node_modules.`,
    );
  } finally {
    cleanup();
  }
}

main();
