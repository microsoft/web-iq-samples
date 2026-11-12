// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadQueryGuidance, parsePlannerOutput, QueryPlanner } from "./queryPlanner.js";
import { emptyPreferences, type ConversationMessage } from "./types.js";

const { createCompletion } = vi.hoisted(() => ({ createCompletion: vi.fn() }));
vi.mock("openai", () => ({
  AzureOpenAI: class {
    chat = { completions: { create: createCompletion } };
  },
}));

beforeEach(() => {
  createCompletion.mockReset();
});

describe("QueryPlanner follow-up context", () => {
  it("bounds reference-resolution history consistently in both planning phases", async () => {
    createCompletion
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ mode: "initial", queries: [] }) } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ mode: "stop", queries: [] }) } }],
      });
    const history: ConversationMessage[] = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: index === 9 ? "Arrival. " + "x".repeat(3000) : `Earlier turn ${index}`,
    }));
    const planner = new QueryPlanner("key", "https://example.com", "model", "version", "guidance", 5);
    await planner.planInitial("Who directed it?", emptyPreferences(), 8, history);
    await planner.planFollowUp("Who directed it?", emptyPreferences(), [], [], 2, 8, history);
    for (const [request] of createCompletion.mock.calls) {
      const context = JSON.parse(request.messages[1].content).supplied_context;
      expect(context.movie_preferences).toEqual(emptyPreferences());
      expect(context.conversation_context).toEqual(
        history.slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 2000) })),
      );
      expect(context.conversation_context.at(-1).content).toContain("Arrival.");
    }
    expect(history[9]!.content.length).toBeGreaterThan(2000);
  });

  it("shares the remaining budget with both planning phases and bounds oversized plans", async () => {
    const queries = Array.from({ length: 5 }, (_, index) => ({
      query: `missing fictional fact ${index}`, purpose: "Find a requested fact",
    }));
    createCompletion
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ mode: "initial", queries }) } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ mode: "follow_up", queries }) } }],
      });
    const planner = new QueryPlanner("key", "https://example.com", "model", "version", "guidance", 5);
    const initial = await planner.planInitial("Compare fictional films.", emptyPreferences(), 3);
    const followUp = await planner.planFollowUp(
      "Compare fictional films.", emptyPreferences(), [], [], 2, 1,
    );
    expect(initial.map(({ query }) => query)).toEqual(queries.slice(0, 3).map(({ query }) => query));
    expect(followUp.queries.map(({ query }) => query)).toEqual([queries[0]!.query]);
    const payloads = createCompletion.mock.calls.map(([request]) => JSON.parse(request.messages[1].content));
    expect(payloads.map(({ search_budget }) => search_budget)).toEqual([
      { remaining_calls: 3, max_queries_this_pass: 3 },
      { remaining_calls: 1, max_queries_this_pass: 1 },
    ]);
  });

  it("preserves evidence beyond the old preview cutoff and identifies its originating query", async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ mode: "stop", stop_reason: "The figures are present." }) } }],
    });
    const query = { query: "fictional festival film grosses", purpose: "Find reported grosses.", autoMode: "advanced" as const, iteration: 1 };
    const lateFact = "Saffron Atlas reported a worldwide gross of 12 million dollars.";
    const content = "Background on an imaginary film festival and its programme. ".repeat(24) + lateFact;
    const planner = new QueryPlanner("key", "https://example.com", "model", "version", "guidance", 5);
    await planner.planFollowUp("What did each festival film gross?", emptyPreferences(), [query], [{
      id: 1, title: "Synthetic festival report", url: "https://example.com/festival",
      query: query.query, content,
    }], 2, 7);
    const payload = JSON.parse(createCompletion.mock.calls[0]![0].messages[1].content);
    expect(payload.accumulated_evidence[0].content).toContain(lateFact);
    expect(payload.accumulated_evidence[0].content).toBe(content);
    expect(payload.accumulated_evidence[0].query).toBe(query.query);
    expect(payload.previous_queries[0].auto_mode).toBe("advanced");
  });

  it("does not reissue an existing query merely because the requested Auto mode changed", async () => {
    createCompletion.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        mode: "follow_up",
        queries: [
          { query: " FICTIONAL FILM GROSS ", purpose: "Mode-only repeat.", auto_mode: "advanced" },
          { query: "fictional film release date", purpose: "Find a different missing fact.", auto_mode: "lite" },
        ],
      }) } }],
    });
    const planner = new QueryPlanner("key", "https://example.com", "model", "version", "guidance", 5);
    const plan = await planner.planFollowUp("Find a film's gross and release date.", emptyPreferences(), [{
      query: "fictional film gross", purpose: "Find gross.", autoMode: "lite", iteration: 1,
    }], [], 2, 7);
    expect(plan.queries).toEqual([{
      query: "fictional film release date", purpose: "Find a different missing fact.",
      autoMode: "lite", iteration: 2,
    }]);
  });
});

describe("parsePlannerOutput", () => {
  it("parses, deduplicates, and caps initial queries", () => {
    const plan = parsePlannerOutput(
      JSON.stringify({
        mode: "initial",
        queries: [
          {
            query: "Arrival similar movies",
            purpose: "Find recommendation candidates.",
            auto_mode: "advanced",
          },
          {
            query: " arrival   similar movies ",
            purpose: "Duplicate candidate.",
            auto_mode: "lite",
          },
          {
            query: "Arrival critic reviews",
            purpose: "Find critical comparisons.",
          },
        ],
      }),
      "initial",
      1,
      1,
    );

    expect(plan.queries).toEqual([
      {
        query: "Arrival similar movies",
        purpose: "Find recommendation candidates.",
        autoMode: "advanced",
        iteration: 1,
      },
    ]);
  });

  it.each([undefined, "lite", "advanced"])("accepts auto_mode %s, defaulting omission to lite", (autoMode) => {
    const plan = parsePlannerOutput(JSON.stringify({
      mode: "follow_up",
      queries: [{ query: "A film box office gross", purpose: "Resolve a missing figure.", auto_mode: autoMode }],
    }), "follow_up", 2, 5);
    expect(plan.queries).toEqual([{
      query: "A film box office gross", purpose: "Resolve a missing figure.",
      autoMode: autoMode ?? "lite", iteration: 2,
    }]);
  });

  it.each(["fast", "initial", null, 42])("rejects unsupported auto_mode %s", (autoMode) => {
    expect(() => parsePlannerOutput(JSON.stringify({
      mode: "initial",
      queries: [{ query: "A movie", purpose: "Find evidence.", auto_mode: autoMode }],
    }), "initial", 1, 5)).toThrow('auto_mode must be either "lite" or "advanced"');
  });

  it("accepts a follow-up stop decision", () => {
    const plan = parsePlannerOutput(
      JSON.stringify({
        mode: "stop",
        queries: [],
        stop_reason: "Evidence is sufficient.",
      }),
      "follow_up",
      2,
      5,
    );

    expect(plan.queries).toEqual([]);
    expect(plan.stopReason).toBe("Evidence is sufficient.");
  });

  it("accepts an empty initial plan for a preference-only turn", () => {
    const plan = parsePlannerOutput(
      JSON.stringify({
        mode: "initial",
        queries: [],
        request_context: {
          language: null,
          region: null,
          freshness: null,
        },
        unresolved_ambiguities: [],
      }),
      "initial",
      1,
      5,
    );

    expect(plan.queries).toEqual([]);
  });

  it("loads the checked-in guidance", async () => {
    const guidance = await loadQueryGuidance();
    expect(guidance).toContain("ONE INFORMATION NEED PER QUERY");
    expect(guidance).toContain("ITERATIVE RETRIEVAL MODE");
  });
});
