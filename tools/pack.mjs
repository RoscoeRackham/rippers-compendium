// Compile src/packs/<pack>/*.json (one JSON per document) into LevelDB packs/<pack>.
// Mirrors the Project FU pack pipeline (tools/pullYMLtoLDB.mjs). Reusable across the
// Rippers Foundry modules — plugins 2-4 copy this file unchanged.
import { compilePack } from '@foundryvtt/foundryvtt-cli';
import { promises as fs } from 'fs';

const MODULE_ID = process.cwd();
const yaml = false; // sources are JSON, one document per file

const packs = await fs.readdir('./src/packs');
for (const pack of packs) {
	if (pack.startsWith('.')) continue;
	console.log('Packing ' + pack);
	// Clear the target LevelDB first. compilePack writes INTO an existing dir, so recompiling
	// in place leaves CURRENT/MANIFEST pointing at a stale .ldb lineage — an inconsistent pack
	// that Foundry v13 fails to open ("Cannot read properties of undefined (reading 'packData')").
	// A clean dir per build guarantees a consistent single-manifest LevelDB.
	await fs.rm(`${MODULE_ID}/packs/${pack}`, { recursive: true, force: true });
	await compilePack(`${MODULE_ID}/src/packs/${pack}`, `${MODULE_ID}/packs/${pack}`, { yaml });
}
console.log('Done.');
