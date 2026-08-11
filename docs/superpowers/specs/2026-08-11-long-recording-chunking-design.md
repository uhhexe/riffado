# Long Recording Chunking Design

## Problem

Riffado 0.6.4 submits every Whisper-style transcription as one request. A
5-hour-36-minute Plaud recording was compressed from roughly 82 MiB to 12.84
MiB, but whisper.cpp still had to decode 323,003,520 samples in one operation.
The client disconnected before completion, Whisper aborted, and background
sync started the same work again. The recording never reached persistence.

The local model is healthy: recordings up to 28 minutes completed normally.
The failure is the single-request shape, not the model or audio download.

## Chosen Approach

Chunk long Whisper-style recordings inside Riffado before the provider call.
Recordings longer than 30 minutes are converted into ordered, mono Opus chunks
of at most 30 minutes. Riffado transcribes those chunks sequentially through
the already configured OpenAI-compatible endpoint, joins their text in order,
and persists one transcript through the existing tombstone-aware upsert.

The same-process in-flight guard keys work by user and recording. Repeated
background-sync or manual calls share the existing promise instead of starting
another chunk sequence. This is an efficiency guard, not the cross-process
correctness mechanism; the existing database constraints remain authoritative.

### Rejected alternatives

- **Increase the request timeout:** rejected because the live server logged
  failed encode/decode and client disconnects. More waiting repeats the same
  failure and does not bound memory.
- **Add a transcription proxy beside Riffado:** rejected because it creates a
  second service, protocol boundary, deployment, and failure surface for logic
  that belongs at Riffado's existing provider boundary.
- **Run chunks in parallel:** rejected because it multiplies Mini memory use,
  worsens provider fairness, and makes ordering/error handling harder without
  improving the user-visible contract.

## Data Flow

1. Load and decrypt the recording exactly as Riffado does today.
2. For non-Whisper providers and recordings at or below 30 minutes, keep the
   existing path unchanged.
3. For longer Whisper-style recordings, run one ffmpeg segmentation pass that
   emits ordered mono Ogg/Opus chunks in a temporary directory.
4. Submit one chunk at a time with the current provider, model, response
   format, language, and request timeout.
5. Parse each response with the existing response parser. Join non-empty chunk
   text with newlines and retain the first detected language.
6. Persist only after every chunk succeeds. Existing title generation,
   enhancements, events, and webhook behavior then run once against the merged
   transcript.
7. Remove the temporary directory in a `finally` path.

## Failure Contract

- If segmentation fails, return the existing transcription failure shape.
- If any chunk fails, do not persist a partial transcript. A later retry starts
  a clean sequence.
- If the recording is deleted while work runs, the existing guarded upsert
  rejects the final write.
- Concurrent calls for the same user and recording share one in-flight result;
  the guard clears after success or failure.
- No new database table, queue, recurring job, API key, provider, or public
  endpoint is introduced.

## Verification

- A failing unit test proves long audio is not currently segmented.
- Helper tests prove ffmpeg emits multiple ordered Ogg chunks and always
  cleans temporary files.
- Orchestration tests prove sequential calls, ordered merge, no partial
  persistence on chunk failure, short-recording parity, and in-flight dedupe.
- The complete Riffado test, format/lint, and type-check ladders pass.
- A custom image pinned to 0.6.4 is deployed on the Mini after a database and
  compose backup. The live 5-hour-36-minute recording produces exactly one
  transcript, and Riffado remains healthy.

## Approval

Cody approved the product behavior in chat on 2026-08-11: automatically split
long recordings, transcribe the pieces locally, and reunite them as one
transcript. The implementation remains free and invisible in normal use.
