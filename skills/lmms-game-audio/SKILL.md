---
name: lmms-game-audio
description: Compose, audition, revise, and export editable LMMS music loops and game audio using LMMS MCP. Use for synth patches, arpeggios, drum grooves, stems, MIDI and one-shot packs.
---

# LMMS game audio

- For a style brief, search `list_composer_profiles` by technique or game use. Create an editable seed with `create_composer_sketch`, then revise its motifs, harmony and arrangement for the scene.

- Call `search_sounds` for an audible role such as dark arp, sub bass, or metallic bell. Fathom results carry a patch ID. Stock LMMS results carry a preset path. Audition results with `preview_sound` and share WAV paths if the session has audio playback.
- Build a saved project with separate lanes for drums, bass, harmony and hook. A beat is 48 ticks, a 4/4 bar is 192 ticks, and bar numbers start at zero. Factory drums trigger at MIDI 69. Use rests, note lengths and varying accents to shape the rhythm.
- Use a catalogue patch ID with `render_fathom_track` to render the edited notes through the same synth. Cutoff starts at tick zero. Use `apply_preset` for a native preset. Fathom leaves the source notes editable and plays a bounced clip, so bounce again after changes. If the optional engine is absent, pick a verified native sound.
- Use `render_mix` for complete loops. Check duration, full-scale samples and the loop boundary. Deliver the MMP or MMPZ and any referenced WAVs for editable handoff. Use `render_stems` for aligned layers and `export_midi` for piano-roll material.
- Use `export_one_shots` for short mono game assets with consistent peak levels and a manifest.
