// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { AzureOpenAI } from "openai";

import type {
  ConversationMessage,
  PlannedWebIqQuery,
  Preferences,
  WebIqSource,
} from "./types.js";

const MAX_QUERY_LENGTH = 900;

interface PlannerOutput {
  mode?: unknown;
  queries?: unknown;
  stop_reason?: unknown;
}

interface PlannerQuery {
  query?: unknown;
  purpose?: unknown;
  auto_mode?: unknown;
}

export interface FollowUpPlan {
  queries: PlannedWebIqQuery[];
  stopReason?: string;
}

function boundedHistory(history: ConversationMessage[]): ConversationMessage[] {
  return history.slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 2000) }));
}

export class QueryPlanner {
  readonly #client: AzureOpenAI;

  constructor(
    apiKey: string,
    endpoint: string,
    private readonly deployment: string,
    apiVersion: string,
    private readonly guidance: string,
    private readonly maxQueriesPerIteration: number,
  ) {
    this.#client = new AzureOpenAI({
      apiKey,
      endpoint,
      deployment,
      apiVersion,
    });
  }

  async planInitial(
    message: string,
    preferences: Preferences,
    remainingSearches: number,
    history: ConversationMessage[] = [],
    asOf = new Date(),
  ): Promise<PlannedWebIqQuery[]> {
    const output = await this.complete({
      task: "Create the initial Web IQ query plan.",
      current_date: asOf.toISOString().slice(0, 10),
      search_budget: {
        remaining_calls: remainingSearches,
        max_queries_this_pass: Math.min(this.maxQueriesPerIteration, remainingSearches),
      },
      user_request: message,
      supplied_context: {
        movie_preferences: preferences,
        conversation_context: boundedHistory(history),
      },
    });
    const plan = parsePlannerOutput(
      output,
      "initial",
      1,
      Math.min(this.maxQueriesPerIteration, remainingSearches),
    );
    return plan.queries;
  }

  async planFollowUp(
    message: string,
    preferences: Preferences,
    issuedQueries: PlannedWebIqQuery[],
    evidence: WebIqSource[],
    iteration: number,
    remainingSearches: number,
    history: ConversationMessage[] = [],
  ): Promise<FollowUpPlan> {
    const output = await this.complete({
      task:
        "Assess all supplied evidence at the precision the user requested. Stop when supported figures can answer the request with appropriate dates or caveats. Otherwise create the minimum queries for genuine gaps, batching related missing items rather than searching each row separately.",
      original_user_request: message,
      search_budget: {
        remaining_calls: remainingSearches,
        max_queries_this_pass: Math.min(this.maxQueriesPerIteration, remainingSearches),
      },
      supplied_context: {
        movie_preferences: preferences,
        conversation_context: boundedHistory(history),
      },
      previous_queries: issuedQueries.map(({ query, purpose, autoMode }) => ({
        query,
        purpose,
        auto_mode: autoMode ?? "lite",
      })),
      accumulated_evidence: evidence.map((source) => ({
        title: source.title,
        url: source.url,
        updated_at: source.updatedAt ?? null,
        query: source.query,
        queries: [...new Set(source.passages?.map(({ query }) => query) ?? [source.query])],
        content: source.content,
      })),
    });
    const plan = parsePlannerOutput(
      output,
      "follow_up",
      iteration,
      this.maxQueriesPerIteration,
    );
    const previous = new Set(
      issuedQueries.map(({ query }) => normalizeForComparison(query)),
    );
    return {
      ...plan,
      queries: plan.queries.filter(
        ({ query }) => !previous.has(normalizeForComparison(query)),
      ).slice(0, remainingSearches),
    };
  }

  private async complete(payload: object): Promise<string> {
    const completion = await this.#client.chat.completions.create({
      model: this.deployment,
      messages: [
        {
          role: "system",
          content: this.guidance,
        },
        {
          role: "user",
          content: JSON.stringify(payload),
        },
      ],
      response_format: { type: "json_object" },
      max_completion_tokens: 1_600,
    });
    const content = completion.choices[0]?.message.content;
    if (!content) {
      throw new Error("The query planner returned an empty response.");
    }
    return content;
  }
}

export async function loadQueryGuidance(
  path = fileURLToPath(
    new URL("../prompts/webiq-query-guidance.txt", import.meta.url),
  ),
): Promise<string> {
  const guidance = (await readFile(path, "utf8")).trim();
  if (!guidance) {
    throw new Error(`Web IQ query guidance is empty: ${path}`);
  }
  return guidance;
}

export function parsePlannerOutput(
  value: string,
  expectedMode: "initial" | "follow_up",
  iteration: number,
  maxQueries: number,
): FollowUpPlan {
  let parsed: PlannerOutput;
  try {
    parsed = JSON.parse(value) as PlannerOutput;
  } catch (error) {
    throw new Error(
      `The query planner returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("The query planner response must be a JSON object.");
  }
  if (parsed.mode === "stop") {
    if (expectedMode === "initial") {
      throw new Error("The query planner cannot stop before the initial search.");
    }
    return {
      queries: [],
      stopReason:
        typeof parsed.stop_reason === "string"
          ? parsed.stop_reason.trim()
          : "Evidence is sufficient.",
    };
  }
  if (parsed.mode !== expectedMode) {
    throw new Error(
      `The query planner returned mode ${String(parsed.mode)}; expected ${expectedMode}.`,
    );
  }
  if (!Array.isArray(parsed.queries)) {
    throw new Error("The query planner response must contain a queries array.");
  }

  const queries: PlannedWebIqQuery[] = [];
  const seen = new Set<string>();
  for (const candidate of parsed.queries as PlannerQuery[]) {
    if (
      !isRecord(candidate) ||
      typeof candidate.query !== "string" ||
      typeof candidate.purpose !== "string"
    ) {
      throw new Error(
        "Every planned query must contain string query and purpose values.",
      );
    }
    const query = candidate.query.trim().slice(0, MAX_QUERY_LENGTH);
    const purpose = candidate.purpose.trim().slice(0, 240);
    if (!query || !purpose) {
      throw new Error("Planned query and purpose values cannot be empty.");
    }
    const autoMode = candidate.auto_mode === undefined ? "lite" : candidate.auto_mode;
    if (autoMode !== "lite" && autoMode !== "advanced") {
      throw new Error('Planned query auto_mode must be either "lite" or "advanced".');
    }
    const comparison = normalizeForComparison(query);
    if (!seen.has(comparison)) {
      seen.add(comparison);
      queries.push({ query, purpose, autoMode, iteration });
    }
  }

  return {
    queries: queries.slice(0, maxQueries),
  };
}

function normalizeForComparison(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
