// Build the RELEASE zip for rippers-compendium.
//
// WHY THIS SCRIPT EXISTS. The zip used to be assembled by hand with `zip -r` from the working
// tree. That is how a stray `styles/.claude/.cc-writes/` directory — a local harness artifact,
// never committed — reached the rippers-theme 0.3.0 zip and had to be caught by eye before
// publishing. A release must be built from COMMITTED bytes plus DELIBERATELY generated ones,
// never from "whatever happens to be sitting in the folder".
//
// THE METHOD (hybrid — ported from rippers-guise's tools/release-zip.mjs; do not regress to a
// hand `zip -r`, and do not regress to a bare `git archive` either):
//   1. `tools/pack.mjs` — compile src/packs/<name>/*.json → packs/<name>/ (Foundry CLI LevelDB).
//   2. `git archive HEAD -- module.json` → the zip. Committed bytes only.
//      NOTE the pathspec. Guise ships its whole repo; THIS module ships only module.json and
//      the compiled packs — the JSON sources, the snapshot, the tools and the tests stay out,
//      as they have since 0.4.x. A bare `git archive HEAD` would quietly start shipping all of
//      it. If you ever want that, change it on purpose and say so in the release notes.
//   3. Append packs/ — excluding LevelDB's LOCK and its rotated LOG.old, and any dot-path, so
//      the archive matches the shape shipped since 0.4.10 exactly.
//   4. Verify: every pack declared in module.json must ship its CURRENT marker, the zip must
//      carry no dot-path entries at all, and module.json's version must be the one on disk.
//      Any failure exits non-zero — a bad zip must never reach `gh release upload`.
//
// Usage: node tools/release-zip.mjs [outDir]   (default: repo root; writes rippers-compendium.zip)
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'rippers-compendium';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(process.argv[2] ?? root);
const zipPath = join(outDir, `${ID}.zip`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], ...opts });

// 1. compile the packs from source
run(process.execPath, [join(root, 'tools', 'pack.mjs')]);

// 2. module.json from git — committed state, not the working tree
rmSync(zipPath, { force: true });
run('git', ['archive', '--format=zip', '-o', zipPath, 'HEAD', '--', 'module.json']);

// 3. append the compiled packs
const stage = mkdtempSync(join(tmpdir(), 'rc-release-'));
try {
	cpSync(join(root, 'packs'), join(stage, 'packs'), { recursive: true });
	run('zip', ['-r', '-q', zipPath, 'packs', '-x', '*/LOCK', '*/LOG.old', '*/.*', '.*'], { cwd: stage });
} finally {
	rmSync(stage, { recursive: true, force: true });
}

// 4. verify
const listing = run('unzip', ['-l', zipPath]).toString();
const manifest = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8'));
const fails = [];

for (const p of manifest.packs ?? []) {
	if (!listing.includes(`${p.path}/CURRENT`)) fails.push(`compiled pack missing: ${p.path}/CURRENT`);
}

// The dot-path rule, in the place that can actually enforce it: nothing hidden ships from this
// module at all. (Guise legitimately ships tracked .github/.gitignore because it archives its
// whole repo; this module archives one file, so ANY dot-path here is junk.)
const dotPaths = listing.split('\n')
	.map((l) => l.trim().split(/\s+/).slice(3).join(' '))
	.filter((n) => n && /(^|\/)\.[^/]/.test(n));
if (dotPaths.length) fails.push(`dot-path entries in the zip: ${dotPaths.join(', ')}`);

// The zip's module.json must be the version on disk — catches a stale `git archive` after a
// bump that was not committed.
const zipManifest = JSON.parse(run('unzip', ['-p', zipPath, 'module.json']).toString());
if (zipManifest.version !== manifest.version) {
	fails.push(`zip module.json is ${zipManifest.version} but the working tree says ${manifest.version} — commit the bump before building the zip`);
}

if (fails.length) {
	console.error(`RELEASE ZIP INVALID:\n  - ${fails.join('\n  - ')}`);
	process.exit(1);
}
const count = listing.trim().split('\n').at(-1).trim().split(/\s+/)[1];
console.log(`ok: ${zipPath} — v${zipManifest.version}, ${manifest.packs.length} pack(s) verified, ${count} entries, 0 dot-paths`);
