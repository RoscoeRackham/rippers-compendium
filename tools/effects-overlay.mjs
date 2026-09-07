// effects-overlay.mjs — the skill Active Effect overlay, and the pure merge the build uses.
//
// WHY AN OVERLAY. Every skill Item the generator emits ships `effects: []` (proven, AUDIT-skill-
// automation §1a). The descriptions are generated from the registry and must never be hand-edited,
// so the effects cannot live in the generator's row logic either. They live as data, one file per
// skill, keyed by the same class_key/skill_key the generator already uses:
//
//   data/effects/<class_key>/<skill_key>.json   →   an ARRAY of Foundry ActiveEffect objects
//
// The generator calls effectsFor() while building each skill and drops the array straight into the
// Item's `effects`. A skill with no overlay file keeps `effects: []` exactly as before, so the
// overlay is additive and the diff for an un-overlaid skill is empty.
//
// PROVENANCE RULE. Every effect here is COPIED from projectfu 4.16.2's own same-named skill Item and
// kept only where our printed description states the same mechanical value. Nothing is invented and
// nothing is adapted beyond what FU itself wrote. Each file records its FU source in
// `_provenance` (stripped before it reaches the Item — Foundry would keep unknown keys otherwise).
//
// SCALING TOKENS, verified in the system source, not assumed:
//   `$sl`                    → projectfu's own expression evaluator, module/expressions/expressions.mjs
//                              case 'sl' → context.item.system.level.value — the SKILL's level.
//   `@system.level.value`    → Roll.replaceFormulaData(change.value, this.parent) in
//                              module/documents/effects/active-effect-behaviour-mixin.mjs — `parent`
//                              is the ITEM, so this is also the skill level, not the character level.
// Both mean SL. Each row keeps whichever token FU itself used, so a re-port diffs clean against FU.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Keys Foundry will not accept on an embedded ActiveEffect create; ours are documentation. */
const OVERLAY_ONLY_KEYS = ['_provenance'];

/** PURE: strip our documentation keys from one effect object. */
export function cleanEffect(effect) {
	const out = { ...effect };
	for (const k of OVERLAY_ONLY_KEYS) delete out[k];
	return out;
}

/** PURE: validate one overlay effect. Returns an array of problems (empty = fine). */
export function validateEffect(effect, where = '') {
	const p = [];
	const at = where ? `${where}: ` : '';
	if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return [`${at}not an object`];
	if (!effect.name) p.push(`${at}missing name`);
	if (!Array.isArray(effect.changes)) p.push(`${at}changes must be an array`);
	// An effect with no changes is a MARKER — 45 of FU's 55 skill effects are exactly that, and they
	// carry nothing we can port. Refuse them here so an empty one never sneaks into a build.
	else if (effect.changes.length === 0) p.push(`${at}changes is empty — a marker effect carries nothing to port`);
	for (const [i, c] of (effect.changes ?? []).entries()) {
		if (!c?.key) p.push(`${at}changes[${i}] missing key`);
		if (!Number.isInteger(c?.mode)) p.push(`${at}changes[${i}] mode must be an integer (Foundry ACTIVE_EFFECT_MODES)`);
		if (c?.value === undefined || c?.value === null || c?.value === '') p.push(`${at}changes[${i}] missing value`);
	}
	if (!effect._provenance?.fu) p.push(`${at}missing _provenance.fu — every effect must name the FU skill it came from`);
	if (effect._id !== undefined && !/^[A-Za-z0-9]{16}$/.test(String(effect._id))) p.push(`${at}_id must be 16 alphanumeric characters`);
	return p;
}

/** Load the whole overlay tree: { "<class>/<skill>": [effect, …] }. */
export function loadEffectsOverlay(dir) {
	const overlay = {};
	if (!existsSync(dir)) return overlay;
	for (const classKey of readdirSync(dir).filter((d) => !d.startsWith('.'))) {
		const classDir = join(dir, classKey);
		let files = [];
		try { files = readdirSync(classDir).filter((f) => f.endsWith('.json')); } catch { continue; }
		for (const f of files) {
			const skillKey = f.replace(/\.json$/, '');
			const parsed = JSON.parse(readFileSync(join(classDir, f), 'utf8'));
			overlay[`${classKey}/${skillKey}`] = Array.isArray(parsed) ? parsed : [parsed];
		}
	}
	return overlay;
}

/** PURE: a stable 16-char document id for one overlay effect, derived from its own coordinates so a
 *  rebuild never renumbers it (the same discipline the skill Items themselves follow). */
export function effectId(classKey, skillKey, index = 0) {
	const seed = `${classKey}/${skillKey}#${index}`;
	let h1 = 0x811c9dc5, h2 = 0x01000193;
	for (let i = 0; i < seed.length; i++) {
		h1 = Math.imul(h1 ^ seed.charCodeAt(i), 16777619) >>> 0;
		h2 = Math.imul(h2 + seed.charCodeAt(i), 2654435761) >>> 0;
	}
	const body = (h1.toString(36) + h2.toString(36) + 'zzzzzzzzzzzz').slice(0, 12);
	return `RCfx${body}`;
}

/** PURE: the effects array for one skill — cleaned and stamped, or [] when the skill has no overlay.
 *  `itemId` is the skill Item's _id; the compiled LevelDB needs each embedded effect's own `_key`
 *  (`!items.effects!<itemId>.<effectId>`) or compilePack throws LEVEL_INVALID_KEY. */
export function effectsFor(classKey, skillKey, overlay, itemId = null) {
	const rows = overlay?.[`${classKey}/${skillKey}`];
	if (!Array.isArray(rows)) return [];
	return rows.map((e, i) => {
		const out = cleanEffect(e);
		out._id = out._id || effectId(classKey, skillKey, i);
		if (itemId) out._key = `!items.effects!${itemId}.${out._id}`;
		return out;
	});
}

/** PURE: validate the whole overlay. Returns problems; the build fails on any. */
export function validateOverlay(overlay) {
	const problems = [];
	for (const [key, rows] of Object.entries(overlay ?? {})) {
		if (!Array.isArray(rows)) { problems.push(`${key}: not an array of effects`); continue; }
		if (rows.length === 0) problems.push(`${key}: empty overlay file — delete it instead`);
		for (const [i, e] of rows.entries()) problems.push(...validateEffect(e, `${key}[${i}]`));
	}
	return problems;
}
