# Sound library: tagging and filing pieces

`build_library_page` writes one HTML page that lists every sound the server can reach. `tools/sound-meta.mjs` adds metadata to workspace sounds and finished pieces, so a growing library (for example public-domain classics in several arrangements for different games) can be filed and filtered by composer, era, genre, mood, game use, arrangement and licence.

The page works with no metadata at all. Untagged files are listed exactly as before.

## Where metadata lives: one sidecar per name

Metadata for `satie-gymnopedie-1.wav` lives in `satie-gymnopedie-1.meta.json` in the same folder. Every format with the same name shares it: the WAV, the OGG, the `.mmp` project and a `.mid` all describe the same piece.

A sidecar was chosen over one index file for the workspace because:

- It travels with the sound. Copy the OGG and its `.meta.json` into a game repository and the title, licence and credits go with it.
- Two agents tagging different pieces never edit the same file, so there are no lost writes.
- A deleted or renamed sound takes its metadata with it, and a sound with no sidecar is simply untagged. An index would go stale.
- A person can read and fix one small JSON file by hand.

The cost is a folder scan when the page is built. The scan goes two folders down, the same depth the page already reads.

## Source notes

A Markdown note about where the music came from stays a plain `.md` file. If `<name>.source.md` sits next to the sound, the page shows it under the row as "Source note". When the note sits somewhere else, for example `classics/satie-gymnopedie-1.source.md` beside the score, point to it with the `sourceNote` field. Notes are shown as text, never run as HTML.

## Fields

```json
{
  "format": "lmms-mcp-meta/1",
  "title": "Gymnopédie No. 1",
  "composer": "Erik Satie",
  "composed": "1888",
  "era": "impressionist",
  "genre": ["classical piano"],
  "mood": ["calm", "melancholy"],
  "gameUse": ["menu", "puzzle", "hub"],
  "arrangement": "shaped",
  "instrumentation": ["Splendid Grand Piano"],
  "durationSeconds": 201.4,
  "loop": false,
  "source": "https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=37",
  "licence": "public domain",
  "credits": ["Score typeset by Evin Robertson for the Mutopia Project (public domain)"],
  "date": "2026-11-15",
  "kind": "piece",
  "tags": ["satie"],
  "notes": "Performance shaped with shape_performance.",
  "sourceNote": "classics/satie-gymnopedie-1.source.md"
}
```

| Field | Type | Values |
| --- | --- | --- |
| `title` | text | Display title. Replaces the file name on the page. |
| `composer` | text | As people search for it, for example "Erik Satie". |
| `composed` | text | When the music was written: "1888" or "1720-1722". |
| `era` | one of | medieval, renaissance, baroque, classical, romantic, impressionist, modern, traditional, original |
| `genre` | list | Open. Common: classical piano, orchestral, chiptune, dance, ambient, jazz, game cue, lo-fi, folk, rock |
| `mood` | list | Open. Common: calm, gentle, melancholy, dreamy, playful, bright, tense, dark, heroic, triumphant, mysterious, energetic |
| `gameUse` | list of | menu, hub, puzzle, exploration, ambient, battle, boss, victory, defeat, cutscene, credits, stinger |
| `arrangement` | one of | straight (as written), shaped (performed), chiptune, dance, orchestral, ambient, jazz, original |
| `instrumentation` | list | Instruments or sample libraries. |
| `durationSeconds` | number | Measured from the WAV or OGG when left out. |
| `loop` | true or false | True when the file loops cleanly in a game. |
| `source` | URL | Where the score, MIDI or recording came from. |
| `licence` | text | Use one spelling per licence: "public domain", "CC0", "CC-BY 3.0", "CC-BY 4.0", "CC-BY-SA 4.0", "MIT", "all rights reserved". |
| `credits` | list | Attribution lines to show wherever the sound is used. Needed for every CC-BY sample library. |
| `date` | YYYY-MM-DD | The day this file was made. |
| `kind` | one of | piece, sound, stem. A tagged file at the top of the workspace is a piece unless this says otherwise. |
| `tags` | list | Free tags. They join the tag filter on the page. |
| `notes` | text | Anything else, up to 2,000 characters. |
| `sourceNote` | path | A workspace `.md` file, when the note is not `<name>.source.md` next to the sound. |

Genre, mood and tags are stored in lower case so filters match however they were typed. An unknown field is an error, so a typo is caught rather than saved.

The composition and the recording can have different licences. A Satie piece is public domain, but a render on the Salamander Grand Piano uses samples under CC-BY 3.0, so the render's `licence` is "CC-BY 3.0" and `credits` must name Alexander Holm.

## Tools

### tag_sound

Input: `file` (a workspace audio, project or MIDI file, up to two folders down), `meta` (any of the fields above), `mode` and `measure`.

- `mode: "merge"` (default) keeps fields you do not pass, replaces the ones you do and removes any field passed as `null`.
- `mode: "replace"` writes only what you pass.
- `measure` (default true) fills in `durationSeconds` from the WAV or OGG when it is not set. Only the ends of the file are read.

It writes `<name>.meta.json`, through a temporary file so a crash never leaves half a sidecar, and returns the sidecar path, the files that share it, the saved metadata and the source note. Bad values are refused with the reason and nothing is written.

### list_tagged (read-only)

Filters: `composer`, `era`, `genre`, `mood`, `gameUse`, `arrangement`, `licence`, `kind`, `loop`, `instrumentation`, `title` and `text`. Text fields match part of a value, so "satie" finds "Erik Satie". List filters take one value or several and match any of them. `text` searches every field.

Other options: `file` returns one entry, `untagged: true` lists workspace audio with no sidecar yet, `includeNote: true` adds the source note text, `limit` (default 100).

Each result gives the name, its files, the sidecar, the metadata and the source note path. `values` lists every composer, era, genre and so on in use, which helps keep spellings consistent. A sidecar that cannot be read is listed under `problems` and never stops the call.

## The library page

`build_library_page` reads the sidecars when it lists workspace files:

- A tagged render at the top of the workspace is listed under a new type, **Finished pieces**, with its title, composer and year, its era, genre and game use as chips, its licence, its credits and a link to its source.
- A row of filters appears for composer, era, genre, mood, game use, arrangement and licence. Each filter only shows values that fit the other filters, with counts. The row is hidden when nothing is tagged.
- Search covers every metadata field.
- WAV and OGG renders both play. When a WAV and an OGG share a name, the row plays the WAV and shows both formats. A render that only exists as OGG plays the OGG, and its length is read from the file.
- A broken sidecar does not break the page. Its valid fields are used and the page notes the problem.

Serve the page with `node library-server.mjs` so the browser can play files from disk.
