# Releasing

## How a version is cut today

Versions are cut by hand on GitHub. From 0.9.0, pushing a version tag also publishes `@sarutobi-sasuke/lmms-mcp` to npm through `.github/workflows/release.yml`, using npm trusted publishing with provenance. No npm token is stored in GitHub. Version 0.8.1 was prepared but never tagged or published, so 0.9.0 is the first version on npm.

1. The version number is changed in `package.json`, `package-lock.json` and the `McpServer` constructor near the top of `server.mjs`.
2. The pull request that carries the change is merged into `main`.
3. A tag such as `v0.7.0` is created on that merge commit, and a GitHub release of the same name is made from it and marked as a pre-release.
4. The release notes are written by hand. Since 0.7.0 they end with a "Compatibility" section that names changed tool behaviour and the LMMS version that was tested.

Tags `v0.2.0` to `v0.7.0` exist, all as pre-releases. Several versions were cut on the same day. Work merged after a tag (for example the VST3 adapter after `v0.7.0`) ships under the old version number until the next tag.

## Checklist for the next version

Before tagging:

- [ ] `main` is green: the CI workflow (unit tests, syntax check and server start-up on Windows and Linux) and the LMMS workflow (`verify-*.mjs` against stock LMMS 1.2.2).
- [ ] Run every `verify-*.mjs` at the repository root with `node` on a real Windows machine with LMMS 1.2.2 installed as well. CI runners have no sound card and run each check once.
- [ ] Every merged pull request since the last tag is listed in `CHANGELOG.md` under the new version (see the proposal below), with tool schema changes marked as breaking or not.
- [ ] The version number matches in `package.json`, `package-lock.json` and `server.mjs`. Run `npm install --package-lock-only` after editing `package.json` so the lock file follows.
- [ ] `npm pack --dry-run` lists `server.mjs`, the other root modules, `tools/`, `sound-catalogue.json`, `skills/`, `docs/` and nothing private or generated (no `output/`, no `.wav` files, no `tools/*.test.mjs`).
- [ ] The README describes any new tool and any new environment variable.

To release:

- [ ] Tag the merge commit on `main`, not a feature branch: `git tag -a v0.8.0 -m "LMMS MCP 0.8.0"` and `git push origin v0.8.0`.
- [ ] Create the GitHub release from the tag. Paste the version's section of `CHANGELOG.md` as the notes and keep the "Compatibility" heading.
- [ ] Keep it marked as a pre-release until the tool schemas are considered stable (1.0.0).
- [ ] Pushing the tag starts the Release workflow, which runs the checks again, confirms the tag matches `package.json` and publishes to npm. Watch it finish, then check `npm view @sarutobi-sasuke/lmms-mcp version`.

## Proposal: a change log for tool schema changes

Agents call the tools by name with arguments checked against a schema. A renamed argument, a new required argument or a changed return shape breaks an agent's saved workflow without any error until it runs. This has already happened without notice (for example `list_presets` changing its return shape in 0.7.0).

Proposed rules:

1. Add `CHANGELOG.md` at the repository root in the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) layout, with an `Unreleased` section at the top.
2. Every pull request that adds, removes or changes a tool adds a line under `Unreleased`. Use these headings: `Breaking`, `Added`, `Changed`, `Fixed`.
3. A change is breaking if it removes or renames a tool or an argument, makes an argument required, changes an argument's type or allowed values, or changes the shape of what a tool returns. Breaking lines say what an agent should do instead.
4. While the version is below 1.0.0, a breaking change bumps the minor version (0.7.x to 0.8.0). Other changes bump the patch version. From 1.0.0, follow semantic versioning in full.
5. When a version is cut, rename `Unreleased` to the version and date, and copy that section into the GitHub release notes.

The CI workflow already helps with this. On every pull request, the "Tool schema changes" job starts the server from the pull request and from its base branch, compares every tool's input schema and writes a list of possibly breaking and other changes to the job summary. It does not fail the pull request today. Once `CHANGELOG.md` exists, the job can be made to fail when it finds a possibly breaking change and `CHANGELOG.md` was not changed in the same pull request.

The job only sees input schemas. Changes to what a tool returns still need to be written down by hand.
