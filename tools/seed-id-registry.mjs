// One-shot: file every id already shipped in src/packs under its key. Run once, commit the
// result, then never again — after this the build maintains data/id-registry.json itself.
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedFromPacks, PREFIX } from './id-registry.mjs';

const MODULE = join(dirname(fileURLToPath(import.meta.url)), '..');
const seeded = seedFromPacks(MODULE);
const sorted = {};
for (const kind of Object.keys(PREFIX)) {
  sorted[kind] = Object.fromEntries(Object.entries(seeded[kind]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  console.log(`${kind}: ${Object.keys(sorted[kind]).length} keys`);
}
writeFileSync(join(MODULE, 'data', 'id-registry.json'), JSON.stringify(sorted, null, '\t') + '\n');
console.log('wrote data/id-registry.json');
