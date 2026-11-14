# Feature modules

Every `.mjs` file in this folder is loaded when the server starts. New features go here, one file each, so that work on different features does not collide in `server.mjs`.

A module exports one function:

```js
export function register({ tool, edit, z, dsp, schemas, project, render, music, sounds, moduleGuidance }) {
  tool('my_tool', 'What it does.', { project: schemas.projectName }, async ({ project: name }) => {
    const doc = await project.load(name);
    return { tracks: project.tracks(doc).length };
  });
}
```

- `tool(name, description, inputSchema, handler)` registers a tool. Return a plain object. To return images, set `result[context.imagesKey] = [pngBuffer]`.
- `edit(name, description, schema, apply)` registers a change to a loaded project. `apply(doc, args)` mutates the document. The edit becomes a tool with `project` and `output`, and a step for `apply_edits`.
- `schemas` holds the shared zod types (`projectName`, `workspaceWav`, `folderName`, `pattern`, `track` and others).
- `project` holds the document helpers (`load`, `save`, `tracks`, `children`, `add`, `songInfo`, `instrumentOf`, `trackRole`, `roleNames` and others).
- `render` holds `renderDoc`, `renderMix`, `isolate`, `pool`, `writeAudio`, `masterAudio` and `measureWav`.
- `dsp` is `audio.mjs`: WAV decode and encode, loudness, spectrum, pitch, limiter and spectrogram.
- Push one or two sentences onto `moduleGuidance` to tell agents when to use the module's tools. `get_started` returns them.

## Checks on save and export

Two lists in the context let a module check a project as it is saved or exported:

- `postSave`: run by `create_project`, `apply_edits` and every edit registered with `{ checked: true }` (today only `add_track`), on the document just before it is written.
- `exportChecks`: run by `export_game_audio` on the project before anything is rendered.

A check is `async (doc, { project }) => null | { summary, blocking, warnings }`. Return `null` when there is nothing to say, so saves stay quiet. The server merges every result into one `arrangement` field on the tool's output (`summary` joined, `blocking` if any check blocks, `warnings` concatenated). Checks never stop a call unless the caller passes `strict: true`; then a blocking result stops it with an error before anything is written. A check that throws is reported as a non-blocking warning, so a bug in a check can never break a save. Push with `context.postSave?.push(check)` so the module still loads on a server without the lists.

To have a new edit run the checks, register it with `edit(name, description, schema, apply, { checked: true })`. That adds an optional `strict` argument to its tool. Reserve it for edits that change what is played, not mix-only edits.

Track roles are stored on the track as `mcp-role` and read with `project.trackRole(track)`. The roles are drums, bass, harmony, lead, counter, texture and fx.

Keep pure logic in functions that take plain data, export them, and unit test them in a `tools/<name>.test.mjs` file run by `node --test`. Put LMMS checks in `verify-<name>.mjs` at the repository root. Document the feature in `docs/<name>.md`.
