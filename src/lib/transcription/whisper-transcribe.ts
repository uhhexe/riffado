import type { OpenAI } from "openai";
import { buildAudioFile } from "@/lib/transcription/audio-file";
import { chunkAudioForWhisper } from "@/lib/transcription/chunk-audio";
import { maybeCompressForWhisper } from "@/lib/transcription/compress-audio";
import {
    buildTranscriptionParams,
    getResponseFormat,
    parseTranscriptionResponse,
} from "@/lib/transcription/format";

export const LONG_RECORDING_THRESHOLD_MS = 30 * 60 * 1000;

export interface WhisperTranscribeInput {
    client: OpenAI;
    audioBuffer: Buffer;
    contentType: string;
    storagePath: string;
    filename: string;
    durationMs: number | null;
    model: string;
    language?: string;
    timeoutMs: number;
}

export interface WhisperTranscribeResult {
    text: string;
    detectedLanguage: string | null;
}

/**
 * Run the OpenAI-compatible audio transcription path. Short recordings keep
 * the existing single-request compression behavior; long recordings are
 * segmented and submitted sequentially, then merged only after all succeed.
 */
export async function whisperTranscribe(
    input: WhisperTranscribeInput,
): Promise<WhisperTranscribeResult> {
    const {
        client,
        audioBuffer,
        contentType,
        storagePath,
        filename,
        durationMs,
        model,
        language,
        timeoutMs,
    } = input;
    const responseFormat = getResponseFormat(model);

    if (durationMs !== null && durationMs > LONG_RECORDING_THRESHOLD_MS) {
        const chunks = await chunkAudioForWhisper(audioBuffer);
        const texts: string[] = [];
        let detectedLanguage: string | null = null;
        const baseFilename = filename.replace(/\.[a-z0-9]{2,4}$/i, "");

        for (const [index, chunk] of chunks.entries()) {
            const part = String(index + 1).padStart(3, "0");
            const { file } = buildAudioFile(
                chunk,
                `${baseFilename}-part-${part}.ogg`,
                `${baseFilename}-part-${part}.ogg`,
            );
            const transcription = await client.audio.transcriptions.create(
                buildTranscriptionParams({
                    file,
                    model,
                    responseFormat,
                    language,
                }),
                { timeout: timeoutMs },
            );
            const parsed = parseTranscriptionResponse(
                transcription,
                responseFormat,
            );
            if (parsed.text.trim()) texts.push(parsed.text.trim());
            if (!detectedLanguage && parsed.detectedLanguage) {
                detectedLanguage = parsed.detectedLanguage;
            }
            console.info(
                `[whisper-chunk] completed chunk ${index + 1}/${chunks.length}`,
            );
        }

        return { text: texts.join("\n"), detectedLanguage };
    }

    const original = buildAudioFile(audioBuffer, storagePath, filename).file;
    const compressed = await maybeCompressForWhisper(audioBuffer, contentType);
    const file = compressed.compressed
        ? buildAudioFile(compressed.buffer, storagePath, filename).file
        : original;
    const transcription = await client.audio.transcriptions.create(
        buildTranscriptionParams({
            file,
            model,
            responseFormat,
            language,
        }),
        { timeout: timeoutMs },
    );
    return parseTranscriptionResponse(transcription, responseFormat);
}
