# Generation catalogue

The compose, render, master and export tools record their outputs under
`$LMMS_WORKSPACE/catalog/catalog.jsonl` and write a version 1 JSON sidecar next
to the primary output. A batch records one generation per candidate. A stem
set records its files together. Tool responses include `generationIds`.
SHA-256 fingerprints identify the exact files. If cataloguing fails after the
audio is written, the tool reports `catalogueWarning` and keeps the audio.

- `list_generations` filters by style, game, rating, licence and inclusive
  UTC dates. Use `offset` and `limit` to page through results.
- `show_generation` returns the manifest with the current rating.
- `rate_generation` appends a 1–5 rating to the index. Include a note or a
  reference to feedback read with `read_feedback`. Use `remember_taste` when
  that feedback should also affect future compositions.
- `backfill_catalog` scans one folder's immediate audio, MIDI and project
  files. Existing path/hash pairs are skipped. WAV metrics are measured where
  possible. Source information unsupported by the existing file stays empty.

The schema and source licence registry live in `schema/`. Outputs without
verified sample provenance are marked `publishable: false`. After checking
the actual inputs in a dedicated folder, pass `verifiedLibraries` to
`backfill_catalog` to register a verified record. This label depends on the
libraries declared by the operator and is not approval to upload or release.
Sample-free instrument output can also lack provenance. The registry's Surge
XT entry describes the plugin, not independent clearance of any loaded
samples or presets. Location fields for R2 and Hugging Face are reserved.

Sidecars preserve the initial record. The append-only index records later
ratings. Paths are relative to the workspace. Keep their files with the
catalogue if you want to verify the hashes or reproduce the generation.
