// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { SESSION_STORAGE_KEY } from "./chatAdapter";
import { emptyPreferences, type ChatResponse } from "./types";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  sessionStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  // JSDOM has no layout; collision-aware previews need a visible anchor.
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1024);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(768);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this === document.documentElement || this === document.body
      ? new DOMRect(0, 0, 1024, 768)
      : new DOMRect(100, 100, 200, 40);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function reply(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    sessionId: "session-one",
    message: "Try **Arrival**. [1]",
    preferences: { ...emptyPreferences(), genres: ["Science fiction"] },
    sources: [{ id: 1, title: "Arrival review", url: "https://example.com/arrival" }],
    debug: {
      modelCalls: [{
        stage: "query_planning",
        purpose: "Find reviews",
        iteration: 1,
        durationMs: 120,
      }],
      webIqCalls: [{
        query: "Arrival movie reviews",
        purpose: "Find reviews",
        iteration: 1,
        durationMs: 80,
      }],
      evidence: [],
      totals: { modelCalls: 1, webIqCalls: 1, modelDurationMs: 120, webIqDurationMs: 80 },
    },
    ...overrides,
  };
}

function send(message = "Recommend a movie") {
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: message },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

describe("Movie Night chat", () => {
  it("offers example prompts without automatically submitting", () => {
    render(<App />);
    const prompts = [
      "What are the latest movie announcements this week?",
      "Compare Arrival reviews from rogerebert.com and variety.com.",
      "Show me the trailer for Avengers: Doomsday.",
      "Show me the Titanic movie poster.",
      "What was the total box office for each of the 2024 Best Picture Oscar nominees?",
    ];
    for (const prompt of prompts) {
      fireEvent.click(screen.getByRole("button", { name: prompt }));
      expect((screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement).value)
        .toBe(prompt);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("labels evidence types and inspects uncited plain text with safe links without displaying trace IDs", async () => {
    const firstPassage = 'Retrieved text <script>alert("bad")</script>\n[99] ![tracking](https://untrusted.example/pixel)';
    const passage = `${firstPassage}\n\nA second synthetic review.`;
    const debug = reply().debug;
    fetchMock.mockResolvedValue(Response.json(reply({
      debug: {
        ...debug,
        webIqCalls: [
          { ...debug.webIqCalls[0]!, traceId: "review-trace" },
          { ...debug.webIqCalls[0]!, query: "Arrival cast", traceId: undefined },
        ],
        evidence: [
          { id: 1, title: "Arrival review", url: "https://example.com/arrival",
            query: "Arrival movie reviews", content: passage, contentSource: "web",
            passages: [
              { query: "Arrival movie reviews", content: firstPassage },
              { query: "Arrival worldwide gross", content: "A second synthetic review." },
            ] },
          { id: 2, title: "Uncited cast evidence", url: "https://example.com/cast",
            query: "Arrival cast", content: "Retrieved cast passage.", contentSource: "News" },
          { id: 3, title: "Unsafe evidence URL", url: "javascript:alert(1)",
            query: "Arrival cast", content: "Plain text only." },
          { id: 4, title: "Titanic poster", url: "https://example.com/titanic",
            query: "Titanic poster", content: "Poster source evidence.", contentSource: "web",
            media: { type: "image", imageUrl: "https://images.example.com/titanic.jpg" } },
          { id: 5, title: "Arrival trailer", url: "https://example.com/trailer",
            query: "Arrival trailer", content: "Trailer source evidence.", contentSource: "web",
            media: { type: "video" } },
        ],
      },
    })));
    const { container } = render(<App />);
    send();
    const debugSummary = await screen.findByText(/^Debug:/);
    const debugDetails = debugSummary.closest("details")!;
    expect(debugDetails.open).toBe(false);
    fireEvent.click(debugSummary);
    expect(debugDetails.open).toBe(true);
    const summary = await screen.findByText("Inspect evidence (5 sources)");
    const inspector = summary.closest("details")!;
    expect(inspector.open).toBe(false);
    expect(screen.queryByText("review-trace")).toBeNull();
    expect(screen.queryByText("Not returned")).toBeNull();
    expect(screen.queryByText(/Trace ID:/)).toBeNull();
    fireEvent.click(summary);
    expect(inspector.open).toBe(true);

    expect(within(inspector).getByText("[3] (Text) Unsafe evidence URL")).toBeTruthy();
    expect(within(inspector).getByText("[4] (Image) Titanic poster")).toBeTruthy();
    expect(within(inspector).getByText("[5] (Video) Arrival trailer")).toBeTruthy();
    fireEvent.click(within(inspector).getByText("[1] (Web) Arrival review"));
    const source = within(inspector).getByText("[1] (Web) Arrival review").closest("details")!;
    const link = within(source).getByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/arrival");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(source.querySelector("pre")?.textContent).toBe(passage);
    expect(within(source).getByText("Arrival movie reviews; Arrival worldwide gross")).toBeTruthy();
    fireEvent.click(within(inspector).getByText("[2] (News) Uncited cast evidence"));
    expect(within(inspector).getByRole("link", { name: "https://example.com/cast" })).toBeTruthy();
    expect(within(inspector).getByText("Retrieved cast passage.")).toBeTruthy();
    expect(container.querySelector("script, img, a[href^='javascript:']")).toBeNull();
    expect(screen.queryByRole("button", { name: "View sources: Uncited cast evidence" })).toBeNull();
  });

  it("explains an empty evidence set without inventing sources", async () => {
    const debug = reply().debug;
    fetchMock.mockResolvedValue(Response.json(reply({
      message: "What city should I search?",
      sources: [],
      debug: { ...debug, webIqCalls: [], evidence: [] },
    })));
    render(<App />);
    send();
    const summary = await screen.findByText("Inspect evidence (0 sources)");
    fireEvent.click(summary);
    expect(summary.closest("details")?.open).toBe(true);
    expect(screen.getByText("No usable evidence was supplied to the model for this turn.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows retrieved posters and loads only allowlisted video players after a click", async () => {
    fetchMock.mockResolvedValue(Response.json(reply({
      message: "Here are the retrieved trailer and poster.",
      sources: [
        {
          id: 1, title: "Avengers trailer", url: "https://www.youtube.com/watch?v=BUc12TDLw-w",
          media: { type: "video", embeddingUrl: "https://www.youtube.com/embed/BUc12TDLw-w?start=12&rel=0" },
        },
        {
          id: 2, title: "Jaws poster", url: "https://example.com/jaws",
          media: { type: "image", imageUrl: "https://images.example.com/jaws.jpg", thumbnailUrl: "https://images.example.com/preview.jpg" },
        },
        {
          id: 3, title: "Unsupported player", url: "https://example.org/video",
          media: { type: "video", embeddingUrl: "https://untrusted.example/embed/video" },
        },
      ],
    })));
    const { container } = render(<App />);
    send("Show trailers and posters");
    const gallery = await screen.findByRole("region", { name: "Retrieved media" });
    const poster = within(gallery).getByRole("img", { name: "Jaws poster" });
    expect(poster.getAttribute("src")).toBe("https://images.example.com/preview.jpg");
    expect(container.querySelector("iframe")).toBeNull();
    expect(within(gallery).queryByRole("button", { name: "Play video: Unsupported player" })).toBeNull();
    expect(within(gallery).getByRole("link", { name: "Unsupported player" }).getAttribute("href"))
      .toBe("https://example.org/video");

    fireEvent.click(within(gallery).getByRole("button", { name: "Play video: Avengers trailer" }));
    expect(screen.getByTitle("Avengers trailer").getAttribute("src"))
      .toBe("https://www.youtube.com/embed/BUc12TDLw-w?start=12&rel=0");
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    fireEvent.error(poster);
    expect(within(gallery).queryByRole("img", { name: "Jaws poster" })).toBeNull();
    expect(within(gallery).getByRole("link", { name: "Jaws poster" })).toBeTruthy();
  });

  it.each([
    "https://www.youtube.com/embed/BUc12TDLw-w",
    "https://www.youtube-nocookie.com/embed/BUc12TDLw-w?start=30",
    "https://player.vimeo.com/video/123456789?autoplay=0&h=abc123",
  ])("preserves the returned player URL unchanged: %s", async (embeddingUrl) => {
    fetchMock.mockResolvedValue(Response.json(reply({
      sources: [{
        id: 1, title: "Retrieved trailer", url: "https://example.com/trailer",
        media: { type: "video", embeddingUrl },
      }],
    })));
    const { container } = render(<App />);
    send("Show me the trailer");
    const play = await screen.findByRole("button", { name: "Play video: Retrieved trailer" });
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(play);
    expect(screen.getByTitle("Retrieved trailer").getAttribute("src")).toBe(embeddingUrl);
  });

  it("does not load unsafe image URLs or executable media players", async () => {
    fetchMock.mockResolvedValue(Response.json(reply({
      sources: [
        { id: 1, title: "Unsafe image", url: "https://example.com/poster",
          media: { type: "image", imageUrl: "javascript:alert(1)", thumbnailUrl: "https://127.0.0.1/private" } },
        { id: 2, title: "Unsafe player", url: "https://example.com/video",
          media: { type: "video", embeddingUrl: "javascript:alert(1)" } },
      ],
    })));
    const { container } = render(<App />);
    send();
    await screen.findByRole("region", { name: "Retrieved media" });
    expect(container.querySelector("iframe, img")).toBeNull();
    expect(screen.queryByRole("button", { name: /Play video:/ })).toBeNull();
  });

  it("preserves line breaks in prose and Unicode-bulleted recommendations without changing code", async () => {
    fetchMock.mockResolvedValue(Response.json(reply({
      message: [
        "Other recent matches:",
        "\u2022 *Together* is a tense recommendation. [1]",
        "\u2022 *Keeper* is another option. [1]",
        "",
        "Start with Together.",
        "Then try Keeper.",
        "",
        "```text",
        "line one",
        "line two",
        "```",
      ].join("\n"),
    })));
    const { container } = render(<App />);
    send();
    await screen.findAllByRole("button", { name: "View sources: Arrival review" });

    const paragraphs = container.querySelectorAll(".markdown p");
    expect(paragraphs[0]!.querySelectorAll("br")).toHaveLength(2);
    expect(paragraphs[0]!.querySelectorAll("em")).toHaveLength(2);
    expect(paragraphs[1]!.querySelectorAll("br")).toHaveLength(1);
    expect(container.querySelector(".markdown pre code")?.textContent).toBe("line one\nline two\n");
    expect(container.querySelector(".markdown pre br")).toBeNull();
  });

  it("submits on Enter and leaves Shift+Enter available for a newline", async () => {
    fetchMock.mockResolvedValue(Response.json(reply()));
    render(<App />);
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Find a movie" } });

    expect(fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true })).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // JSDOM does not perform the browser's default newline insertion.
    fireEvent.change(input, { target: { value: "Find a movie\nSomething thoughtful" } });
    expect(fireEvent.keyDown(input, { key: "Enter", code: "Enter" })).toBe(false);

    await screen.findByRole("button", { name: "View sources: Arrival review" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string))
      .toEqual({ message: "Find a movie\nSomething thoughtful" });
  });

  it("renders Markdown and resolves only known HTTP citations without executing model markup", async () => {
    fetchMock.mockResolvedValue(Response.json(reply({
      message: [
        "- **Arrival** has thoughtful reviews. [1, 3]",
        "- Unknown source [99]. Inline `[1]` is code.",
        "",
        "[1](https://untrusted.example/) and [77](https://untrusted.example/)",
        "",
        "[1][review]",
        "",
        "[review]: https://untrusted.example/reference",
        "",
        "```text",
        "[1]",
        "```",
        "",
        '<script>alert("bad")</script>',
        "",
        "![tracking](https://untrusted.example/pixel)",
        "",
        "[unsafe](javascript:alert%281%29)",
      ].join("\n"),
      sources: [
        { id: 1, title: "Arrival review", url: "https://example.com/arrival" },
        { id: 3, title: "Unsafe source", url: "javascript:alert(1)" },
      ],
    })));
    const { container } = render(<App />);
    send();

    const citations = await screen.findAllByRole("button", { name: "View sources: Arrival review" });
    expect(citations).toHaveLength(3);
    expect(citations[0]!.textContent).toBe("example.com");
    expect(screen.queryByRole("region", { name: "Sources" })).toBeNull();
    expect(screen.queryByText("https://example.com/arrival")).toBeNull();
    fireEvent.click(citations[0]!);
    const preview = await screen.findByRole("dialog", { name: "Citation sources" });
    const link = await within(preview).findByRole("link");
    expect(link.getAttribute("href")).toBe("https://example.com/arrival");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("https://example.com/arrival");
    expect(container.querySelector(".markdown strong")?.textContent).toBe("Arrival");
    expect(container.querySelectorAll(".markdown ul li")).toHaveLength(2);
    expect(container.querySelector(".markdown pre code")?.textContent).toContain("[1]");
    expect(container.querySelectorAll(".markdown code")).toHaveLength(2);
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.querySelector('a[href*="untrusted"], a[href^="javascript:"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /View sources: Unsafe source/ })).toBeNull();
    expect(container.querySelector(".markdown")?.textContent).toContain("[99]");
    expect(screen.getByText("Science fiction")).toBeTruthy();
    expect(screen.getByText("Arrival movie reviews")).toBeTruthy();
    expect(screen.getByText(/1 model calls \(120 ms\)/)).toBeTruthy();
    expect(container.querySelector<HTMLDetailsElement>(".query-debug")?.open).toBe(false);
  });

  it("keeps citations scoped to each answer and sends only the new turn with its session ID", async () => {
    const debug = reply().debug;
    fetchMock
      .mockResolvedValueOnce(Response.json(reply({
        debug: { ...debug, evidence: [{
          id: 1, title: "Arrival review", url: "https://example.com/arrival",
          query: "Arrival movie reviews", content: "Arrival-only evidence.",
        }] },
      })))
      .mockResolvedValueOnce(Response.json(reply({
        message: "Try Dune. [1]",
        sources: [{ id: 1, title: "Dune review", url: "https://example.com/dune" }],
        debug: { ...debug, evidence: [{
          id: 1, title: "Dune review", url: "https://example.com/dune",
          query: "Dune movie reviews", content: "Dune-only evidence.",
        }] },
      })));
    render(<App />);
    send("Tell me about Arrival");
    const first = await screen.findByRole("button", { name: "View sources: Arrival review" });
    send("And Dune?");
    const second = await screen.findByRole("button", { name: "View sources: Dune review" });
    fireEvent.click(second);
    expect((await within(await screen.findByRole("dialog")).findByRole("link")).getAttribute("href"))
      .toBe("https://example.com/dune");
    fireEvent.click(screen.getByRole("button", { name: "Close sources" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(first);
    expect((await within(await screen.findByRole("dialog")).findByRole("link")).getAttribute("href"))
      .toBe("https://example.com/arrival");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string))
      .toEqual({ message: "Tell me about Arrival" });
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string))
      .toEqual({ sessionId: "session-one", message: "And Dune?" });
    const inspectors = screen.getAllByText("Inspect evidence (1 source)")
      .map((summary) => summary.closest("details")!);
    expect(inspectors).toHaveLength(2);
    expect(within(inspectors[0]!).getByText("Arrival-only evidence.")).toBeTruthy();
    expect(within(inspectors[0]!).queryByText("Dune-only evidence.")).toBeNull();
    expect(within(inspectors[1]!).getByText("Dune-only evidence.")).toBeTruthy();
    expect(within(inspectors[1]!).queryByText("Arrival-only evidence.")).toBeNull();
  });

  it("prevents concurrent turns or reset, then clears transcript and preferences for a new session", async () => {
    let complete!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    fetchMock.mockResolvedValueOnce(Response.json(reply({ sessionId: "session-two" })));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "What is showing near Seattle tonight?" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value)
      .toBe("What is showing near Seattle tonight?");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "New conversation" }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Searching Web IQ");
    await act(async () => { complete(Response.json(reply())); });
    await screen.findByRole("button", { name: "View sources: Arrival review" });
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    await screen.findByText("No preferences yet.");
    expect(screen.queryByRole("button", { name: "View sources: Arrival review" })).toBeNull();
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/session/session-one", { method: "DELETE" },
    ]);
    send("Start fresh");
    await screen.findByRole("button", { name: "View sources: Arrival review" });
    expect(JSON.parse(fetchMock.mock.calls[2]![1]!.body as string))
      .toEqual({ message: "Start fresh" });
    expect(sessionStorage.getItem(SESSION_STORAGE_KEY)).toBe("session-two");
  });

  it("shows a failed request and allows the next turn without losing session context", async () => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, "existing-session");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "The service is temporarily unavailable." }, { status: 500 }))
      .mockResolvedValueOnce(Response.json(reply({ sources: [], message: "Preferences recorded." })));
    render(<App />);
    send();
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The service is temporarily unavailable.")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).disabled).toBe(false));
    send("I like mysteries");
    await screen.findByText("Preferences recorded.");
    expect(JSON.parse(fetchMock.mock.calls[1]![1]!.body as string).sessionId)
      .toBe("existing-session");
  });

  it("groups adjacent citations and opens full URL previews by hover, keyboard and tap", async () => {
    fetchMock.mockResolvedValue(Response.json(reply({
      message: "Together [1, 2]. Adjacent [1][2]. Spaced [1] [2].",
      sources: [
        { id: 1, title: "Arrival review", url: "https://www.example.com/arrival" },
        { id: 2, title: "Dune review", url: "https://reviews.example.org/dune?edition=2026" },
      ],
    })));
    render(<App />);
    send();
    const pills = await screen.findAllByRole("button", {
      name: "View sources: Arrival review; Dune review",
    });
    expect(pills).toHaveLength(3);
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "example.com+1", "example.com+1", "example.com+1",
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.pointerEnter(pills[0]!, { pointerType: "mouse" });
    const preview = await screen.findByRole("dialog", { name: "Citation sources" });
    expect((await within(preview).findAllByRole("link")).map((link) => link.getAttribute("href")))
      .toEqual(["https://www.example.com/arrival", "https://reviews.example.org/dune?edition=2026"]);
    expect(within(preview).getByText("https://reviews.example.org/dune?edition=2026")).toBeTruthy();
    fireEvent.pointerLeave(pills[0]!);
    fireEvent.pointerEnter(preview);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.pointerLeave(preview);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => pills[0]!.focus());
    await screen.findByRole("dialog");
    const sourceLink = (await within(screen.getByRole("dialog")).findAllByRole("link"))[0]!;
    act(() => sourceLink.focus());
    fireEvent.keyDown(sourceLink, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(pills[0]);

    fireEvent.click(pills[1]!);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close sources" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(pills[1]);
  });
});
