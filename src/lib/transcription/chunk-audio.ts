import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

const DEFAULT_SEGMENT_SECONDS = 30 * 60;
const DEFAULT_BITRATE_KBPS = 12;

export interface ChunkAudioOptions {
    segmentSeconds?: number;
    bitrateKbps?: number;
    /** Test seam; production uses the OS temporary directory. */
    tempRoot?: string;
}

/**
 * Convert audio into ordered mono Ogg/Opus segments that stay comfortably
 * inside a single Whisper request. The temporary directory is removed before
 * this function resolves or rejects; callers only retain the chunk buffers.
 */
export async function chunkAudioForWhisper(
    input: Buffer,
    options: ChunkAudioOptions = {},
): Promise<Buffer[]> {
    const segmentSeconds = options.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS;
    const bitrateKbps = options.bitrateKbps ?? DEFAULT_BITRATE_KBPS;
    const workDir = await mkdtemp(
        path.join(options.tempRoot ?? tmpdir(), "riffado-whisper-"),
    );
    const outputPattern = path.join(workDir, "chunk-%05d.ogg");

    try {
        await runFfmpeg(input, outputPattern, segmentSeconds, bitrateKbps);
        const names = (await readdir(workDir))
            .filter((name) => /^chunk-\d{5}\.ogg$/.test(name))
            .sort();

        if (names.length === 0) {
            throw new Error("ffmpeg produced no audio chunks");
        }

        const chunks = await Promise.all(
            names.map((name) => readFile(path.join(workDir, name))),
        );
        console.info(
            `[whisper-chunk] split recording into ${chunks.length} ordered chunk(s)`,
        );
        return chunks;
    } finally {
        await rm(workDir, { recursive: true, force: true });
    }
}

function runFfmpeg(
    input: Buffer,
    outputPattern: string,
    segmentSeconds: number,
    bitrateKbps: number,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn(
            "ffmpeg",
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-map",
                "0:a:0",
                "-vn",
                "-map_metadata",
                "-1",
                "-ac",
                "1",
                "-c:a",
                "libopus",
                "-b:a",
                `${bitrateKbps}k`,
                "-application",
                "voip",
                "-f",
                "segment",
                "-segment_format",
                "ogg",
                "-segment_time",
                String(segmentSeconds),
                "-reset_timestamps",
                "1",
                outputPattern,
            ],
            { stdio: ["pipe", "ignore", "pipe"] },
        );

        const stderrChunks: Buffer[] = [];
        let settled = false;

        const settleReject = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        ffmpeg.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
        ffmpeg.on("error", (error) => {
            settleReject(
                new Error(
                    `ffmpeg spawn failed (binary missing from runtime image?): ${error.message}`,
                ),
            );
        });
        ffmpeg.on("close", (code) => {
            if (settled) return;
            if (code !== 0) {
                const stderr = Buffer.concat(stderrChunks)
                    .toString("utf8")
                    .trim();
                settleReject(
                    new Error(
                        `ffmpeg exited with code ${code}: ${stderr || "(no stderr)"}`,
                    ),
                );
                return;
            }
            settled = true;
            resolve();
        });
        ffmpeg.stdin.on("error", (error) => {
            settleReject(
                new Error(`ffmpeg stdin write failed: ${error.message}`),
            );
        });
        ffmpeg.stdin.end(input);
    });
}
