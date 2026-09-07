// Headless tests for the skill Active Effect overlay (v0.4.9 wave 1).
// The overlay is DATA; these guard the merge and the shape rules that keep a bad effect out of a build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEffect, validateEffect, validateOverlay, effectsFor, loadEffectsOverlay } from '../tools/effects-overlay.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY_DIR = join(ROOT, 'data', 'effects');
const ok = () => ({ name: 'X', changes: [{ key: 'system.resources.hp.bonus', mode: 2, value: '3*$sl' }], _provenance: { fu: 'projectfu 4.16.2 · skill "Fortress"' } });

test('overlay: a skill with no overlay file still ships effects: [] — the merge is additive', () => {
	const overlay = { 'guardian/fortress': [ok()] };
	assert.deepEqual(effectsFor('adept', 'clarity', overlay), []);
	assert.deepEqual(effectsFor('guardian', 'fortress', overlay).length, 1);
	assert.deepEqual(effectsFor('guardian', 'fortress', undefined), []);
});

test('overlay: _provenance is documentation and never reaches the Item', () => {
	const cleaned = cleanEffect(ok());
	assert.equal(cleaned._provenance, undefined);
	assert.equal(cleaned.name, 'X');
	assert.equal(cleaned.changes.length, 1);
	assert.equal(effectsFor('guardian', 'fortress', { 'guardian/fortress': [ok()] })[0]._provenance, undefined);
});

test('overlay: a MARKER effect (changes: []) is refused — 45 of FU\'s 55 are exactly that', () => {
	const marker = { ...ok(), changes: [] };
	const problems = validateEffect(marker, 'x/y');
	assert.ok(problems.some((p) => /marker effect carries nothing/.test(p)), problems.join('; '));
});

test('overlay: an effect must name where it came from', () => {
	const anon = { ...ok() }; delete anon._provenance;
	assert.ok(validateEffect(anon, 'x/y').some((p) => /_provenance/.test(p)));
});

test('overlay: a change needs a key, an integer mode and a value', () => {
	assert.ok(validateEffect({ ...ok(), changes: [{ mode: 2, value: '1' }] }).some((p) => /missing key/.test(p)));
	assert.ok(validateEffect({ ...ok(), changes: [{ key: 'a', mode: '2', value: '1' }] }).some((p) => /mode must be an integer/.test(p)));
	assert.ok(validateEffect({ ...ok(), changes: [{ key: 'a', mode: 2, value: '' }] }).some((p) => /missing value/.test(p)));
	assert.deepEqual(validateEffect(ok()), []);
});

test('overlay: the SHIPPED overlay validates and every effect is provenance-stamped', () => {
	const overlay = loadEffectsOverlay(OVERLAY_DIR);
	assert.deepEqual(validateOverlay(overlay), [], 'the shipped overlay must have no problems');
	assert.ok(Object.keys(overlay).length > 0, 'wave 1 ships at least one overlay');
	for (const [key, rows] of Object.entries(overlay)) {
		for (const e of rows) assert.match(e._provenance.fu, /^projectfu 4\.16\.2 · (skill|heroic) /, `${key} must cite its FU source`);
	}
});

/** Every built row that an overlay can target: skills as class/skill, heroics as heroics/<key>. */
function builtRows() {
	const rows = new Map();
	for (const [pack, keyOf] of [['skills', (fl) => `${fl.classKey}/${fl.skillKey}`], ['heroics', (fl) => `heroics/${fl.heroicKey}`]]) {
		const dir = join(ROOT, 'src', 'packs', pack);
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
			const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
			rows.set(keyOf(d.flags['rippers-compendium']), d);
		}
	}
	return rows;
}

test('overlay: every overlay file matches a real built skill or heroic', () => {
	const overlay = loadEffectsOverlay(OVERLAY_DIR);
	const built = builtRows();
	if (built.size === 0) return;                       // packs not built in this checkout
	for (const key of Object.keys(overlay)) assert.ok(built.has(key), `overlay ${key} does not match any built row`);
});

test('overlay: the effects landed on exactly the listed rows, and nowhere else', () => {
	const overlay = loadEffectsOverlay(OVERLAY_DIR);
	const built = builtRows();
	if (built.size === 0) return;
	let withEffects = 0;
	for (const [key, d] of built) {
		if (overlay[key]) {
			withEffects++;
			assert.equal(d.effects.length, overlay[key].length, `${key} effect count`);
			assert.equal(d.effects[0]._provenance, undefined, `${key} must not ship _provenance`);
			assert.match(d.effects[0]._id, /^[A-Za-z0-9]{16}$/, `${key} effect needs a document id`);
			assert.equal(d.effects[0]._key, `!items.effects!${d._id}.${d.effects[0]._id}`, `${key} effect needs its LevelDB key`);
		} else {
			assert.deepEqual(d.effects, [], `${key} must still ship effects: []`);
		}
	}
	assert.equal(withEffects, Object.keys(overlay).length, 'every overlay row landed');
});

test('overlay: heroics are reachable too — wave 2 added them', () => {
	const built = builtRows();
	if (built.size === 0) return;
	assert.ok([...built.keys()].some((k) => k.startsWith('heroics/')), 'heroics must be addressable by the overlay');
});
