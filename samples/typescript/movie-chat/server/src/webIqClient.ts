// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";

import { logEvent } from "./logging.js";
import type { MediaEvidence, WebIqPassage, WebIqQuery, WebIqSource } from "./types.js";

const MAX_SOURCE_CONTENT = 3000;
const MAX_SOURCE_PASSAGES = 8;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_REQUESTS = 2;

export class WebIqDailyQuotaError extends Error {
  constructor() {
    super("The app's Web IQ daily request quota has been reached. Please try again later or contact the app administrator.");
    this.name = "WebIqDailyQuotaError";
  }
}

export interface WebIqSearchCall extends WebIqQuery {
  durationMs: number;
  traceId?: string;
  attempt?: number;
  status?: number;
}

export class WebIqTransientError extends Error {
  constructor(message: string, readonly calls: WebIqSearchCall[] = []) {
    super(message);
    this.name = "WebIqTransientError";
  }
}

export interface WebIqSearchResult {
  sources: WebIqSource[];
  calls: WebIqSearchCall[];
}

export function mergeSources(
  existing: Array<Omit<WebIqSource, "id">>,
  additional: Array<Omit<WebIqSource, "id">>,
  maxSources: number,
): WebIqSource[] {
  const byUrl = new Map<string, Omit<WebIqSource, "id">>();
  for (const source of [...existing, ...additional]) {
    const previous = byUrl.get(source.url);
    if (!previous) {
      byUrl.set(source.url, source);
      continue;
    }

    const distinct = new Map<string, WebIqPassage>();
    for (const item of [previous, source]) {
      const passages: WebIqPassage[] = item.passages ?? [{ query: item.query, content: item.content }];
      for (const passage of passages) {
        const fingerprint = passage.fingerprint
          ?? createHash("sha256").update(passage.content).digest("hex");
        if (!distinct.has(fingerprint)) distinct.set(fingerprint, { ...passage, fingerprint });
      }
    }
    const passages = [...distinct.values()].slice(-MAX_SOURCE_PASSAGES);
    let remaining = MAX_SOURCE_CONTENT - (passages.length - 1) * 2;
    const lengths = new Map<object, number>();
    // Allocate short passages first so unused space goes to longer passages.
    const shortestFirst = [...passages].sort((a, b) => a.content.length - b.content.length);
    for (const [index, passage] of shortestFirst.entries()) {
      const length = Math.min(passage.content.length, Math.floor(remaining / (passages.length - index)));
      lengths.set(passage, length);
      remaining -= length;
    }
    const bounded = passages.map((passage) => ({
      ...passage, content: passage.content.slice(0, lengths.get(passage)),
    }));
    byUrl.set(source.url, {
      ...previous,
      content: bounded.map(({ content }) => content).join("\n\n"),
      passages: bounded,
      media: previous.media ?? source.media,
      updatedAt: source.updatedAt ?? previous.updatedAt,
      contentSource: previous.contentSource ?? source.contentSource,
    });
  }

  const groups = new Map<string, Array<Omit<WebIqSource, "id">>>();
  for (const source of byUrl.values()) {
    const group = groups.get(source.query) ?? [];
    group.push(source);
    groups.set(source.query, group);
  }
  const selected: WebIqSource[] = [];
  for (let index = 0; selected.length < maxSources; index += 1) {
    let added = false;
    for (const group of groups.values()) {
      const source = group[index];
      if (!source) continue;
      selected.push({ ...source, id: selected.length + 1 });
      added = true;
      if (selected.length === maxSources) break;
    }
    if (!added) break;
  }
  return selected;
}

export class WebIqClient {
  private readonly inFlight = new Set<Promise<void>>();
  private retryNotBefore = 0;

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly baseUrl: string,
    private readonly maxResponseLength: number,
    private readonly maxSources: number,
  ) {}

  async search(queries: WebIqQuery[], maxCalls = queries.length * MAX_ATTEMPTS): Promise<WebIqSearchResult> {
    if (!Number.isInteger(maxCalls) || maxCalls < queries.length) {
      throw new Error("The Web IQ call budget must cover the initial queries.");
    }
    let remainingRetries = Math.max(0, maxCalls - queries.length);
    const takeRetry = () => {
      if (remainingRetries <= 0) return false;
      remainingRetries -= 1;
      return true;
    };
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
    const deadline = Date.now() + REQUEST_TIMEOUT_MS;
    const calls: WebIqSearchCall[] = [];
    const requests = queries.map((query) => this.searchQueued(query, takeRetry, deadline, signal, calls));
    try {
      const resultSets = await Promise.all(requests);
      return {
        sources: mergeSources([], resultSets.flat(), this.maxSources),
        calls,
      };
    } catch (error) {
      controller.abort();
      const settled = await Promise.allSettled(requests);
      const permanentFailure = settled.find((result) =>
        result.status === "rejected" && result.reason !== signal.reason
          && !(result.reason instanceof WebIqTransientError));
      const failure: unknown = permanentFailure?.status === "rejected" ? permanentFailure.reason : error;
      if (failure instanceof WebIqTransientError) {
        throw new WebIqTransientError(failure.message, calls);
      }
      if (failure instanceof Error && failure.name === "TimeoutError") {
        throw new WebIqTransientError("Web IQ retrieval exceeded this request's time limit.", calls);
      }
      throw failure;
    }
  }

  private async searchQueued(
    query: WebIqQuery,
    takeRetry: () => boolean,
    deadline: number,
    signal: AbortSignal,
    calls: WebIqSearchCall[],
  ) {
    while (this.inFlight.size >= MAX_CONCURRENT_REQUESTS) {
      await Promise.race(this.inFlight);
    }
    signal.throwIfAborted();
    const request = this.searchOne(query, takeRetry, deadline, signal, calls);
    const settled = request.then(() => undefined, () => undefined);
    this.inFlight.add(settled);
    try {
      return await request;
    } finally {
      this.inFlight.delete(settled);
    }
  }

  private async searchOne(
    { query, autoMode = "lite" }: WebIqQuery,
    takeRetry: () => boolean,
    deadline: number,
    signal: AbortSignal,
    calls: WebIqSearchCall[],
  ): Promise<Array<Omit<WebIqSource, "id">>> {
    const logRetrievalDetails = process.env["MOVIE_CHAT_LOG_RETRIEVAL_DETAILS"] !== "false";
    let retryAt = 0;
    for (let attempt = 1; ; attempt += 1) {
      const startedAt = performance.now();
      let status: number | undefined;
      let traceId: string | undefined;
      let resultCount: number | undefined;
      let sourceCount: number | undefined;
      let outcome: "success" | "error" = "error";
      let errorType: string | undefined;
      let retryable = false;
      let dispatched = false;
      try {
        await wait(Math.max(0, retryAt - Date.now()), signal);
        await this.waitForCooldown(deadline, signal);
        const accessToken = await this.getAccessToken();
        await this.waitForCooldown(deadline, signal);
        signal.throwIfAborted();
        dispatched = true;
        const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/auto`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query,
            mode: autoMode,
            contentType: "passage",
            maxLength: 3000,
            maxResponseLength: this.maxResponseLength,
            responseFilter: ["web", "news", "images", "videos"],
            language: "en",
            region: "US",
          }),
          signal,
        });
        status = response.status;
        const payload: unknown = await response.json().catch(() => undefined);
        signal.throwIfAborted();
        if (isRecord(payload) && typeof payload.traceId === "string") {
          traceId = payload.traceId;
        }
        if (!response.ok) {
          const errorCode = isRecord(payload) && typeof payload.errorCode === "string"
            ? payload.errorCode.toLowerCase() : "";
          if (errorCode === "authuserdailyusageexceeded") {
            throw new WebIqDailyQuotaError();
          }
          retryable = status === 429 || status === 500;
          if (retryable) {
            const now = Date.now();
            const backoffMs = (status === 500 ? 30_000 : 1_000) * 2 ** (attempt - 1);
            const bodyDelay = parseRetryDelay(isRecord(payload) ? payload.retryAfter : undefined, now);
            const headerDelay = parseRetryDelay(response.headers.get("retry-after"), now);
            retryAt = now + Math.max(bodyDelay ?? 0, headerDelay ?? 0,
              Math.min(backoffMs, 30_000)) + Math.floor(Math.random() * 250);
            if (status === 429) {
              this.retryNotBefore = Math.max(this.retryNotBefore, retryAt);
            }
          }
          const message = `Web IQ Auto request failed with ${response.status} ${response.statusText}.`;
          throw retryable ? new WebIqTransientError(message) : new Error(message);
        }
        if (!isRecord(payload) || !Array.isArray(payload.results)) {
          throw new Error("Web IQ Auto returned an invalid results array.");
        }
        resultCount = payload.results.length;
        const sources = payload.results.flatMap((result) => normalizeResult(result, query));
        sourceCount = sources.length;
        outcome = "success";
        return sources;
      } catch (error) {
        errorType = error instanceof Error ? error.name : "UnknownError";
        if (!retryable || attempt >= MAX_ATTEMPTS || retryAt >= deadline || !takeRetry()) {
          throw error;
        }
      } finally {
        const durationMs = elapsedMilliseconds(startedAt);
        // Only dispatched HTTP attempts consume the caller's retrieval budget.
        if (dispatched) {
          calls.push({ query, autoMode, durationMs, traceId, attempt, status });
        }
        logEvent("webiq_request", {
          operation: "auto",
          autoMode,
          status: status ?? null,
          traceId: traceId ?? null,
          outcome,
          durationMs,
          attempt,
          resultCount,
          sourceCount,
          errorType,
          ...(logRetrievalDetails ? { query } : {}),
        }, outcome === "error" ? "error" : "info");
      }
    }
  }

  private async waitForCooldown(deadline: number, signal: AbortSignal): Promise<void> {
    while (this.retryNotBefore > Date.now()) {
      if (this.retryNotBefore >= deadline) {
        throw new WebIqTransientError("Web IQ is rate limited beyond this request's time limit. Try again later.");
      }
      await wait(this.retryNotBefore - Date.now(), signal);
    }
  }
}

function parseRetryDelay(value: unknown, now: number): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?s?$/i.test(text)) {
    const milliseconds = Number.parseFloat(text) * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}T|^[A-Za-z]{3},/.test(text)) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeResult(result: unknown, query: string): Array<Omit<WebIqSource, "id">> {
  if (!isRecord(result) || !isRecord(result.evidence) || !Array.isArray(result.citations)) {
    return [];
  }
  const { type, content } = result.evidence;
  if (typeof content !== "string" && !isRecord(content)) return [];
  if (type === "text" || type === "text/news" ? typeof content !== "string" || !content.trim()
    : !["media/image", "media/video"].includes(String(type)) || !isRecord(content)) {
    return [];
  }
  if (isRecord(content) && content.isAdult === true) return [];

  return result.citations.flatMap((citation: unknown) => {
    if (!isRecord(citation) || citation.isAdult === true ||
        typeof citation.title !== "string" || !citation.title.trim()) return [];
    const url = httpUrl(citation.url);
    if (!url) return [];
    let media: MediaEvidence | undefined;
    if (type === "media/image" && isRecord(content)) {
      const imageUrl = httpUrl(content.url ?? citation.url, true);
      if (!imageUrl) return [];
      media = { type: "image", imageUrl, thumbnailUrl: httpUrl(content.thumbnailUrl, true) };
    } else if (type === "media/video" && isRecord(content)) {
      media = {
        type: "video",
        embeddingUrl: content.allowHttpsEmbedding === false
          ? undefined : httpUrl(content.embeddingUrl, true),
        thumbnailUrl: httpUrl(content.thumbnailUrl, true),
      };
    }
    return [{
      title: citation.title.trim(),
      url: type === "media/image" ? httpUrl(citation.hostPageUrl) ?? url : url,
      content: (typeof content === "string" ? content : [
        `${String(type)}: ${citation.title}`,
        ...[content.caption, content.description, content.summary]
          .filter((value): value is string => typeof value === "string"),
      ].join("\n")).trim().slice(0, MAX_SOURCE_CONTENT),
      contentSource: typeof citation.contentSource === "string" ? citation.contentSource : undefined,
      updatedAt: typeof citation.lastUpdatedAt === "string" ? citation.lastUpdatedAt : undefined,
      query,
      ...(media ? { media } : {}),
    }];
  });
}

function httpUrl(value: unknown, httpsOnly = false): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || !httpsOnly && url.protocol === "http:") &&
        !url.username && !url.password) return url.toString();
  } catch {
    // Omit malformed evidence URLs instead of exposing unsafe links.
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
