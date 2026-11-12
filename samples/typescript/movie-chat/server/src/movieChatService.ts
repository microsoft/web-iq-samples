// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { AppConfig } from "./config.js";
import { logEvent } from "./logging.js";
import { QueryPlanner } from "./queryPlanner.js";
import { SessionStore } from "./sessionStore.js";
import type { MovieModel } from "./movieModel.js";
import {
  emptyPreferences,
  type ChatResponse,
  type ModelCallDebug,
  type PlannedWebIqQuery,
  type WebIqCallDebug,
  type WebIqSource,
} from "./types.js";
import {
  mergeSources,
  type WebIqClient,
  type WebIqSearchCall,
} from "./webIqClient.js";

export class MovieChatService {
  constructor(
    private readonly sessions: SessionStore,
    private readonly webIq: WebIqClient,
    private readonly queryPlanner: QueryPlanner,
    private readonly model: MovieModel,
    private readonly deployment: string,
    private readonly queryPlanning: AppConfig["queryPlanning"],
    private readonly maxSources: number,
  ) {}

  async chat(sessionId: string | undefined, message: string): Promise<ChatResponse> {
    const normalizedMessage = message.trim();
    if (!normalizedMessage) {
      throw new Error("Message is required.");
    }
    if (normalizedMessage.length > 2_000) {
      throw new Error("Message must be 2,000 characters or fewer.");
    }

    const session = this.sessions.getOrCreate(sessionId);
    const retrievalPreferences = shouldUseStoredPreferences(normalizedMessage)
      ? session.preferences
      : emptyPreferences();
    const modelCalls: ModelCallDebug[] = [];
    let remainingSearches = this.queryPlanning.maxTotalQueries;
    const queryPlanningStartedAt = performance.now();
    const plannedQueries = (await this.queryPlanner.planInitial(
      normalizedMessage,
      retrievalPreferences,
      remainingSearches,
      session.messages,
    )).slice(0, Math.min(this.queryPlanning.maxQueriesPerIteration, remainingSearches));
    remainingSearches -= plannedQueries.length;
    modelCalls.push({
      stage: "query_planning",
      purpose: "Plan focused Web IQ retrieval queries.",
      iteration: 1,
      durationMs: elapsedMilliseconds(queryPlanningStartedAt),
    });
    const initialSearch = await this.webIq.search(
      plannedQueries.map(({ query, autoMode = "lite" }) => ({ query, autoMode })),
    );
    let sources = initialSearch.sources;
    const webIqCalls = toWebIqCallDebug(plannedQueries, initialSearch.calls);

    if (this.queryPlanning.mode === "iterative" && plannedQueries.length > 0) {
      for (
        let iteration = 2;
        iteration <= this.queryPlanning.maxIterations && remainingSearches > 0;
        iteration += 1
      ) {
        const assessmentStartedAt = performance.now();
        const followUp = await this.queryPlanner.planFollowUp(
          normalizedMessage,
          retrievalPreferences,
          plannedQueries,
          sources,
          iteration,
          remainingSearches,
          session.messages,
        );
        modelCalls.push({
          stage: "evidence_assessment",
          purpose:
            "Assess accumulated evidence and plan only necessary follow-up retrieval.",
          iteration,
          durationMs: elapsedMilliseconds(assessmentStartedAt),
        });
        const queries = followUp.queries.slice(
          0, Math.min(this.queryPlanning.maxQueriesPerIteration, remainingSearches),
        );
        if (queries.length === 0) {
          break;
        }
        plannedQueries.push(...queries);
        remainingSearches -= queries.length;
        const additionalSearch = await this.webIq.search(
          queries.map(({ query, autoMode = "lite" }) => ({ query, autoMode })),
        );
        webIqCalls.push(
          ...toWebIqCallDebug(queries, additionalSearch.calls),
        );
        sources = mergeSources(
          sources,
          additionalSearch.sources,
          this.maxSources,
        );
      }
    }

    const answerStartedAt = performance.now();
    const result = await this.model.respond(
      normalizedMessage,
      session.messages,
      session.preferences,
      sources,
      this.deployment,
      remainingSearches === 0,
    );
    const answerDurations = result.answerDurationsMs ?? [elapsedMilliseconds(answerStartedAt)];
    modelCalls.push(...answerDurations.map((durationMs, index): ModelCallDebug => ({
      stage: "answer_generation",
      purpose: index === 0
        ? "Generate the grounded conversational response."
        : "Rewrite the answer to avoid excessive source copying.",
      durationMs,
    })));

    this.sessions.update(
      session,
      [
        ...session.messages,
        { role: "user", content: normalizedMessage },
        { role: "assistant", content: result.message },
      ],
      result.preferences,
    );

    const citedSources = selectCitedSources(result.message, sources);
    const citedUrls = [...new Set(citedSources.map(({ url }) => url))];
    logEvent("chat_citations", {
      citedUrlCount: citedUrls.length,
      ...(process.env["MOVIE_CHAT_LOG_RETRIEVAL_DETAILS"] !== "false"
        ? { citedUrls }
        : {}),
    });

    const displayedSources = new Set(citedSources);
    for (const source of sources) {
      if (source.media) displayedSources.add(source);
    }
    return {
      sessionId: session.id,
      message: result.message,
      preferences: result.preferences,
      webIqQueries: plannedQueries,
      debug: {
        modelCalls,
        webIqCalls,
        evidence: sources,
        totals: {
          modelCalls: modelCalls.length,
          webIqCalls: webIqCalls.length,
          modelDurationMs: sumDurations(modelCalls),
          webIqDurationMs: sumDurations(webIqCalls),
        },
      },
      sources: sources.filter((source) => displayedSources.has(source)).map(
        ({ content: _content, query: _query, passages: _passages, ...source }) => source,
      ),
    };
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }
}

function toWebIqCallDebug(
  plannedQueries: PlannedWebIqQuery[],
  calls: WebIqSearchCall[],
): WebIqCallDebug[] {
  const plannedByQuery = new Map(
    plannedQueries.map((planned) => [planned.query, planned]),
  );
  return calls.map((call) => {
    const planned = plannedByQuery.get(call.query);
    if (!planned) {
      throw new Error(`Missing query plan metadata for Web IQ call: ${call.query}`);
    }
    return {
      ...planned,
      autoMode: call.autoMode ?? planned.autoMode ?? "lite",
      durationMs: call.durationMs,
      traceId: call.traceId,
    };
  });
}

function sumDurations(calls: Array<{ durationMs: number }>): number {
  return calls.reduce((total, call) => total + call.durationMs, 0);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function shouldUseStoredPreferences(message: string): boolean {
  return [
    /\b(?:something|anything|movies?|films?|recommendations?)\s+(?:that\s+)?i(?:'d| would| might| may)\s+like\b/i,
    /\bwhat\s+(?:would|might|should)\s+i\s+(?:like|watch)\b/i,
    /\b(?:based on|using|use|consider)\s+my\s+(?:stored\s+)?(?:preferences?|taste|likes?|dislikes?|history)\b/i,
    /\b(?:personalized?|tailored)\s+(?:recommendations?\s+)?for\s+me\b/i,
    /\b(?:recommend|suggest)\s+(?:a\s+movie\s+|something\s+)?for\s+me\b/i,
    /\bmy\s+(?:movie\s+|viewing\s+)?(?:preferences?|taste)\b/i,
  ].some((pattern) => pattern.test(message));
}

export function selectCitedSources(
  message: string,
  sources: WebIqSource[],
): WebIqSource[] {
  const citedIds = new Set<number>();
  for (const match of message.matchAll(/\[([\d,\s]+)\]/g)) {
    for (const value of match[1]?.split(/[,\s]+/) ?? []) {
      const id = Number.parseInt(value, 10);
      if (Number.isInteger(id)) {
        citedIds.add(id);
      }
    }
  }
  return sources.filter(({ id }) => citedIds.has(id));
}
