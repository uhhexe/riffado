import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkAudioForWhisper } from "@/lib/transcription/chunk-audio";

const FIXTURE = path.join(__dirname, "..", "fixtures", "sample.mp3");
const tempRoots: string[] = [];

function hasFfmpeg(): boolean {
    return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
}

function isOggMagic(buffer: Buffer): boolean {
    return buffer.subarray(0, 4).toString("ascii") === "OggS";
}

afterEach(async () => {
    await Promise.all(
        tempRoots
            .splice(0)
            .map((root) => rm(root, { recursive: true, force: true })),
    );
});

const itIfFfmpeg = hasFfmpeg() ? it : it.skip;

describe("chunkAudioForWhisper", () => {
    itIfFfmpeg(
        "returns multiple ordered Ogg/Opus chunks and removes its work directory",
        async () => {
            const root = await mkdtemp(
                path.join(tmpdir(), "riffado-test-root-"),
            );
            tempRoots.push(root);
            const fixture = await readFile(FIXTURE);

            const chunks = await chunkAudioForWhisper(fixture, {
                segmentSeconds: 0.25,
                tempRoot: root,
            });

            expect(chunks.length).toBeGreaterThan(1);
            expect(chunks.every(isOggMagic)).toBe(true);
            expect(await readdir(root)).toEqual([]);
        },
        15_000,
    );

    itIfFfmpeg(
        "removes its work directory when ffmpeg rejects invalid audio",
        async () => {
            const root = await mkdtemp(
                path.join(tmpdir(), "riffado-test-root-"),
            );
            tempRoots.push(root);

            await expect(
                chunkAudioForWhisper(Buffer.from("not audio"), {
                    tempRoot: root,
                }),
            ).rejects.toThrow(/ffmpeg/i);
            expect(await readdir(root)).toEqual([]);
        },
        15_000,
    );
});
