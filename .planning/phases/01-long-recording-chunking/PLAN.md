# PLAN: 01 — Long recording chunking

## Phase Goal

The existing 5-hour-36-minute Plaud recording completes as one private local
transcript without retry loops, while short recordings behave exactly as before.

## Tasks

- [x] Add a tested ffmpeg chunking boundary for long Whisper-style audio.
  - Where: `src/lib/transcription/chunk-audio.ts`, `src/tests/transcription/chunk-audio.test.ts`
  - Verify: the focused test first fails because the helper is absent, then passes with multiple ordered Ogg chunks from a controlled audio fixture and proves cleanup on failure.
  - Fence: no provider calls, database writes, new dependency, env variable, or UI.
  - Tier: build
- [x] Route only recordings over 30 minutes through sequential chunk transcription and merge the results.
  - Where: `src/lib/transcription/transcribe-recording.ts`, `src/tests/regressions/long-recording-chunking.test.ts`
  - Verify: the regression test first fails on one provider call, then passes with ordered chunk calls, ordered merged text, first detected language, and no persistence after a failed chunk.
  - Fence: Whisper-style path only; chat, Gemini, browser, Mynah, title generation, and persistence contracts remain unchanged.
  - Tier: build
- [x] Collapse concurrent calls for the same user and recording onto one in-flight transcription.
  - Where: `src/lib/transcription/transcribe-recording.ts`, `src/tests/regressions/long-recording-chunking.test.ts`
  - Verify: two concurrent calls share one provider sequence; different recordings do not; success and failure both clear the guard for a later retry.
  - Fence: same-process efficiency only; no new queue, lock table, cross-process claim, or route behavior.
  - Tier: build
- [ ] Run the full validation ladder and build the pinned custom image.
  - Where: repository root, Docker image `riffado-local:0.6.4-long-audio-1`
  - Verify: focused tests, `pnpm test`, `pnpm format-and-lint:fix`, `pnpm type-check`, and the image build all exit 0.
  - Fence: do not upgrade Riffado, dependencies, Node, Postgres, or model files.
  - Tier: review
- [ ] Deploy with rollback artifacts and prove the real long recording.
  - Where: Mini `/Users/lattice/riffado`, its Postgres database, and local Docker runtime
  - Verify: pre-deploy database/compose backups exist; health returns version 0.6.4; the target recording gains exactly one transcription row; logs show ordered chunk completion without client-disconnect retries; short playback and existing transcript counts remain intact.
  - Fence: no schema migration, cloud provider, Plaud title write-back, or unrelated untranscribed backlog processing.
  - Tier: review
