// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebIqClient, WebIqTransientError } from "./webIqClient.js";

describe("WebIqClient", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("MOVIE_CHAT_LOG_RETRIEVAL_DETAILS", undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("balances initial evidence across queries before applying the source cap", async () => {
    const response = (prefix: string) => Response.json({
      results: Array.from({ length: 3 }, (_, index) => ({
        evidence: { type: "text", content: `${prefix} fact ${index}` },
        citations: [{ title: `${prefix} ${index}`, url: `https://example.com/${prefix}-${index}` }],
      })),
    });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response("ranking"))
      .mockResolvedValueOnce(response("grosses")));
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 3)
      .search([{ query: "ranking" }, { query: "grosses" }]);
    expect(result.sources.map(({ query }) => query)).toEqual(["ranking", "grosses", "ranking"]);
    expect(result.sources.map(({ id }) => id)).toEqual([1, 2, 3]);
  });

  it("combines different facts returned for the same URL in the initial batch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, options) => {
      const { query } = JSON.parse(options.body);
      return Response.json({
        results: [{
          evidence: { type: "text", content: `${query} synthetic fact.` },
          citations: [{ title: "Shared page", url: "https://example.com/shared" }],
        }],
      });
    }));
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "cast" }, { query: "gross" }]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.content).toContain("cast synthetic fact.");
    expect(result.sources[0]!.content).toContain("gross synthetic fact.");
    expect(result.sources[0]!.passages?.map(({ query }) => query)).toEqual(["cast", "gross"]);
  });

  it("authenticates with an Entra bearer token without sending an API key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          traceId: "auto-trace-1",
          results: [
            {
              evidence: { type: "text", content: "Critics praised the movie." },
              citations: [{
                title: "Arrival reviews",
                url: "https://example.com/arrival",
                lastUpdatedAt: "2026-10-10",
              }],
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokenProvider = vi.fn().mockResolvedValue("test-access-token");
    const client = new WebIqClient(
      tokenProvider,
      "https://api.microsoft.ai/v3",
      18000,
      12,
    );
    const result = await client.search([{ query: "Arrival reviews" }]);

    expect(tokenProvider).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.microsoft.ai/v3/auto");
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toEqual({
      query: "Arrival reviews",
      mode: "lite",
      contentType: "passage",
      maxLength: 3000,
      maxResponseLength: 18000,
      responseFilter: ["web", "news", "images", "videos"],
      language: "en",
      region: "US",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer test-access-token",
      "content-type": "application/json",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("x-apikey");
    expect(result.sources[0]?.title).toBe("Arrival reviews");
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]?.query).toBe("Arrival reviews");
    expect(result.calls[0]?.autoMode).toBe("lite");
    expect(result.calls[0]?.traceId).toBe("auto-trace-1");
    expect(result.calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(console.info).toHaveBeenCalledOnce();
    const log = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(log).toEqual({
      event: "webiq_request",
      timestamp: expect.any(String),
      level: "info",
      operation: "auto",
      autoMode: "lite",
      status: 200,
      traceId: "auto-trace-1",
      outcome: "success",
      durationMs: expect.any(Number),
      attempt: 1,
      resultCount: 1,
      sourceCount: 1,
      query: "Arrival reviews",
    });
    expect(JSON.stringify(log)).not.toMatch(/test-access-token|Critics praised/);
  });

  it("uses the provider's current token on each request so refreshed tokens reach Web IQ", async () => {
    const tokenProvider = vi.fn()
      .mockResolvedValueOnce("first-access-token")
      .mockResolvedValueOnce("refreshed-access-token");
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WebIqClient(tokenProvider, "https://api.microsoft.ai/v3", 18000, 30);

    await client.search([{ query: "Arrival reviews" }]);
    await client.search([{ query: "Arrival cast" }]);

    expect(fetchMock.mock.calls.map(([, options]) => options.headers.Authorization))
      .toEqual(["Bearer first-access-token", "Bearer refreshed-access-token"]);
  });

  it("fails closed on token acquisition errors and logs no credential details", async () => {
    vi.stubEnv("WEBIQ_API_KEY", "unused-api-key");
    const tokenProvider = vi.fn().mockRejectedValue(new Error("private certificate details"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new WebIqClient(tokenProvider, "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie" }])).rejects.toThrow();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
    const log = JSON.parse(vi.mocked(console.error).mock.calls[0]![0] as string);
    expect(log).toMatchObject({
      status: null, traceId: null, outcome: "error", errorType: "Error",
    });
    expect(JSON.stringify(log)).not.toMatch(/private certificate|unused-api-key/);
  });

  it("forwards mixed Auto modes and keeps them paired with queries and trace IDs in parallel", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ traceId: "review-trace", results: [] }))
      .mockResolvedValueOnce(Response.json({ traceId: "cast-trace", results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
      .search([
        { query: "Arrival reviews", autoMode: "advanced" },
        { query: "Arrival cast", autoMode: "lite" },
      ]);
    expect(fetchMock.mock.calls.map(([, options]) => {
      const { query, mode, contentType, maxLength } = JSON.parse(options.body);
      return { query, mode, contentType, maxLength };
    })).toEqual([
      { query: "Arrival reviews", mode: "advanced", contentType: "passage", maxLength: 3000 },
      { query: "Arrival cast", mode: "lite", contentType: "passage", maxLength: 3000 },
    ]);
    expect(result.calls.map(({ query, autoMode, traceId }) => ({ query, autoMode, traceId }))).toEqual([
      { query: "Arrival reviews", autoMode: "advanced", traceId: "review-trace" },
      { query: "Arrival cast", autoMode: "lite", traceId: "cast-trace" },
    ]);
    expect(vi.mocked(console.info).mock.calls.map(([line]) => {
      const { query, autoMode, traceId } = JSON.parse(line as string);
      return { query, autoMode, traceId };
    })).toEqual([
      { query: "Arrival reviews", autoMode: "advanced", traceId: "review-trace" },
      { query: "Arrival cast", autoMode: "lite", traceId: "cast-trace" },
    ]);
  });

  it("never logs returned citation URLs, including filtered and truncated sources", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      results: [
        {
          evidence: { type: "text", content: "Private evidence body" },
          citations: [
            { title: "First", url: "https://example.com/first?edition=2026" },
            { title: "Duplicate", url: "https://example.com/first?edition=2026" },
            { title: "Second", url: "https://example.com/second" },
            { title: "Unsafe", url: "javascript:alert(1)" },
            { title: "Credentials", url: "https://user:secret@example.com/private" },
          ],
        },
        {
          evidence: { type: "structured/weather", content: {} },
          citations: [{ title: "Unsupported evidence", url: "https://example.com/weather" }],
        },
      ],
    })));
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 1)
      .search([{ query: "movie" }]);
    expect(result.sources).toHaveLength(1);
    const log = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(log).not.toHaveProperty("returnedUrls");
    expect(JSON.stringify(log)).not.toMatch(/example\.com|Private evidence|javascript:|user:secret/);
  });

  it.each([
    {
      name: "HTTP failure",
      response: () => Response.json({ traceId: "invalid-request-trace", message: "private upstream details" }, { status: 400 }),
      status: 400, traceId: "invalid-request-trace",
    },
    {
      name: "invalid results",
      response: () => Response.json({ traceId: "invalid-results-trace", results: "invalid" }),
      status: 200, traceId: "invalid-results-trace",
    },
    {
      name: "non-JSON body",
      response: () => new Response("<html>private upstream details</html>"),
      status: 200, traceId: null,
    },
  ])("logs a $name with safe error metadata", async ({ response, status, traceId }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    await expect(new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie" }])).rejects.toThrow();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
    const log = JSON.parse(vi.mocked(console.error).mock.calls[0]![0] as string);
    expect(log).toMatchObject({
      event: "webiq_request", level: "error", status, traceId,
      outcome: "error", errorType: "Error", query: "movie",
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(log)).not.toMatch(/test-access-token|private upstream details/);
  });

  it("logs network failures when no upstream status or trace ID is available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("private URL", "TimeoutError")));
    await expect(new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie" }])).rejects.toThrow();
    expect(console.error).toHaveBeenCalledOnce();
    const log = JSON.parse(vi.mocked(console.error).mock.calls[0]![0] as string);
    expect(log).toMatchObject({
      status: null, traceId: null, outcome: "error", errorType: "TimeoutError", query: "movie",
    });
    expect(JSON.stringify(log)).not.toContain("private URL");
  });

  it("omits query and URL details when disabled, retaining operational metadata", async () => {
    vi.stubEnv("MOVIE_CHAT_LOG_RETRIEVAL_DETAILS", "false");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      traceId: "safe-trace",
      results: [{
        evidence: { type: "text", content: "Private evidence" },
        citations: [{ title: "Private source", url: "https://example.com/private-url" }],
      }],
    })));
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "private query" }]);
    expect(result.sources).toHaveLength(1);
    const log = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(log).toMatchObject({
      traceId: "safe-trace", status: 200, outcome: "success", resultCount: 1, sourceCount: 1,
    });
    expect(log).not.toHaveProperty("query");
    expect(log).not.toHaveProperty("returnedUrls");
    expect(JSON.stringify(log)).not.toMatch(/private query|private-url|Private evidence/);
  });

  it("preserves Web and News citation categories without guessing missing or invalid metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      results: [{
        evidence: { type: "text", content: "Movie coverage." },
        citations: [
          { title: "Web review", url: "https://example.com/review", contentSource: "web" },
          { title: "Missing category", url: "https://example.com/missing" },
          { title: "Invalid category", url: "https://example.com/invalid", contentSource: { type: "news" } },
        ],
      }, {
        evidence: {
          type: "text/news",
          content: "Recent movie news.",
          thumbnail: { url: "https://example.com/thumbnail.jpg", width: 320, height: 180 },
        },
        citations: [{
          title: "News article", url: "https://example.com/news", contentSource: "news",
          lastUpdatedAt: "2026-11-17",
        }],
      }],
    })));
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie coverage" }]);
    expect(result.sources.map(({ title, contentSource }) => ({ title, contentSource }))).toEqual([
      { title: "Web review", contentSource: "web" },
      { title: "Missing category", contentSource: undefined },
      { title: "Invalid category", contentSource: undefined },
      { title: "News article", contentSource: "news" },
    ]);
    expect(result.sources[3]).toMatchObject({
      content: "Recent movie news.", query: "movie coverage", updatedAt: "2026-11-17",
    });
    expect(result.sources[3]).not.toHaveProperty("media");
  });

  it.each(["", "   ", {}, null])("omits malformed news content: %j", async (content) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      results: [{
        evidence: { type: "text/news", content },
        citations: [{ title: "News article", url: "https://example.com/news", contentSource: "news" }],
      }],
    })));
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie news" }]);
    expect(result.sources).toEqual([]);
  });

  it("caps long source passages at 3,000 characters without dropping their citations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      results: [{
        evidence: { type: "text", content: "A".repeat(3000) + "Additional document content." },
        citations: [{ title: "Movie review", url: "https://example.com/review" }],
      }],
    })));
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie review" }]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]).toMatchObject({
      title: "Movie review",
      url: "https://example.com/review",
      content: "A".repeat(3000),
    });
  });

  it("pairs typed evidence with its own citations and preserves media when URLs overlap", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      results: [
        {
          evidence: { type: "text", content: "A film trailer." },
          citations: [{ title: "Trailer page", url: "https://www.youtube.com/watch?v=BUc12TDLw-w" }],
        },
        {
          evidence: {
            type: "media/video",
            content: { embeddingUrl: "https://www.youtube.com/embed/BUc12TDLw-w", allowHttpsEmbedding: true },
          },
          citations: [{ title: "Trailer", url: "https://www.youtube.com/watch?v=BUc12TDLw-w" }],
        },
        {
          evidence: {
            type: "media/image",
            content: { caption: "A movie poster.", thumbnailUrl: "https://images.example.com/preview.jpg" },
          },
          citations: [{
            title: "Jaws poster",
            url: "https://images.example.com/jaws.jpg",
            hostPageUrl: "https://example.com/jaws",
          }],
        },
        {
          evidence: { type: "text", content: "Different evidence." },
          citations: [
            { title: "Second claim", url: "https://example.com/second" },
            { title: "Another supporting source", url: "https://example.com/third" },
          ],
        },
      ],
    })));
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3/", 18000, 30)
      .search([{ query: "movie media" }]);
    expect(result.sources).toHaveLength(4);
    expect(result.sources[0]).toMatchObject({
      id: 1, content: expect.stringContaining("A film trailer."),
      media: { type: "video", embeddingUrl: "https://www.youtube.com/embed/BUc12TDLw-w" },
    });
    expect(result.sources[1]).toMatchObject({
      id: 2, title: "Jaws poster", url: "https://example.com/jaws",
      media: {
        type: "image", imageUrl: "https://images.example.com/jaws.jpg",
        thumbnailUrl: "https://images.example.com/preview.jpg",
      },
    });
    expect(result.sources.slice(2).map(({ content }) => content))
      .toEqual(["Different evidence.", "Different evidence."]);
  });

  it("omits adult, malformed and unsupported evidence and respects embedding restrictions", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      results: [
        null,
        { evidence: { type: "structured/weather", content: {} }, citations: [] },
        { evidence: { type: "text", content: {} }, citations: [{ title: "Bad", url: "https://example.com" }] },
        { evidence: { type: "text", content: "Adult" }, citations: [{ title: "Adult", url: "https://example.com", isAdult: true }] },
        { evidence: { type: "text", content: "Unsafe" }, citations: [{ title: "Unsafe", url: "javascript:alert(1)" }] },
        {
          evidence: { type: "media/video", content: { allowHttpsEmbedding: false, embeddingUrl: "https://www.youtube.com/embed/BUc12TDLw-w" } },
          citations: [{ title: "Non-embeddable video", url: "https://example.com/video" }],
        },
      ],
    })));
    const result = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie" }]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.media).toEqual({ type: "video" });
  });

  it("distinguishes an empty search from an unexpected response contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(Response.json({ webResults: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30);
    expect((await client.search([{ query: "no matches" }])).sources).toEqual([]);
    await expect(client.search([{ query: "wrong contract" }])).rejects.toThrow("invalid results array");
  });

  describe("rate limiting and retries", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
      vi.spyOn(Math, "random").mockReturnValue(0);
    });

    it.each([
      { name: "body duration", retryAfter: "2s", headers: {}, milliseconds: 2_000 },
      { name: "body timestamp", retryAfter: "2026-01-01T12:00:02Z", headers: {}, milliseconds: 2_000 },
      { name: "header seconds", retryAfter: undefined, headers: { "Retry-After": "2" }, milliseconds: 2_000 },
      { name: "header date", retryAfter: undefined, headers: { "Retry-After": "Thu, 01 Jan 2026 12:00:02 GMT" }, milliseconds: 2_000 },
      { name: "longer body hint", retryAfter: "3s", headers: { "Retry-After": "2" }, milliseconds: 3_000 },
      { name: "longer header hint", retryAfter: "2s", headers: { "Retry-After": "3" }, milliseconds: 3_000 },
      { name: "invalid hint", retryAfter: "not a delay", headers: {}, milliseconds: 1_000 },
      { name: "negative hint", retryAfter: "-2s", headers: {}, milliseconds: 1_000 },
    ])("waits for the $name before retrying and records every attempt", async ({ retryAfter, headers, milliseconds }) => {
      const responseHeaders = new Headers();
      if (headers["Retry-After"]) responseHeaders.set("Retry-After", headers["Retry-After"]);
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(Response.json({
          errorCode: "AuthUserThrottled", retryAfter, traceId: "throttled-trace",
          technicalDetails: "private details",
        }, { status: 429, headers: responseHeaders }))
        .mockResolvedValueOnce(Response.json({ results: [], traceId: "success-trace" }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30);
      const pending = client.search([{ query: "movie" }]);
      await vi.advanceTimersByTimeAsync(milliseconds - 1);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.calls).toMatchObject([
        { query: "movie", attempt: 1, status: 429, traceId: "throttled-trace" },
        { query: "movie", attempt: 2, status: 200, traceId: "success-trace" },
      ]);
      expect(result.calls[1]!.durationMs).toBeGreaterThanOrEqual(milliseconds);
      expect(console.error).toHaveBeenCalledOnce();
      expect(console.info).toHaveBeenCalledOnce();
      expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toMatch(/private details|test-access-token/);
    });

    it("uses increasing backoff with jitter and stops after three attempts", async () => {
      vi.mocked(Math.random).mockReturnValue(0.5);
      const fetchMock = vi.fn().mockImplementation(async () => Response.json({}, { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30);
      const failure = expect(client.search([{ query: "movie" }])).rejects.toThrow("429");
      await vi.advanceTimersByTimeAsync(1_124);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2_124);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await failure;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("retries transient server errors using the documented 30-second fallback", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(Response.json({ errorCode: "InternalServerError" }, { status: 500 }))
        .mockResolvedValueOnce(Response.json({ results: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const pending = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
        .search([{ query: "movie" }]);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).calls).toHaveLength(2);
    });

    it.each(["AuthUserDailyUsageExceeded", "authuserdailyusageexceeded"])("logs %s and fails without retrying or waiting for midnight", async (errorCode) => {
      const fetchMock = vi.fn().mockImplementation(async () => Response.json({
        errorCode, retryAfter: "86400s", traceId: "daily-quota-trace",
        technicalDetails: "private upstream details",
      }, { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30);
      await expect(client.search([{ query: "movie" }])).rejects.toMatchObject({
        name: "WebIqDailyQuotaError", message: expect.stringContaining("daily request quota"),
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      await expect(client.search([{ query: "another movie" }])).rejects.toMatchObject({
        name: "WebIqDailyQuotaError",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(Date.now()).toBe(Date.parse("2026-01-01T12:00:00Z"));
      const logs = vi.mocked(console.error).mock.calls.map(([line]) => JSON.parse(line as string));
      expect(logs).toHaveLength(2);
      expect(logs[0]).toMatchObject({
        status: 429, traceId: "daily-quota-trace", outcome: "error", errorType: "WebIqDailyQuotaError",
      });
      expect(JSON.stringify(logs)).not.toContain("private upstream details");
      fetchMock.mockResolvedValueOnce(Response.json({ results: [] }));
      await client.search([{ query: "movie" }]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("fails promptly rather than shortening a retry hint beyond the time limit", async () => {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ retryAfter: "120s" }, { status: 429 }));
      vi.stubGlobal("fetch", fetchMock);
      await expect(new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
        .search([{ query: "movie" }])).rejects.toThrow("429");
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(Date.now()).toBe(Date.parse("2026-01-01T12:00:00Z"));
    });

    it("shares the throttle cooldown with subsequent searches even when no retry budget remains", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(Response.json({ retryAfter: "2s" }, { status: 429 }))
        .mockResolvedValueOnce(Response.json({ results: [] }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30);
      await expect(client.search([{ query: "movie" }], 1)).rejects.toThrow("429");
      const pending = client.search([{ query: "another movie" }]);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("caps concurrent HTTP requests across overlapping searches", async () => {
      const completions: Array<(response: Response) => void> = [];
      vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
        completions.push(resolve);
      })));
      const client = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30);
      const pending = Promise.all(["first", "second", "third"].map((query) => client.search([{ query }])));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(2);
      completions[0]!(Response.json({ results: [] }));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).toHaveBeenCalledTimes(3);
      completions[1]!(Response.json({ results: [] }));
      completions[2]!(Response.json({ results: [] }));
      await pending;
    });

    it("cancels retry waits when the batch timeout signal fires", async () => {
      const timeout = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async () =>
        Response.json({ retryAfter: "2s" }, { status: 429 })));
      const pending = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
        .search([{ query: "movie" }]);
      const failure = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(1_000);
      timeout.abort();
      await failure;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(fetch).toHaveBeenCalledOnce();
    });

    it("aborts sibling HTTP requests and never dispatches queued queries after a batch failure", async () => {
      let siblingSignal: AbortSignal | undefined;
      const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
        if (JSON.parse(options.body).query === "invalid") {
          return Response.json({}, { status: 400 });
        }
        siblingSignal = options.signal;
        return new Promise<Response>((_resolve, reject) => {
          siblingSignal!.addEventListener("abort", () => reject(siblingSignal!.reason), { once: true });
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      await expect(new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
        .search([{ query: "invalid" }, { query: "in flight" }, { query: "queued" }]))
        .rejects.toThrow("400");
      await vi.advanceTimersByTimeAsync(0);
      expect(siblingSignal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("carries all dispatched attempts on a transient batch failure, including aborted siblings", async () => {
      const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
        if (JSON.parse(options.body).query === "throttled") {
          return Response.json({}, { status: 429 });
        }
        return new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      });
      vi.stubGlobal("fetch", fetchMock);
      const failure = await new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
        .search([{ query: "throttled" }, { query: "in flight" }, { query: "queued" }], 3)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WebIqTransientError);
      expect((failure as WebIqTransientError).calls).toEqual([
        expect.objectContaining({ query: "throttled", status: 429, attempt: 1 }),
        expect.objectContaining({ query: "in flight", status: undefined, attempt: 1 }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("classifies a retrieval timeout as transient and counts its dispatched attempt", async () => {
      const timeout = new AbortController();
      vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, options) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        })));
      const pending = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
        .search([{ query: "movie" }]);
      const failure = expect(pending).rejects.toMatchObject({
        name: "WebIqTransientError",
        calls: [{ query: "movie", autoMode: "lite", attempt: 1,
          durationMs: expect.any(Number), traceId: undefined, status: undefined }],
      });
      await vi.advanceTimersByTimeAsync(0);
      timeout.abort(new DOMException("Retrieval timeout", "TimeoutError"));
      await failure;
      expect(fetch).toHaveBeenCalledOnce();
    });

    it.each([
      { status: 429, payload: { errorCode: "AuthUserDailyUsageExceeded" }, name: "WebIqDailyQuotaError" },
      { status: 401, payload: {}, name: "Error" },
    ])("does not mask a concurrent $name with transient throttling", async ({ status, payload, name }) => {
      vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, options) =>
        JSON.parse(options.body).query === "throttled"
          ? Response.json({}, { status: 429 })
          : Response.json(payload, { status })));
      await expect(new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
        .search([{ query: "throttled" }, { query: "permanent" }], 2))
        .rejects.toMatchObject({ name });
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it("reserves initial attempts for every query within the shared call budget", async () => {
      const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
        const { query } = JSON.parse(options.body);
        return query === "throttled" ? Response.json({}, { status: 429 }) : Response.json({ results: [] });
      });
      vi.stubGlobal("fetch", fetchMock);
      const client = new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30);
      const failure = expect(client.search([{ query: "throttled" }, { query: "other" }], 3))
        .rejects.toThrow("429");
      await vi.advanceTimersByTimeAsync(1_000);
      await failure;
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).query).sort())
        .toEqual(["other", "throttled", "throttled"]);
    });

    it.each([400, 401, 403])("does not retry HTTP %i", async (status) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({}, { status })));
      await expect(new WebIqClient(async () => "test-access-token", "https://api.microsoft.ai/v3", 18000, 30)
        .search([{ query: "movie" }])).rejects.toThrow(String(status));
      expect(fetch).toHaveBeenCalledOnce();
    });
  });
});
