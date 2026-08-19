/**
 * Regression: an expired Plaud user token stayed invisible for days.
 *
 * Once the stored UT ages out, POST /user-app/auth/workspace/token/{wsid}
 * answers 401. `PlaudClient.fetchWorkspaceToken` caught that and set
 * `workspaceFallbackToUt = true` unconditionally, but the recording endpoints
 * (/file/simple/web, /device/list) require the WT and answer 200-with-an-empty
 * -list under a UT. So sync kept reporting success: `invalidatedAt` stayed
 * NULL, `lastSync` kept advancing, and zero recordings arrived. Observed live
 * as two full days of five-minute "successful" syncs on a connection row that
 * looked perfectly healthy.
 *
 * A 401 is now propagated as PLAUD_INVALID_TOKEN so the existing sync-level
 * handler stamps `invalidatedAt` and the reconnect banner fires. The UT
 * fallback survives for non-auth failures (workspace unavailable, upstream
 * 5xx), which is what keeps pasted-workspace-token accounts (#203) working.
 *
 * Also pins the deliberate no-relist-on-401 decision in `resolveWorkspaceToken`
 * (see the comment in `mintPlaudWorkspaceToken`): a relist rides on the same
 * dead UT, and its generic list error would mask the one signal that triggers
 * reconnect.
 */

import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from "vitest";

vi.mock("@/lib/env", () => ({
    env: {
        DEFAULT_STORAGE_TYPE: "local",
        ENCRYPTION_KEY:
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        WEBSHARE_API_KEY: undefined,
    },
}));

vi.mock("@/db", () => ({
    db: {
        select: vi.fn(),
        insert: vi.fn(),
        update: vi.fn(),
        transaction: vi.fn(),
    },
}));

vi.mock("@/lib/plaud/client-factory", () => ({
    createPlaudClient: vi.fn(),
}));

vi.mock("@/lib/storage/factory", () => ({
    createUserStorageProvider: vi.fn().mockResolvedValue({
        uploadFile: vi.fn().mockResolvedValue(undefined),
        downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio-data")),
    }),
}));

vi.mock("@/lib/notifications/bark", () => ({
    sendNewRecordingBarkNotification: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/notifications/email", () => ({
    sendNewRecordingEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/transcription/transcribe-recording", () => ({
    transcribeRecording: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("@/lib/webhooks/emit", () => ({
    emitEvent: vi.fn().mockResolvedValue(undefined),
}));

import { db } from "@/db";
import { AppError, ErrorCode } from "@/lib/errors";
import { PlaudClient } from "@/lib/plaud/client";
import { createPlaudClient } from "@/lib/plaud/client-factory";
import { syncRecordingsForUser } from "@/lib/sync/sync-recordings";

const originalFetch = global.fetch;
let mockFetch: Mock;

beforeAll(() => {
    mockFetch = vi.fn() as Mock;
    global.fetch = mockFetch as typeof global.fetch;
});

afterAll(() => {
    global.fetch = originalFetch;
});

beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
});

const UT = "ut.user.token";
const WT = "wt.workspace.token";
const API_BASE = "https://api-euc1.plaud.ai";
const WORKSPACE_ID = "ws_cKyt7F2Iec";
const USER_ID = "user-wt401";

interface MockResponseInit {
    ok?: boolean;
    status?: number;
    body: unknown;
}

function mockResponse({ ok = true, status = 200, body }: MockResponseInit): {
    ok: boolean;
    status: number;
    statusText: string;
    headers: { get: () => null };
    json: () => Promise<unknown>;
    text: () => Promise<string>;
} {
    const serialised = JSON.stringify(body);
    return {
        ok,
        status,
        statusText: ok ? "OK" : "Error",
        headers: { get: () => null },
        json: () => Promise.resolve(body),
        // `safeParseJson` consumes the body via `.text()`; see #142.
        text: () => Promise.resolve(serialised),
    };
}

/** 401 from the workspace-token mint: the stored UT is dead. */
function mintUnauthorized() {
    return mockResponse({
        ok: false,
        status: 401,
        body: { status: 401, msg: "token expired" },
    });
}

function workspaceListResponse(workspaceId: string) {
    return mockResponse({
        body: {
            status: 0,
            data: {
                workspaces: [
                    {
                        workspace_id: workspaceId,
                        member_id: "mem_x",
                        name: "Personal",
                        role: "admin",
                        status: "active",
                        workspace_type: "0",
                    },
                ],
            },
        },
    });
}

function workspaceTokenResponse(workspaceToken: string) {
    return mockResponse({
        body: {
            status: 0,
            data: {
                status: 0,
                workspace_token: workspaceToken,
                expires_in: 86400,
                workspace_id: WORKSPACE_ID,
                member_id: "mem_x",
                role: "admin",
            },
        },
    });
}

/** What /file/simple/web actually returns under a UT: 200, empty list. */
function emptyRecordingsResponse() {
    return mockResponse({
        body: {
            status: 0,
            msg: "success",
            data_file_total: 0,
            data_file_list: [],
        },
    });
}

function urlFromCall(call: unknown[]): string {
    const u = call[0];
    return u instanceof URL ? u.href : String(u);
}

function calledUrls(): string[] {
    return mockFetch.mock.calls.map(urlFromCall);
}

// ── Client: a 401 on WT mint is surfaced, not degraded ──────────────────────

describe("PlaudClient: 401 on workspace-token mint surfaces as PLAUD_INVALID_TOKEN", () => {
    it("throws instead of falling back to the user token (cached workspace id)", async () => {
        mockFetch.mockResolvedValueOnce(mintUnauthorized());

        const client = new PlaudClient(UT, API_BASE, WORKSPACE_ID);
        const err = await client.getRecordings(0, 10).catch((e) => e);

        expect(err).toBeInstanceOf(AppError);
        expect(err).toMatchObject({
            code: ErrorCode.PLAUD_INVALID_TOKEN,
            statusCode: 401,
        });

        // The whole bug: never degrade into the mode that answers with an
        // empty list. No recordings call, and no UT fallback flag.
        expect(calledUrls().some((u) => u.includes("/file/simple/web"))).toBe(
            false,
        );
        expect(client.usingUserTokenFallback).toBe(false);
    });

    it("does not relist workspaces on a 401 (a relist rides the same dead UT)", async () => {
        mockFetch.mockResolvedValueOnce(mintUnauthorized());

        const client = new PlaudClient(UT, API_BASE, WORKSPACE_ID);
        await client.getRecordings(0, 10).catch(() => undefined);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(urlFromCall(mockFetch.mock.calls[0])).toContain(
            `/user-app/auth/workspace/token/${WORKSPACE_ID}`,
        );
        expect(
            calledUrls().some((u) => u.includes("/team-app/workspaces/list")),
        ).toBe(false);
    });

    it("throws with no cached workspace id too (list ok, mint 401)", async () => {
        mockFetch
            .mockResolvedValueOnce(workspaceListResponse(WORKSPACE_ID))
            .mockResolvedValueOnce(mintUnauthorized());

        const client = new PlaudClient(UT, API_BASE);
        const err = await client.getRecordings(0, 10).catch((e) => e);

        expect(err).toMatchObject({ code: ErrorCode.PLAUD_INVALID_TOKEN });
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(calledUrls().some((u) => u.includes("/file/simple/web"))).toBe(
            false,
        );
    });

    it("keeps surfacing the 401 on later calls (never latches into fallback)", async () => {
        mockFetch
            .mockResolvedValueOnce(mintUnauthorized())
            .mockResolvedValueOnce(mintUnauthorized());

        const client = new PlaudClient(UT, API_BASE, WORKSPACE_ID);
        const first = await client.getRecordings(0, 10).catch((e) => e);
        const second = await client.listDevices().catch((e) => e);

        expect(first).toMatchObject({ code: ErrorCode.PLAUD_INVALID_TOKEN });
        expect(second).toMatchObject({ code: ErrorCode.PLAUD_INVALID_TOKEN });
        expect(client.usingUserTokenFallback).toBe(false);
        expect(calledUrls().some((u) => u.includes("/device/list"))).toBe(
            false,
        );
    });

    it("still falls back to the user token on a non-auth mint failure", async () => {
        // 500 on mint is recoverable-ish and must keep the pre-existing
        // behavior (#66 case 4, and pasted-WT accounts from #203).
        mockFetch
            .mockResolvedValueOnce(
                mockResponse({
                    ok: false,
                    status: 500,
                    body: { status: 500, msg: "server error" },
                }),
            )
            .mockResolvedValueOnce(emptyRecordingsResponse());

        const client = new PlaudClient(UT, API_BASE, WORKSPACE_ID);
        const result = await client.getRecordings(0, 10);

        expect(result.data_file_total).toBe(0);
        expect(client.usingUserTokenFallback).toBe(true);
        expect(calledUrls().some((u) => u.includes("/file/simple/web"))).toBe(
            true,
        );
    });
});

// ── Sync: the 401 reaches the DB as `invalidatedAt` ─────────────────────────

function mockConnectionSelects() {
    const mockConnection = {
        id: "conn-wt401",
        userId: USER_ID,
        bearerToken: "encrypted-token",
        apiBase: API_BASE,
        workspaceId: WORKSPACE_ID,
    };
    (db.select as Mock)
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([mockConnection]),
                }),
            }),
        })
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi.fn().mockResolvedValue([{ id: "settings-1" }]),
                }),
            }),
        })
        .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                    limit: vi
                        .fn()
                        .mockResolvedValue([{ email: "test@example.com" }]),
                }),
            }),
        });
}

/**
 * Drive sync through a REAL PlaudClient over mocked fetch, so the
 * client -> sync wiring is what's under test rather than a stubbed client.
 */
function useRealPlaudClient() {
    (createPlaudClient as Mock).mockImplementation(
        async (
            _encryptedToken: string,
            apiBase: string,
            workspaceId?: string | null,
        ) => new PlaudClient(UT, apiBase, workspaceId ?? undefined),
    );
}

describe("sync: an expired token stops reporting healthy syncs", () => {
    it("stamps invalidatedAt and never advances lastSync when the WT mint 401s", async () => {
        mockConnectionSelects();
        useRealPlaudClient();
        // The exact live signature: the mint 401s, and the recordings
        // endpoint answers 200-with-empty-list under the fallback UT. The old
        // code read that as a clean, empty sync.
        mockFetch
            .mockResolvedValueOnce(mintUnauthorized())
            .mockResolvedValue(emptyRecordingsResponse());

        const setSpy = vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
        });
        (db.update as Mock).mockReturnValue({ set: setSpy });

        const result = await syncRecordingsForUser(USER_ID);

        expect(result.needsReconnect).toBe(true);
        expect(setSpy).toHaveBeenCalledTimes(1);
        expect(setSpy).toHaveBeenCalledWith(
            expect.objectContaining({ invalidatedAt: expect.any(Date) }),
        );

        // The silent-failure signature: a healthy-looking row. `lastSync`
        // must NOT advance, and `invalidatedAt` must NOT be cleared.
        const persisted = setSpy.mock.calls[0][0] as Record<string, unknown>;
        expect(persisted).not.toHaveProperty("lastSync");
        expect(persisted.invalidatedAt).not.toBeNull();

        expect(result.errors.some((e) => /reconnect/i.test(e))).toBe(true);
        expect(result.newRecordings).toBe(0);
    });

    it("reports usingUserTokenFallback when a non-auth failure yields an empty list", async () => {
        mockConnectionSelects();
        useRealPlaudClient();
        mockFetch
            .mockResolvedValueOnce(
                mockResponse({
                    ok: false,
                    status: 403,
                    body: { status: 403, msg: "workspace unavailable" },
                }),
            )
            // Relist + remint (403 is treated as a stale cached id), then the
            // recordings call that comes back empty under the UT.
            .mockResolvedValueOnce(workspaceListResponse(WORKSPACE_ID))
            .mockResolvedValueOnce(
                mockResponse({
                    ok: false,
                    status: 403,
                    body: { status: 403, msg: "workspace unavailable" },
                }),
            )
            .mockResolvedValue(emptyRecordingsResponse());

        (db.update as Mock).mockReturnValue({
            set: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(undefined),
            }),
        });

        const result = await syncRecordingsForUser(USER_ID);

        // Not an auth failure, so no reconnect prompt -- but the empty result
        // is reported as "may have missed recordings", not "nothing new".
        expect(result.needsReconnect).toBeFalsy();
        expect(result.usingUserTokenFallback).toBe(true);
        expect(
            result.errors.some((e) => /may have missed recordings/i.test(e)),
        ).toBe(true);
    });

    it("leaves a healthy WT sync untouched", async () => {
        mockConnectionSelects();
        useRealPlaudClient();
        mockFetch
            .mockResolvedValueOnce(workspaceTokenResponse(WT))
            .mockResolvedValue(emptyRecordingsResponse());

        const setSpy = vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
        });
        (db.update as Mock).mockReturnValue({ set: setSpy });

        const result = await syncRecordingsForUser(USER_ID);

        expect(result.needsReconnect).toBeFalsy();
        expect(result.usingUserTokenFallback).toBeFalsy();
        expect(result.errors).toEqual([]);
        expect(setSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                lastSync: expect.any(Date),
                invalidatedAt: null,
            }),
        );
    });
});
