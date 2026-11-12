// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WebIqClient } from "./webIqClient.js";

describe("WebIqClient", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("MOVIE_CHAT_LOG_RETRIEVAL_DETAILS", undefined);
  });

  afterEach(() => {
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
    const result = await new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 3)
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
    const result = await new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "cast" }, { query: "gross" }]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.content).toContain("cast synthetic fact.");
    expect(result.sources[0]!.content).toContain("gross synthetic fact.");
    expect(result.sources[0]!.passages?.map(({ query }) => query)).toEqual(["cast", "gross"]);
  });

  it("authenticates with the Web IQ API key", async () => {
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

    const client = new WebIqClient(
      "test-webiq-key",
      "https://api.microsoft.ai/v3",
      18000,
      12,
    );
    const result = await client.search([{ query: "Arrival reviews" }]);

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
      "x-apikey": "test-webiq-key",
      "content-type": "application/json",
    });
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
      resultCount: 1,
      sourceCount: 1,
      query: "Arrival reviews",
    });
    expect(JSON.stringify(log)).not.toMatch(/test-webiq-key|Critics praised/);
  });

  it("forwards mixed Auto modes and keeps them paired with queries and trace IDs in parallel", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ traceId: "review-trace", results: [] }))
      .mockResolvedValueOnce(Response.json({ traceId: "cast-trace", results: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 30)
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
    const result = await new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 1)
      .search([{ query: "movie" }]);
    expect(result.sources).toHaveLength(1);
    const log = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(log).not.toHaveProperty("returnedUrls");
    expect(JSON.stringify(log)).not.toMatch(/example\.com|Private evidence|javascript:|user:secret/);
  });

  it.each([
    {
      name: "HTTP failure",
      response: () => Response.json({ traceId: "rate-limit-trace", message: "private upstream details" }, { status: 429 }),
      status: 429, traceId: "rate-limit-trace",
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
    await expect(new WebIqClient("secret-api-key", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie" }])).rejects.toThrow();
    expect(console.info).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledOnce();
    const log = JSON.parse(vi.mocked(console.error).mock.calls[0]![0] as string);
    expect(log).toMatchObject({
      event: "webiq_request", level: "error", status, traceId,
      outcome: "error", errorType: "Error", query: "movie",
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(log)).not.toMatch(/secret-api-key|private upstream details/);
  });

  it("logs network failures when no upstream status or trace ID is available", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("private URL", "TimeoutError")));
    await expect(new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 30)
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
    const result = await new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 30)
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
          { title: "News article", url: "https://example.com/news", contentSource: "news" },
          { title: "Missing category", url: "https://example.com/missing" },
          { title: "Invalid category", url: "https://example.com/invalid", contentSource: { type: "news" } },
        ],
      }],
    })));
    const result = await new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie coverage" }]);
    expect(result.sources.map(({ title, contentSource }) => ({ title, contentSource }))).toEqual([
      { title: "Web review", contentSource: "web" },
      { title: "News article", contentSource: "news" },
      { title: "Missing category", contentSource: undefined },
      { title: "Invalid category", contentSource: undefined },
    ]);
  });

  it("caps long source passages at 3,000 characters without dropping their citations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      results: [{
        evidence: { type: "text", content: "A".repeat(3000) + "Additional document content." },
        citations: [{ title: "Movie review", url: "https://example.com/review" }],
      }],
    })));
    const result = await new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 30)
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
    const result = await new WebIqClient("key", "https://api.microsoft.ai/v3/", 18000, 30)
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
    const result = await new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 30)
      .search([{ query: "movie" }]);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0]!.media).toEqual({ type: "video" });
  });

  it("distinguishes an empty search from an unexpected response contract", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ results: [] }))
      .mockResolvedValueOnce(Response.json({ webResults: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WebIqClient("key", "https://api.microsoft.ai/v3", 18000, 30);
    expect((await client.search([{ query: "no matches" }])).sources).toEqual([]);
    await expect(client.search([{ query: "wrong contract" }])).rejects.toThrow("invalid results array");
  });
});
