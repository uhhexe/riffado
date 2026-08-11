import { describe, expect, it, vi } from "vitest";
import { InFlightByKey } from "@/lib/transcription/in-flight";

describe("InFlightByKey", () => {
    it("shares one task for concurrent calls with the same key", async () => {
        const inFlight = new InFlightByKey<number>();
        let release: ((value: number) => void) | undefined;
        const task = vi.fn(
            () =>
                new Promise<number>((resolve) => {
                    release = resolve;
                }),
        );

        const first = inFlight.run("user:recording", task);
        const second = inFlight.run("user:recording", task);
        await Promise.resolve();
        release?.(42);

        await expect(first).resolves.toBe(42);
        await expect(second).resolves.toBe(42);
        expect(task).toHaveBeenCalledOnce();
    });

    it("allows different recordings to run independently", async () => {
        const inFlight = new InFlightByKey<string>();
        const taskA = vi.fn().mockResolvedValue("a");
        const taskB = vi.fn().mockResolvedValue("b");

        await expect(
            Promise.all([
                inFlight.run("user:a", taskA),
                inFlight.run("user:b", taskB),
            ]),
        ).resolves.toEqual(["a", "b"]);
        expect(taskA).toHaveBeenCalledOnce();
        expect(taskB).toHaveBeenCalledOnce();
    });

    it("clears the key after success and failure so later retries can run", async () => {
        const inFlight = new InFlightByKey<number>();
        const task = vi
            .fn<() => Promise<number>>()
            .mockResolvedValueOnce(1)
            .mockRejectedValueOnce(new Error("failed"))
            .mockResolvedValueOnce(3);

        await expect(inFlight.run("key", task)).resolves.toBe(1);
        await expect(inFlight.run("key", task)).rejects.toThrow("failed");
        await expect(inFlight.run("key", task)).resolves.toBe(3);
        expect(task).toHaveBeenCalledTimes(3);
    });
});
