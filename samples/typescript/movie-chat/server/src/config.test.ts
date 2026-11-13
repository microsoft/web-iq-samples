// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it.each([
    { limit: undefined, expected: 8 },
    { limit: 3, expected: 3 },
    { limit: 0, expected: undefined },
    { limit: -1, expected: undefined },
    { limit: 1.5, expected: undefined },
    { limit: 41, expected: undefined },
    { limit: "8", expected: undefined },
    { limit: null, expected: undefined },
  ])("loads defaults or validates max_total_queries=$limit", async ({ limit, expected }) => {
    const directory = await mkdtemp(join(tmpdir(), "movie-chat-config-"));
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        webiq: {
          base_url: "https://api.microsoft.ai/v3",
          max_response_length: 18000,
          max_sources: 12,
        },
        azure_openai: {
          endpoint: "https://example.openai.azure.com/",
          deployment: "movie-model",
          api_version: "example-version",
        },
        query_planning: {
          mode: "initial",
          max_iterations: 5,
          max_queries_per_iteration: 5,
          max_total_queries: limit,
        },
        server: {
          port: 3000,
          session_ttl_minutes: 120,
          max_history_messages: 12,
        },
      }),
    );

    if (expected === undefined) {
      await expect(loadConfig(path)).rejects.toThrow("max_total_queries must be an integer");
      return;
    }
    const config = await loadConfig(path);
    expect(config.azureOpenAI.deployment).toBe("movie-model");
    expect(config.webiq.maxSources).toBe(12);
    expect(config.queryPlanning.maxIterations).toBe(5);
    expect(config.queryPlanning.maxTotalQueries).toBe(expected);
  });

  it("rejects placeholders", async () => {
    const directory = await mkdtemp(join(tmpdir(), "movie-chat-config-"));
    const path = join(directory, "config.json");
    await writeFile(
      path,
      JSON.stringify({
        webiq: {
          base_url: "https://api.microsoft.ai/v3",
          max_response_length: 18000,
          max_sources: 12,
        },
        azure_openai: {
          endpoint: "https://<resource>.openai.azure.com/",
          deployment: "movie-model",
          api_version: "example-version",
        },
        query_planning: {
          mode: "initial",
          max_iterations: 5,
          max_queries_per_iteration: 5,
        },
        server: {
          port: 3000,
          session_ttl_minutes: 120,
          max_history_messages: 12,
        },
      }),
    );

    await expect(loadConfig(path)).rejects.toThrow("endpoint placeholder");
  });
});
