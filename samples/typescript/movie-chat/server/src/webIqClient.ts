// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";

import { logEvent } from "./logging.js";
import type { MediaEvidence, WebIqPassage, WebIqQuery, WebIqSource } from "./types.js";

const MAX_SOURCE_CONTENT = 3000;
const MAX_SOURCE_PASSAGES = 8;

export interface WebIqSearchCall extends WebIqQuery {
  durationMs: number;
  traceId?: string;
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
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly baseUrl: string,
    private readonly maxResponseLength: number,
    private readonly maxSources: number,
  ) {}

  async search(queries: WebIqQuery[]): Promise<WebIqSearchResult> {
    const resultSets = await Promise.all(
      queries.map((query) => this.searchOne(query)),
    );
    return {
      sources: mergeSources([], resultSets.flatMap(({ sources }) => sources), this.maxSources),
      calls: resultSets.map(({ query, autoMode, durationMs, traceId }) => ({
        query,
        autoMode,
        durationMs,
        traceId,
      })),
    };
  }

  private async searchOne({ query, autoMode = "lite" }: WebIqQuery): Promise<WebIqSearchCall & {
    sources: Array<Omit<WebIqSource, "id">>;
  }> {
    const startedAt = performance.now();
    const logRetrievalDetails = process.env["MOVIE_CHAT_LOG_RETRIEVAL_DETAILS"] !== "false";
    let status: number | undefined;
    let traceId: string | undefined;
    let resultCount: number | undefined;
    let sourceCount: number | undefined;
    let outcome: "success" | "error" = "error";
    let errorType: string | undefined;
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/auto`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await this.getAccessToken()}`,
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
        signal: AbortSignal.timeout(60_000),
      });
      status = response.status;
      const payload: unknown = await response.json().catch(() => undefined);
      if (isRecord(payload) && typeof payload.traceId === "string") {
        traceId = payload.traceId;
      }
      if (!response.ok) {
        throw new Error(
          `Web IQ Auto request failed with ${response.status} ${response.statusText}.`,
        );
      }
      if (!isRecord(payload) || !Array.isArray(payload.results)) {
        throw new Error("Web IQ Auto returned an invalid results array.");
      }
      resultCount = payload.results.length;
      const sources = payload.results.flatMap((result) => normalizeResult(result, query));
      sourceCount = sources.length;
      outcome = "success";
      return {
        query,
        autoMode,
        durationMs: elapsedMilliseconds(startedAt),
        traceId,
        sources,
      };
    } catch (error) {
      errorType = error instanceof Error ? error.name : "UnknownError";
      throw error;
    } finally {
      logEvent("webiq_request", {
        operation: "auto",
        autoMode,
        status: status ?? null,
        traceId: traceId ?? null,
        outcome,
        durationMs: elapsedMilliseconds(startedAt),
        resultCount,
        sourceCount,
        errorType,
        ...(logRetrievalDetails ? { query } : {}),
      }, outcome === "error" ? "error" : "info");
    }
  }
}

function normalizeResult(result: unknown, query: string): Array<Omit<WebIqSource, "id">> {
  if (!isRecord(result) || !isRecord(result.evidence) || !Array.isArray(result.citations)) {
    return [];
  }
  const { type, content } = result.evidence;
  if (typeof content !== "string" && !isRecord(content)) return [];
  if (type === "text" ? typeof content !== "string" || !content.trim()
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
