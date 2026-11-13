// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { requestContext } from "./logging.js";
import {
  MovieChatService,
  selectCitedSources,
  shouldUseStoredPreferences,
} from "./movieChatService.js";
import type { ChatResult, WebIqQuery, WebIqSource } from "./types.js";
import { emptyPreferences } from "./types.js";
import { SessionStore } from "./sessionStore.js";
import type { MovieModel } from "./movieModel.js";
import type { QueryPlanner } from "./queryPlanner.js";
import { mergeSources, type WebIqClient } from "./webIqClient.js";

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.stubEnv("MOVIE_CHAT_LOG_RETRIEVAL_DETAILS", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const sources: WebIqSource[] = [
  {
    id: 1,
    title: "Arrival review",
    url: "https://example.com/arrival-review",
    content: "Review content",
    query: "Arrival reviews",
  },
  {
    id: 2,
    title: "Arrival cast",
    url: "https://example.com/arrival-cast",
    content: "Cast content",
    query: "Arrival cast",
  },
  {
    id: 3,
    title: "Similar movies",
    url: "https://example.com/similar-movies",
    content: "Recommendation content",
    query: "movies similar to Arrival",
  },
];

it("supplies conversation references to both planners without opting into stored preferences", async () => {
  const sessions = new SessionStore(120, 12);
  const session = sessions.getOrCreate();
  session.messages = [
    { role: "user", content: "Tell me about Arrival." },
    { role: "assistant", content: "Arrival is a science-fiction film [1]." },
  ];
  session.preferences.genres = ["horror"];
  const history = [...session.messages];
  const query = { query: "Arrival director", purpose: "Resolve the film's director", iteration: 1 };
  const planner = {
    planInitial: vi.fn().mockResolvedValue([query]),
    planFollowUp: vi.fn().mockResolvedValue({ queries: [] }),
  };
  const webIq = {
    search: vi.fn().mockResolvedValue({
      sources: [], calls: [{ query: query.query, durationMs: 1 }],
    }),
  };
  const model = {
    respond: vi.fn().mockResolvedValue({ message: "A director.", preferences: session.preferences }),
  };
  try {
    const service = new MovieChatService(
      sessions, webIq as unknown as WebIqClient, planner as unknown as QueryPlanner,
      model as unknown as MovieModel, "model",
      { mode: "iterative", maxIterations: 5, maxQueriesPerIteration: 5, maxTotalQueries: 8 }, 30,
    );
    await service.chat(session.id, "Who directed it?");
    expect(planner.planInitial).toHaveBeenCalledWith(
      "Who directed it?", emptyPreferences(), 8, history,
    );
    expect(planner.planFollowUp).toHaveBeenCalledWith(
      "Who directed it?", emptyPreferences(), [query], [], 2, 7, history,
    );
  } finally {
    sessions.close();
  }
});

it("does not restore a session deleted while its answer is pending", async () => {
  const sessions = new SessionStore(120, 12);
  const session = sessions.getOrCreate();
  let finish!: (result: ChatResult) => void;
  let started!: () => void;
  const pending = new Promise<ChatResult>((resolve) => { finish = resolve; });
  const answering = new Promise<void>((resolve) => { started = resolve; });
  const planner = { planInitial: vi.fn().mockResolvedValue([]) };
  const webIq = { search: vi.fn().mockResolvedValue({ sources: [], calls: [] }) };
  const model = { respond: vi.fn().mockImplementation(() => { started(); return pending; }) };
  try {
    const service = new MovieChatService(
      sessions, webIq as unknown as WebIqClient, planner as unknown as QueryPlanner,
      model as unknown as MovieModel, "model",
      { mode: "initial", maxIterations: 5, maxQueriesPerIteration: 5, maxTotalQueries: 8 }, 30,
    );
    const response = service.chat(session.id, "Tell me about Arrival.");
    await answering;
    expect(service.deleteSession(session.id)).toBe(true);
    finish({ message: "A science-fiction film.", preferences: emptyPreferences() });
    await response;
    expect(sessions.delete(session.id)).toBe(false);
    expect(session.messages).toEqual([]);
    expect(sessions.getOrCreate(session.id).id).not.toBe(session.id);
  } finally {
    sessions.close();
  }
});

it("skips iterative assessment when the initial plan requires no retrieval", async () => {
  const sessions = new SessionStore(120, 12);
  const planner = { planInitial: vi.fn().mockResolvedValue([]), planFollowUp: vi.fn() };
  const webIq = { search: vi.fn().mockResolvedValue({ sources: [], calls: [] }) };
  const model = {
    respond: vi.fn().mockResolvedValue({ message: "I will remember that.", preferences: emptyPreferences() }),
  };
  try {
    const service = new MovieChatService(
      sessions, webIq as unknown as WebIqClient, planner as unknown as QueryPlanner,
      model as unknown as MovieModel, "model",
      { mode: "iterative", maxIterations: 5, maxQueriesPerIteration: 5, maxTotalQueries: 8 }, 30,
    );
    const response = await service.chat(undefined, "I like science fiction.");
    expect(webIq.search).toHaveBeenCalledExactlyOnceWith([]);
    expect(planner.planFollowUp).not.toHaveBeenCalled();
    expect(response.debug.totals).toMatchObject({ modelCalls: 2, webIqCalls: 0 });
  } finally {
    sessions.close();
  }
});

it("retrieves a ranking, fans out to discovered actors, and stops when the planner reports no gaps", async () => {
  const sessions = new SessionStore(120, 12);
  const question = "Who are the highest-paid actors and how much did each one's highest-grossing movie make?";
  const rankingQuery = {
    query: "highest paid actors and each actor's highest grossing movie",
    purpose: "Find earnings and film grosses together", autoMode: "advanced", iteration: 1,
  };
  const actorQueries = ["Asha Vale", "Theo Reed"].map((actor) => ({
    query: `${actor} highest grossing movie worldwide box office`,
    purpose: `Find ${actor}'s movie and gross`,
    autoMode: "lite",
    iteration: 2,
  }));
  const ranking: WebIqSource = {
    id: 1, title: "Synthetic earnings ranking", url: "https://example.com/ranking",
    query: rankingQuery.query, content: "The ranking lists Asha Vale and Theo Reed.",
  };
  const movieSources: WebIqSource[] = actorQueries.map(({ query }, index) => ({
    id: index + 1, title: `Synthetic movie result ${index}`,
    url: `https://example.com/movie-${index}`, query,
    content: `A fictional highest-grossing film earned ${index + 1} billion worldwide.`,
  }));
  const planner = {
    planInitial: vi.fn().mockResolvedValue([rankingQuery]),
    planFollowUp: vi.fn()
      .mockResolvedValueOnce({ queries: actorQueries })
      .mockResolvedValueOnce({ queries: [], stopReason: "All requested figures are supported." }),
  };
  const webIq = {
    search: vi.fn()
      .mockResolvedValueOnce({
        sources: [ranking],
        calls: [{ query: rankingQuery.query, durationMs: 10, traceId: "ranking-trace" }],
      })
      .mockResolvedValueOnce({
        sources: movieSources,
        calls: actorQueries.map(({ query }, index) => ({
          query, durationMs: 20, traceId: `movie-trace-${index}`,
        })),
      }),
  };
  const model = {
    respond: vi.fn().mockResolvedValue({ message: "Here are the supported figures [1, 2, 3].", preferences: emptyPreferences() }),
  };
  try {
    const service = new MovieChatService(
      sessions, webIq as unknown as WebIqClient, planner as unknown as QueryPlanner,
      model as unknown as MovieModel, "model",
      { mode: "iterative", maxIterations: 5, maxQueriesPerIteration: 5, maxTotalQueries: 8 }, 30,
    );
    const response = await service.chat(undefined, question);
    expect(planner.planFollowUp).toHaveBeenCalledTimes(2);
    expect(planner.planFollowUp.mock.calls[0]![0]).toBe(question);
    expect(planner.planFollowUp.mock.calls[0]![3]).toEqual([ranking]);
    expect(planner.planFollowUp.mock.calls[0]![4]).toBe(2);
    expect(planner.planInitial.mock.calls[0]![2]).toBe(8);
    expect(planner.planFollowUp.mock.calls.map((call) => call[5])).toEqual([7, 5]);
    expect(webIq.search).toHaveBeenCalledTimes(2);
    expect(webIq.search).toHaveBeenNthCalledWith(1, [
      { query: rankingQuery.query, autoMode: "advanced" },
    ]);
    expect(webIq.search).toHaveBeenNthCalledWith(2, actorQueries.map(({ query, autoMode }) => ({ query, autoMode })));
    expect(response.debug.webIqCalls.map(({ autoMode }) => autoMode)).toEqual(["advanced", "lite", "lite"]);
    expect(response.debug.totals).toMatchObject({ modelCalls: 4, webIqCalls: 3 });
    expect(response.debug.evidence.map(({ url }) => url))
      .toEqual([ranking.url, ...movieSources.map(({ url }) => url)]);
    expect(model.respond.mock.calls[0]![3]).toEqual(response.debug.evidence);
    expect(model.respond.mock.calls[0]![5]).toBe(false);
  } finally {
    sessions.close();
  }
});

it.each([
  { mode: "initial" as const, limit: 3, batchSizes: [3] },
  { mode: "iterative" as const, limit: 3, batchSizes: [3] },
  { mode: "iterative" as const, limit: 8, batchSizes: [5, 3] },
])("enforces a $limit-call budget in $mode mode and resets it for the next message", async ({ mode, limit, batchSizes }) => {
  const sessions = new SessionStore(120, 12);
  const initialQueries = Array.from({ length: 5 }, (_, index) => ({
    query: `initial fact ${index}`, purpose: "Find a requested fact", iteration: 1,
  }));
  const followUpQueries = Array.from({ length: 5 }, (_, index) => ({
    query: `missing fact ${index}`, purpose: "Close a genuine gap", iteration: 2,
  }));
  const planner = {
    planInitial: vi.fn().mockResolvedValue(initialQueries),
    planFollowUp: vi.fn().mockResolvedValue({ queries: followUpQueries }),
  };
  const webIq = {
    search: vi.fn().mockImplementation(async (queries: WebIqQuery[]) => ({
      sources: [],
      calls: queries.map(({ query }) => ({ query, durationMs: 1 })),
    })),
  };
  const model = {
    respond: vi.fn().mockResolvedValue({
      message: "The requested figures are not supported by the available evidence.",
      preferences: emptyPreferences(),
    }),
  };
  try {
    const service = new MovieChatService(
      sessions, webIq as unknown as WebIqClient, planner as unknown as QueryPlanner,
      model as unknown as MovieModel, "model",
      { mode, maxIterations: 5, maxQueriesPerIteration: 5, maxTotalQueries: limit }, 30,
    );
    const first = await service.chat(undefined, "Compare these fictional films.");
    const second = await service.chat(first.sessionId, "Try again with the same scope.");
    for (const response of [first, second]) {
      expect(response.debug.totals.webIqCalls).toBe(limit);
      expect(response.webIqQueries.map(({ query }) => query)).toEqual([
        ...initialQueries.slice(0, Math.min(5, limit)),
        ...(limit > 5 ? followUpQueries.slice(0, limit - 5) : []),
      ].map(({ query }) => query));
    }
    expect(webIq.search.mock.calls.map(([queries]) => queries.length))
      .toEqual([...batchSizes, ...batchSizes]);
    expect(planner.planInitial.mock.calls.map((call) => call[2])).toEqual([limit, limit]);
    expect(planner.planFollowUp).toHaveBeenCalledTimes(2 * (batchSizes.length - 1));
    if (batchSizes.length > 1) {
      expect(planner.planFollowUp.mock.calls.map((call) => call[5])).toEqual([3, 3]);
    }
    expect(model.respond.mock.calls.map((call) => call[5])).toEqual([true, true]);
  } finally {
    sessions.close();
  }
});

it.each([
  { answerDurationsMs: undefined, modelCalls: 2 },
  { answerDurationsMs: [30, 40], modelCalls: 3 },
])("uses one retrieval pass, returns uncited media, and counts $modelCalls model calls", async ({ answerDurationsMs, modelCalls }) => {
  const sessions = new SessionStore(120, 12);
  const query = { query: "Jaws movie poster", purpose: "Find the poster", iteration: 1 };
  const mediaSource: WebIqSource = {
    id: 2, title: "Jaws poster", url: "https://example.com/jaws",
    content: "A movie poster.", query: query.query,
    media: { type: "image", imageUrl: "https://images.example.com/jaws.jpg" },
  };
  const planner = { planInitial: vi.fn().mockResolvedValue([query]), planFollowUp: vi.fn() };
  const webIq = {
    search: vi.fn().mockResolvedValue({
      sources: [sources[0], mediaSource],
      calls: [{ query: query.query, durationMs: 20, traceId: "poster-trace" }],
    }),
  };
  const model = {
    respond: vi.fn().mockResolvedValue({ message: "Here is the poster.", preferences: emptyPreferences(), answerDurationsMs }),
  };
  try {
    const service = new MovieChatService(
      sessions, webIq as unknown as WebIqClient, planner as unknown as QueryPlanner,
      model as unknown as MovieModel, "model",
      { mode: "initial", maxIterations: 5, maxQueriesPerIteration: 5, maxTotalQueries: 8 }, 30,
    );
    const response = await service.chat(undefined, "Show me the Jaws movie poster");
    expect(planner.planFollowUp).not.toHaveBeenCalled();
    expect(webIq.search).toHaveBeenCalledExactlyOnceWith([{ query: query.query, autoMode: "lite" }]);
    expect(response.debug.totals.modelCalls).toBe(modelCalls);
    if (answerDurationsMs) {
      expect(response.debug.modelCalls.slice(1).map(({ durationMs }) => durationMs)).toEqual(answerDurationsMs);
      expect(response.debug.modelCalls[2]?.purpose).toContain("Rewrite");
      expect(response.debug.totals.modelDurationMs)
        .toBe(response.debug.modelCalls[0]!.durationMs + 70);
    }
    expect(response.debug.webIqCalls[0]).toMatchObject({
      query: query.query, traceId: "poster-trace",
    });
    expect(response.debug.evidence).toEqual([sources[0], mediaSource]);
    expect(response.debug.evidence).toEqual(model.respond.mock.calls[0]![3]);
    expect(response.sources).toEqual([{
      id: 2, title: mediaSource.title, url: mediaSource.url, media: mediaSource.media,
    }]);
  } finally {
    sessions.close();
  }
});

it("preserves trace IDs across iterations and exposes the final model evidence with stable IDs", async () => {
  const sessions = new SessionStore(120, 12);
  const initialQuery = { query: "Arrival reviews", purpose: "Find reviews", iteration: 1 };
  const nextQuery = { query: "Arrival cast", purpose: "Find cast", iteration: 2 };
  const planner = {
    planInitial: vi.fn().mockResolvedValue([initialQuery]),
    planFollowUp: vi.fn().mockResolvedValue({ queries: [nextQuery] }),
  };
  const webIq = {
    search: vi.fn()
      .mockResolvedValueOnce({
        sources: [sources[0]],
        calls: [{ query: initialQuery.query, durationMs: 10, traceId: "review-trace" }],
      })
      .mockResolvedValueOnce({
        sources: [{ ...sources[1], id: 1 }],
        calls: [{ query: nextQuery.query, durationMs: 15, traceId: "cast-trace" }],
      }),
  };
  const model = {
    respond: vi.fn().mockResolvedValue({ message: "Try Arrival [1].", preferences: emptyPreferences() }),
  };
  try {
    const service = new MovieChatService(
      sessions, webIq as unknown as WebIqClient, planner as unknown as QueryPlanner,
      model as unknown as MovieModel, "model",
      { mode: "iterative", maxIterations: 2, maxQueriesPerIteration: 5, maxTotalQueries: 8 }, 2,
    );
    const response = await service.chat(undefined, "Tell me about Arrival");
    expect(response.debug.webIqCalls.map(({ query, traceId, iteration }) => ({ query, traceId, iteration })))
      .toEqual([
        { query: initialQuery.query, traceId: "review-trace", iteration: 1 },
        { query: nextQuery.query, traceId: "cast-trace", iteration: 2 },
      ]);
    expect(response.debug.evidence).toEqual(model.respond.mock.calls[0]![3]);
    expect(response.debug.evidence.map(({ id }) => id)).toEqual([1, 2]);
    expect(response.sources.map(({ id }) => id)).toEqual([1]);
  } finally {
    sessions.close();
  }
});

it.each([
  { name: "only deduplicated cited URLs", message: "Arrival [1, 99][1].", details: undefined, fails: false },
  { name: "an empty list for an uncited answer", message: "What do you like?", details: undefined, fails: false },
  { name: "no URL details when disabled", message: "Arrival [1].", details: "false", fails: false },
  { name: "no citation event when answer generation fails", message: "", details: undefined, fails: true },
])("logs $name", async ({ message, details, fails }) => {
  vi.stubEnv("MOVIE_CHAT_LOG_RETRIEVAL_DETAILS", details);
  const sessions = new SessionStore(120, 12);
  const updateSession = vi.spyOn(sessions, "update");
  const query = { query: "Arrival reviews", purpose: "Find reviews", iteration: 1 };
  const planner = { planInitial: vi.fn().mockResolvedValue([query]) };
  const webIq = {
    search: vi.fn().mockResolvedValue({
      sources: [
        ...sources,
        {
          ...sources[1], id: 4, title: "Uncited poster",
          media: { type: "image", imageUrl: "https://images.example.com/poster.jpg" },
        },
      ],
      calls: [{ query: query.query, durationMs: 10, traceId: "review-trace" }],
    }),
  };
  const model = {
    respond: fails
      ? vi.fn().mockRejectedValue(new Error("Answer generation failed"))
      : vi.fn().mockResolvedValue({ message, preferences: emptyPreferences() }),
  };
  try {
    const service = new MovieChatService(
      sessions, webIq as unknown as WebIqClient, planner as unknown as QueryPlanner,
      model as unknown as MovieModel, "model",
      { mode: "initial", maxIterations: 5, maxQueriesPerIteration: 5, maxTotalQueries: 8 }, 30,
    );
    const chat = requestContext.run("citation-request", () => service.chat(undefined, "Tell me about Arrival"));
    if (fails) {
      await expect(chat).rejects.toThrow("Answer generation failed");
      expect(console.info).not.toHaveBeenCalled();
      expect(updateSession).not.toHaveBeenCalled();
      return;
    }
    await chat;
    expect(console.info).toHaveBeenCalledOnce();
    const log = JSON.parse(vi.mocked(console.info).mock.calls[0]![0] as string);
    expect(log).toEqual({
      event: "chat_citations",
      timestamp: expect.any(String),
      level: "info",
      requestId: "citation-request",
      citedUrlCount: message.includes("[1") ? 1 : 0,
      ...(details === "false" ? {} : {
        citedUrls: message.includes("[1") ? [sources[0]!.url] : [],
      }),
    });
    expect(JSON.stringify(log)).not.toMatch(/arrival-cast|similar-movies|poster\.jpg|Review content|Arrival reviews/);
  } finally {
    sessions.close();
  }
});

describe("selectCitedSources", () => {
  it("returns only sources cited in the answer", () => {
    const selected = selectCitedSources(
      "Critics praised Arrival [1]. Amy Adams stars in it [2].",
      sources,
    );

    expect(selected.map(({ id }) => id)).toEqual([1, 2]);
  });

  it("supports grouped citations and ignores unknown IDs", () => {
    const selected = selectCitedSources(
      "These recommendations share similar themes [1, 3, 99].",
      sources,
    );

    expect(selected.map(({ id }) => id)).toEqual([1, 3]);
  });

  it("returns no sources when the answer has no citations", () => {
    expect(selectCitedSources("What city should I search?", sources)).toEqual([]);
  });
});

describe("shouldUseStoredPreferences", () => {
  it.each([
    "Recommend something I would like.",
    "What should I watch based on my preferences?",
    "Give me a personalized recommendation for me.",
    "What would I like?",
  ])("uses stored preferences for explicit personalization: %s", (message) => {
    expect(shouldUseStoredPreferences(message)).toBe(true);
  });

  it.each([
    "What did critics think about Arrival?",
    "Recommend a thoughtful science-fiction movie.",
    "Find showtimes near Seattle.",
    "I like mysteries but not horror. What is new this week?",
  ])("does not assume stored preferences for: %s", (message) => {
    expect(shouldUseStoredPreferences(message)).toBe(false);
  });
});

describe("mergeSources", () => {
  it("does not shrink retained facts when an original passage is retrieved again after truncation", () => {
    const fact = "The fictional worldwide gross is 42 million dollars.";
    const first = { ...sources[0]!, content: "A".repeat(3000) };
    const second = {
      ...sources[0]!, query: "Arrival gross",
      content: "B".repeat(1200) + fact + "B".repeat(1800 - fact.length),
    };
    const initial = mergeSources([], [first, second], 30);
    expect(initial[0]!.content).toContain(fact);
    const repeated = mergeSources(initial, [{ ...first, query: "Another review lookup" }], 30);
    expect(repeated[0]!.passages).toHaveLength(2);
    expect(repeated[0]!.content).toBe(initial[0]!.content);
    expect(repeated[0]!.content).toContain(fact);
  });

  it("retains new same-URL facts and provenance even when the previous passage fills the context budget", () => {
    const original = { ...sources[0]!, content: "First fact. " + "x".repeat(2988) };
    const additional = {
      ...sources[0]!, query: "Arrival box office",
      content: "New fact: the fictional film earned 42 million dollars.",
      updatedAt: "2026-03-01",
      media: { type: "image" as const, imageUrl: "https://example.com/poster.jpg" },
    };
    const [merged] = mergeSources([original], [additional], 30);
    expect(merged!.content).toContain("First fact.");
    expect(merged!.content).toContain(additional.content);
    expect(merged!.content.length).toBeLessThanOrEqual(3000);
    expect(merged!.passages?.map(({ query }) => query)).toEqual([original.query, additional.query]);
    expect(merged!.media).toEqual(additional.media);
    expect(merged!.updatedAt).toBe(additional.updatedAt);
    expect(original.content).toHaveLength(3000);
    expect(original).not.toHaveProperty("passages");
  });

  it("bounds repeated same-document retrieval and retains the most recent distinct passages", () => {
    let merged: WebIqSource[] = [];
    for (let index = 0; index < 12; index += 1) {
      merged = mergeSources(merged, [{
        ...sources[0]!, query: `query-${index}`, content: `Fact ${index}. ` + "x".repeat(2990),
      }], 30);
    }
    expect(merged).toHaveLength(1);
    expect(merged[0]!.content.length).toBeLessThanOrEqual(3000);
    expect(merged[0]!.content).toContain("Fact 11.");
    expect(merged[0]!.passages).toHaveLength(8);
    expect(merged[0]!.passages?.map(({ query }) => query)).toEqual(
      Array.from({ length: 8 }, (_, index) => `query-${index + 4}`),
    );
  });

  it("preserves evidence coverage across distinct queries", () => {
    const makeSource = (
      id: number,
      query: string,
      suffix: string,
    ): WebIqSource => ({
      id,
      title: `${query} ${suffix}`,
      url: `https://example.com/${query}-${suffix}`,
      content: "Evidence",
      query,
    });
    const existing = [
      makeSource(1, "ranking", "a"),
      makeSource(2, "ranking", "b"),
      makeSource(3, "ranking", "c"),
    ];
    const additional = [
      makeSource(1, "actor-one", "a"),
      makeSource(2, "actor-one", "b"),
      makeSource(3, "actor-two", "a"),
      makeSource(4, "actor-two", "b"),
    ];

    const merged = mergeSources(existing, additional, 3);

    expect(merged.map(({ query }) => query)).toEqual([
      "ranking",
      "actor-one",
      "actor-two",
    ]);
    expect(merged.map(({ id }) => id)).toEqual([1, 2, 3]);
  });
});
