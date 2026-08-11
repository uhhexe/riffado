# ROADMAP: Long recording transcription

## Handoff

Phase 01 is complete. Riffado 0.6.4 on the Mini now transcribes long
Whisper-style recordings as sequential 30-minute Ogg/Opus chunks, merges one
complete result, and collapses duplicate same-process attempts. The original
5h36m Plaud recording completed all 12 chunks and persisted exactly one local
transcript; short audio playback and the pre-existing data inventory were
verified unchanged.

## Approach (chosen) — chunk at Riffado's provider boundary

Keep the existing provider and persistence paths; only long Whisper-style
requests fan into sequential chunks before converging into the existing upsert.
**Rejected:** longer timeout (the live process aborts rather than merely waiting)
· sidecar proxy (new service and protocol surface) · parallel chunks (higher
memory and weaker ordering). Decision logged to Engram:
`build-plan/riffado/long-recording-chunking`.

## Stages

- [x] 01 — Long recording chunking → visible: the existing 5h36m recording has
  one complete local transcript and Riffado remains healthy.

## Risks & tripwires

- ffmpeg segmentation changes audio ordering — tripwire: fixture chunk count or
  duration order fails — fallback: use explicit start/duration extraction.
- background sync starts duplicate work — tripwire: more than one provider call
  enters the same recording concurrently — fallback: same-process keyed promise
  guard, with DB uniqueness remaining authoritative.
- custom image cannot roll forward cleanly — tripwire: health check or migration
  startup fails — fallback: restore the pinned 0.6.4 image and unchanged compose
  backup; no schema changes are part of this work.
