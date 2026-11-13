// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { hasExcessiveCopying, MovieModel, parseChatResult } from "./movieModel.js";
import { emptyPreferences, type WebIqSource } from "./types.js";

const { createCompletion } = vi.hoisted(() => ({ createCompletion: vi.fn() }));
vi.mock("openai", () => ({
  AzureOpenAI: class {
    chat = { completions: { create: createCompletion } };
  },
}));

beforeEach(() => {
  createCompletion.mockReset();
});

const passage = [
  "The imaginary seaside cinema opens its doors at sunset for a festival of invented films.",
  "Visitors can choose a quiet screening room or join a lively discussion with fictional directors.",
  "Every ticket includes a printed programme describing the stories and the people behind them.",
  "After the final screening, the audience gathers outside to discuss the evening under coloured lanterns.",
].join(" ");

function source(content = passage, url = "https://example.com/review"): WebIqSource {
  return { id: 1, title: "Synthetic review", url, content, query: "movie review" };
}

describe("hasExcessiveCopying", () => {
  it.each([
    { length: 200, excessive: false },
    { length: 201, excessive: true },
  ])("checks the per-source boundary at $length normalized characters", ({ length, excessive }) => {
    expect(hasExcessiveCopying("x".repeat(length), [source("x".repeat(300))]))
      .toBe(excessive);
  });

  it("detects copied passages despite capitalization, punctuation, whitespace, and citations", () => {
    const answer = passage.toUpperCase().replaceAll(" ", "\n").replaceAll(".", "! [1]");
    expect(hasExcessiveCopying(answer, [source()])).toBe(true);
  });

  it("adds separate copied excerpts, including repeated text, without double-counting overlaps", () => {
    const excerpt = passage.slice(0, 130);
    expect(hasExcessiveCopying(`${excerpt} [1]`, [source()])).toBe(false);
    expect(hasExcessiveCopying(`${excerpt} [1] My separate observation. ${passage.slice(190, 320)}`, [source()]))
      .toBe(true);
    expect(hasExcessiveCopying(`${excerpt} [1] A different observation. ${excerpt} [1]`, [source()]))
      .toBe(true);
  });

  it("aggregates passages from the same URL but keeps different sources' budgets separate", () => {
    const first = passage.slice(0, 130);
    const second = passage.slice(190, 320);
    const answer = `${first} [1] My own connecting observation. ${second} [2]`;
    expect(hasExcessiveCopying(answer, [source(first), source(second)])).toBe(true);
    expect(hasExcessiveCopying(answer, [
      source(first), source(second, "https://example.com/another-review"),
    ])).toBe(false);
  });

  it("allows an original long summary and checks evidence even without citation markers", () => {
    expect(hasExcessiveCopying(
      "I would pick a film according to your preferred genre and the mood you want tonight. ".repeat(4),
      [source()],
    )).toBe(false);
    expect(hasExcessiveCopying(passage, [source()])).toBe(true);
    expect(hasExcessiveCopying(passage, [])).toBe(false);
  });

  it("shares the copying budget across fragment links without changing their display URLs", () => {
    const first = source(passage.slice(0, 130), "https://example.com/review#first");
    const second = source(passage.slice(190, 320), "https://example.com/review#second");
    expect(hasExcessiveCopying(
      `${first.content} [1] My own connecting observation. ${second.content} [2]`,
      [first, second],
    )).toBe(true);
    expect(first.url).toBe("https://example.com/review#first");
    expect(second.url).toBe("https://example.com/review#second");
  });
});

describe("MovieModel copying safeguard", () => {
  const completion = (message: string, genres: string[] = []) => ({
    choices: [{ message: { content: JSON.stringify({
      message, preferences: { ...emptyPreferences(), genres },
    }) } }],
  });
  const respond = (searchLimitReached = false) => new MovieModel("key", "https://example.com", "model", "version")
    .respond("Tell me about the film.", [], emptyPreferences(), [source()], "model", searchLimitReached);

  it("returns an original answer without an extra model call", async () => {
    createCompletion.mockResolvedValue(completion("A fictional film festival provides several viewing choices [1]."));
    const result = await respond();
    expect(createCompletion).toHaveBeenCalledOnce();
    expect(result.message).toContain("viewing choices");
    expect(result.message).not.toContain("Search limit reached");
    expect(result.answerDurationsMs).toEqual([expect.any(Number)]);
    expect(createCompletion.mock.calls[0]![0].messages[0].content)
      .toContain("Do not reproduce passages");
  });

  it.each([false, true])("retries copying once and preserves search-limit disclosure when exhausted=%s", async (searchLimitReached) => {
    createCompletion
      .mockResolvedValueOnce(completion(`${passage} [1]`, ["horror"]))
      .mockResolvedValueOnce(completion("The festival offers different settings for watching and discussing films [1].", ["drama"]));
    const result = await respond(searchLimitReached);
    expect(createCompletion).toHaveBeenCalledTimes(2);
    expect(result.message).not.toContain(passage);
    expect(result.preferences.genres).toEqual(["drama"]);
    expect(result.answerDurationsMs).toEqual([expect.any(Number), expect.any(Number)]);
    const retryMessages = createCompletion.mock.calls[1]![0].messages;
    expect(retryMessages).toContainEqual({
      role: "system",
      content: expect.stringContaining("previous attempt was withheld for excessive copying"),
    });
    expect(retryMessages.some(({ role }: { role: string }) => role === "assistant")).toBe(false);
    expect(result.message.includes("Search limit reached")).toBe(searchLimitReached);
    for (const [request] of createCompletion.mock.calls) {
      expect(request.messages.some(({ content }: { content: string }) =>
        content.includes("Explicitly identify unsupported parts"))).toBe(searchLimitReached);
    }
  });

  it("withholds the answer after a second copying failure, without exposing evidence in the error", async () => {
    createCompletion.mockResolvedValue(completion(`${passage} [1]`));
    await expect(respond()).rejects.toMatchObject({
      name: "ExcessiveCopyingError",
      message: "Generated answer exceeded the source-copying limit after a rewrite.",
    });
    expect(createCompletion).toHaveBeenCalledTimes(2);
  });
});

describe("parseChatResult", () => {
  it("normalizes the model response", () => {
    const result = parseChatResult(
      JSON.stringify({
        message: "Try Arrival [1].",
        preferences: {
          genres: ["science fiction", "science fiction"],
          dislikedGenres: [],
          favoriteMovies: ["Arrival"],
          actors: [],
          critics: [],
          location: "Seattle",
          notes: [],
        },
      }),
      emptyPreferences(),
    );

    expect(result.message).toBe("Try Arrival [1].");
    expect(result.preferences.genres).toEqual(["science fiction"]);
    expect(result.preferences.location).toBe("Seattle");
  });

  it("preserves an existing location when the model omits it", () => {
    const result = parseChatResult(
      JSON.stringify({
        message: "Here are three more options.",
        preferences: {
          genres: [],
          dislikedGenres: [],
          favoriteMovies: [],
          actors: [],
          critics: [],
          notes: [],
        },
      }),
      {
        ...emptyPreferences(),
        location: "Seattle",
      },
    );

    expect(result.preferences.location).toBe("Seattle");
  });
});
