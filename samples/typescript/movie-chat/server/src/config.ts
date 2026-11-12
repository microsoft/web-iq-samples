// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  webiq: {
    baseUrl: string;
    maxResponseLength: number;
    maxSources: number;
  };
  azureOpenAI: {
    endpoint: string;
    deployment: string;
    apiVersion: string;
  };
  queryPlanning: {
    mode: "initial" | "iterative";
    maxIterations: number;
    maxQueriesPerIteration: number;
    maxTotalQueries: number;
  };
  server: {
    port: number;
    sessionTtlMinutes: number;
    maxHistoryMessages: number;
  };
}

interface RawConfig {
  webiq?: {
    base_url?: unknown;
    max_response_length?: unknown;
    max_sources?: unknown;
  };
  azure_openai?: {
    endpoint?: unknown;
    deployment?: unknown;
    api_version?: unknown;
  };
  query_planning?: {
    mode?: unknown;
    max_iterations?: unknown;
    max_queries_per_iteration?: unknown;
    max_total_queries?: unknown;
  };
  server?: {
    port?: unknown;
    session_ttl_minutes?: unknown;
    max_history_messages?: unknown;
  };
}

export async function loadConfig(path = defaultConfigPath()): Promise<AppConfig> {
  let raw: RawConfig;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as RawConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read configuration file ${path}: ${message}`);
  }

  return {
    webiq: {
      baseUrl: requiredString(raw.webiq?.base_url, "webiq.base_url"),
      maxResponseLength: requiredInteger(
        raw.webiq?.max_response_length,
        "webiq.max_response_length",
        1500,
        500000,
      ),
      maxSources: requiredInteger(raw.webiq?.max_sources, "webiq.max_sources", 1, 30),
    },
    azureOpenAI: {
      endpoint: configuredString(raw.azure_openai?.endpoint, "azure_openai.endpoint"),
      deployment: configuredString(
        raw.azure_openai?.deployment,
        "azure_openai.deployment",
      ),
      apiVersion: configuredString(
        raw.azure_openai?.api_version,
        "azure_openai.api_version",
      ),
    },
    queryPlanning: {
      mode: queryPlanningMode(raw.query_planning?.mode),
      maxIterations: requiredInteger(
        raw.query_planning?.max_iterations,
        "query_planning.max_iterations",
        1,
        5,
      ),
      maxQueriesPerIteration: requiredInteger(
        raw.query_planning?.max_queries_per_iteration,
        "query_planning.max_queries_per_iteration",
        1,
        8,
      ),
      maxTotalQueries: requiredInteger(
        raw.query_planning?.max_total_queries === undefined
          ? 8
          : raw.query_planning.max_total_queries,
        "query_planning.max_total_queries",
        1,
        40,
      ),
    },
    server: {
      port: requiredInteger(raw.server?.port, "server.port", 1, 65535),
      sessionTtlMinutes: requiredInteger(
        raw.server?.session_ttl_minutes,
        "server.session_ttl_minutes",
        5,
        1440,
      ),
      maxHistoryMessages: requiredInteger(
        raw.server?.max_history_messages,
        "server.max_history_messages",
        2,
        40,
      ),
    },
  };
}

function queryPlanningMode(value: unknown): "initial" | "iterative" {
  if (value !== "initial" && value !== "iterative") {
    throw new Error(
      'query_planning.mode must be either "initial" or "iterative".',
    );
  }
  return value;
}

export function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Set the ${name} environment variable before running.`);
  }
  return value;
}

function defaultConfigPath(): string {
  return (
    process.env["MOVIE_CHAT_CONFIG"] ??
    fileURLToPath(new URL("../../config.json", import.meta.url))
  );
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function configuredString(value: unknown, name: string): string {
  const configured = requiredString(value, name);
  if (configured.includes("<") || configured.includes(">")) {
    throw new Error(`Replace the ${name} placeholder in config.json.`);
  }
  return configured;
}

function requiredInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}
