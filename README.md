# rippers-compendium

The Rippers Unmasked class corpus as native Foundry Item packs the GM drags onto
**Project FU** sheets. **Content only — no automation code.** Foundry **v13**. Original
Rippers content, **not for redistribution**; ships **no** Project FU or Fabula Ultima content.

## Packs

| Pack | Type | Contents |
|---|---|---|
| **Rippers Classes** (`classes`) | Item (`class`) | 51 `type:"class"` Items — every Rippers class. Each carries identity (alt-names), its activated FU **free-benefit flags** (see below), and a description that UUID-links each of its class skills. |
| **Rippers Class Skills** (`skills`) | Item (`skill`) | 269 `type:"skill"` Items — the class skills, one Item each, `class` + `Max SL` set. Linked from the class descriptions via `@UUID`. |
| **Rippers Heroic Skills** (`heroics`) | Item (`heroic`) | 173 `type:"heroic"` Items — every heroic skill **with its requirement listed** (`system.requirement.value`), synthesised from the structured gate where the corpus left the text blank. |

Generated from `data/db-snapshot.json` (a snapshot of the maintained class registry —
`public.classes` / `class_skills` / `heroic_skills`) and the `lodge-docs/CLASSREF-*.md`
class cards (identity + the printed free-benefit line).

### Rules notes

- **Free benefits are activated** (Austin ruling, 2026-08-20 — *TRUE-with-note*): where a
  class card records a concrete printed FU benefit (a resource increase, a martial
  proficiency, ritual access), that flag is set **true** and a one-line house note is added
  to the Item. FU applies the class math on the sheet.
- **"+HP or MP, your choice"** cannot be a fixed boolean — those 7 classes leave both false,
  note the choice in the Item, and the player sets the chosen resource on the sheet.
- **25 classes carry no benefit flag** — 15 are the core-fifteen (standard FU classes with no
  individual card here) and 10 are cards that record no concrete benefit ("dead letter" /
  unrecorded). Activating those needs Austin's per-class FU benefit list; they are flagged by
  the generator, never guessed.
- **Heroic requirements**: the text is used where the corpus has it (164/173); the rest are
  synthesised from `mastery_classes` / `class_gate` / `required_skills` (e.g. *"Master any
  class"* for the generic heroics, *"Illusionist mastery"* for The Prestige).
- **Player-safe:** the registry's ✎/⚠/⛔ commentary-leak glyphs are stripped from all body
  text via the shipped strip policy (`src/lib/stripCommentary.ts`).
- **No automation** — skills and heroics ship `hasRoll:false`; attack/roll specifics stay as
  description prose (Project FU won't auto-roll them). Effects/automation are a later plugin.

## Build

```
npm install                        # once — @foundryvtt/foundryvtt-cli
node tools/build-compendium.mjs    # regenerate src/packs/* from the snapshot + cards
npm run pack                       # compile src/packs/<pack> -> packs/<pack> (LevelDB)
npm run unpack                     # reverse
```

To refresh the source data, re-snapshot the three registry tables into
`data/db-snapshot.json` and re-run the generator.

## Install (personal table)

Install/update on ForgeVTT (or copy into `Data/modules/`) via the manifest URL:

```
https://github.com/RoscoeRackham/rippers-compendium/releases/latest/download/module.json
```

Enable in your Project FU v13 world; the three compendiums appear in the Items sidebar.
Drag a class onto a sheet, then its skills and heroics from their compendiums.
