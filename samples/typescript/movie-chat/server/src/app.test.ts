// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import type { MovieChatService } from "./movieChatService.js";
import { emptyPreferences } from "./types.js";
import { WebIqClient } from "./webIqClient.js";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createApp", () => {
  it("returns a chat response from the service", async () => {
    const chat = vi.fn().mockResolvedValue({
      sessionId: "session-1",
      message: "Try Arrival [1].",
      preferences: emptyPreferences(),
      webIqQueries: [
        {
          query: "science fiction movies similar to Arrival",
          purpose: "Find relevant recommendations.",
          iteration: 1,
        },
      ],
      debug: {
        modelCalls: [
          {
            stage: "query_planning",
            purpose: "Plan focused Web IQ retrieval queries.",
            iteration: 1,
            durationMs: 120,
          },
          {
            stage: "answer_generation",
            purpose: "Generate the grounded conversational response.",
            durationMs: 640,
          },
        ],
        webIqCalls: [
          {
            query: "science fiction movies similar to Arrival",
            purpose: "Find relevant recommendations.",
            iteration: 1,
            durationMs: 240,
            traceId: "review-trace",
          },
        ],
        evidence: [{
          id: 1, title: "Arrival review", url: "https://example.com/arrival",
          content: "Review passage.", query: "science fiction movies similar to Arrival",
        }],
        totals: {
          modelCalls: 2,
          webIqCalls: 1,
          modelDurationMs: 760,
          webIqDurationMs: 240,
        },
      },
      sources: [],
    });
    const service = {
      chat,
      deleteSession: vi.fn(),
    } as unknown as MovieChatService;

    const response = await request(createApp(service))
      .post("/api/chat")
      .send({ message: "Recommend a science-fiction movie." });

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe("session-1");
    expect(response.body.webIqQueries).toHaveLength(1);
    expect(response.body.debug.webIqCalls[0].traceId).toBe("review-trace");
    expect(response.body.debug.evidence[0].content).toBe("Review passage.");
    expect(response.body.debug.totals).toEqual({
      modelCalls: 2,
      webIqCalls: 1,
      modelDurationMs: 760,
      webIqDurationMs: 240,
    });
    expect(chat).toHaveBeenCalledWith(
      undefined,
      "Recommend a science-fiction movie.",
    );
    const log = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(log).toMatchObject({
      event: "api_request",
      requestId: response.headers["x-request-id"],
      method: "POST",
      route: "/api/chat",
      status: 200,
      modelCalls: 2,
      webIqCalls: 1,
      modelDurationMs: 760,
      webIqDurationMs: 240,
      durationMs: expect.any(Number),
    });
    expect(log.requestId).toBeTruthy();
    expect(JSON.stringify(log)).not.toMatch(/science.fiction|session-1|Arrival/);
  });

  it("rejects an empty message without calling the service", async () => {
    const chat = vi.fn();
    const service = {
      chat,
      deleteSession: vi.fn(),
    } as unknown as MovieChatService;

    const response = await request(createApp(service))
      .post("/api/chat")
      .send({ message: "   " });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("message is required.");
    expect(chat).not.toHaveBeenCalled();
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string).status).toBe(400);
  });

  it("correlates concurrent retrieval logs even when later answer generation fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("MOVIE_CHAT_LOG_RETRIEVAL_DETAILS", "true");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, options: RequestInit) => {
      const { query } = JSON.parse(options.body as string) as { query: string };
      await new Promise((resolve) => setTimeout(resolve, query === "Arrival" ? 10 : 0));
      return Response.json({ traceId: `${query}-trace`, results: [] });
    }));
    const webIq = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30);
    const service = {
      chat: vi.fn(async (_sessionId: string | undefined, message: string) => {
        await webIq.search([{ query: message }]);
        if (message === "Arrival") throw new Error("private answer-generation failure");
        return { message: "Done.", debug: { totals: {} } };
      }),
    } as unknown as MovieChatService;
    const app = createApp(service);
    const [arrival, jaws] = await Promise.all([
      request(app).post("/api/chat").send({ message: "Arrival" }),
      request(app).post("/api/chat").send({ message: "Jaws" }),
    ]);
    expect(arrival.status).toBe(500);
    expect(jaws.status).toBe(200);
    expect(arrival.headers["x-request-id"]).not.toBe(jaws.headers["x-request-id"]);
    const retrievalLogs = vi.mocked(console.info).mock.calls
      .map(([line]) => JSON.parse(line as string))
      .filter(({ event }) => event === "webiq_request");
    expect(retrievalLogs).toHaveLength(2);
    expect(retrievalLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        query: "Arrival", traceId: "Arrival-trace",
        requestId: arrival.headers["x-request-id"], outcome: "success",
      }),
      expect.objectContaining({
        query: "Jaws", traceId: "Jaws-trace",
        requestId: jaws.headers["x-request-id"], outcome: "success",
      }),
    ]));
    expect(retrievalLogs.every((log) => !Object.hasOwn(log, "returnedUrls"))).toBe(true);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls))
      .not.toContain("private answer-generation failure");
  });

  it("explains a withheld answer without returning or logging rejected source text", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new Error("Private rejected source text");
    error.name = "ExcessiveCopyingError";
    const service = {
      chat: vi.fn().mockRejectedValue(error),
    } as unknown as MovieChatService;
    const response = await request(createApp(service))
      .post("/api/chat")
      .send({ message: "Summarize the reviews" });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "The answer was withheld because it copied too much source text. Please try asking for a shorter summary.",
    });
    expect(JSON.parse(errorLog.mock.calls[0]![0] as string).errorType).toBe("ExcessiveCopyingError");
    expect(JSON.stringify([errorLog.mock.calls, response.body])).not.toContain("Private rejected source text");
  });

  it("correlates failures without logging upstream error details", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = {
      chat: vi.fn().mockRejectedValue(new Error("secret-token and private prompt")),
    } as unknown as MovieChatService;
    const response = await request(createApp(service))
      .post("/api/chat")
      .send({ message: "A private movie request" });

    expect(response.status).toBe(500);
    expect(JSON.parse(errorLog.mock.calls[0]![0] as string)).toEqual({
      event: "api_error",
      timestamp: expect.any(String),
      level: "error",
      requestId: response.headers["x-request-id"],
      errorType: "Error",
    });
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string).status).toBe(500);
    expect(JSON.stringify([errorLog.mock.calls, response.body]))
      .not.toMatch(/secret-token|private prompt|private movie/);
  });
});
