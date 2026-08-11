import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    chunkAudioForWhisper: vi.fn(),
    maybeCompressForWhisper: vi.fn(),
}));

vi.mock("@/lib/transcription/chunk-audio", () => ({
    chunkAudioForWhisper: mocks.chunkAudioForWhisper,
}));

vi.mock("@/lib/transcription/compress-audio", () => ({
    maybeCompressForWhisper: mocks.maybeCompressForWhisper,
}));

import {
    LONG_RECORDING_THRESHOLD_MS,
    whisperTranscribe,
} from "@/lib/transcription/whisper-transcribe";

describe("whisperTranscribe", () => {
    const create = vi.fn();
    const client = {
        audio: { transcriptions: { create } },
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.maybeCompressForWhisper.mockImplementation(
            async (buffer: Buffer, contentType: string) => ({
                buffer,
                contentType,
                compressed: false,
            }),
        );
    });

    it("transcribes long recordings sequentially and merges text in order", async () => {
        const chunks = [
            Buffer.from("OggS-one"),
            Buffer.from("OggS-two"),
            Buffer.from("OggS-three"),
        ];
        mocks.chunkAudioForWhisper.mockResolvedValue(chunks);

        let active = 0;
        let peak = 0;
        create.mockImplementation(async () => {
            active += 1;
            peak = Math.max(peak, active);
            const index = create.mock.calls.length - 1;
            await Promise.resolve();
            active -= 1;
            return [
                { text: "first", language: "en" },
                { text: "", language: "fr" },
                { text: "third", language: "de" },
            ][index];
        });

        const result = await whisperTranscribe({
            client: client as never,
            audioBuffer: Buffer.from("source"),
            contentType: "audio/mpeg",
            storagePath: "recording.mp3",
            filename: "Drive notes",
            durationMs: LONG_RECORDING_THRESHOLD_MS + 1,
            model: "whisper-1",
            language: undefined,
            timeoutMs: 60_000,
        });

        expect(mocks.chunkAudioForWhisper).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledTimes(3);
        expect(peak).toBe(1);
        expect(result).toEqual({
            text: "first\nthird",
            detectedLanguage: "en",
        });
        expect(create.mock.calls.map(([params]) => params.file.name)).toEqual([
            "Drive notes-part-001.ogg",
            "Drive notes-part-002.ogg",
            "Drive notes-part-003.ogg",
        ]);
    });

    it("does not return a partial transcript when a chunk fails", async () => {
        mocks.chunkAudioForWhisper.mockResolvedValue([
            Buffer.from("OggS-one"),
            Buffer.from("OggS-two"),
        ]);
        create
            .mockResolvedValueOnce({ text: "partial", language: "en" })
            .mockRejectedValueOnce(new Error("provider failed"));

        await expect(
            whisperTranscribe({
                client: client as never,
                audioBuffer: Buffer.from("source"),
                contentType: "audio/mpeg",
                storagePath: "recording.mp3",
                filename: "Drive notes",
                durationMs: LONG_RECORDING_THRESHOLD_MS + 1,
                model: "whisper-1",
                timeoutMs: 60_000,
            }),
        ).rejects.toThrow("provider failed");
    });

    it("keeps the existing single-request compression path at the threshold", async () => {
        const source = Buffer.from("source");
        create.mockResolvedValue({ text: "short", language: "en" });

        const result = await whisperTranscribe({
            client: client as never,
            audioBuffer: source,
            contentType: "audio/mpeg",
            storagePath: "recording.mp3",
            filename: "Short note",
            durationMs: LONG_RECORDING_THRESHOLD_MS,
            model: "whisper-1",
            timeoutMs: 60_000,
        });

        expect(mocks.chunkAudioForWhisper).not.toHaveBeenCalled();
        expect(mocks.maybeCompressForWhisper).toHaveBeenCalledWith(
            source,
            "audio/mpeg",
        );
        expect(create).toHaveBeenCalledOnce();
        expect(result.text).toBe("short");
    });
});
