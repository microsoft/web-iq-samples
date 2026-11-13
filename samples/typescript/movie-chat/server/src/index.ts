// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { loadConfig, requiredEnvironmentVariable } from "./config.js";
import { logEvent } from "./logging.js";
import { MovieChatService } from "./movieChatService.js";
import { MovieModel } from "./movieModel.js";
import { loadQueryGuidance, QueryPlanner } from "./queryPlanner.js";
import { SessionStore } from "./sessionStore.js";
import { createWebIqTokenProvider } from "./webIqAuth.js";
import { WebIqClient } from "./webIqClient.js";

const config = await loadConfig();
const queryGuidance = await loadQueryGuidance();
const webIqTokenProvider = createWebIqTokenProvider();
const azureOpenAiApiKey = requiredEnvironmentVariable("AZURE_OPENAI_API_KEY");
const sessions = new SessionStore(
  config.server.sessionTtlMinutes,
  config.server.maxHistoryMessages,
);
const webIq = new WebIqClient(
  webIqTokenProvider,
  config.webiq.baseUrl,
  config.webiq.maxResponseLength,
  config.webiq.maxSources,
);
const model = new MovieModel(
  azureOpenAiApiKey,
  config.azureOpenAI.endpoint,
  config.azureOpenAI.deployment,
  config.azureOpenAI.apiVersion,
);
const queryPlanner = new QueryPlanner(
  azureOpenAiApiKey,
  config.azureOpenAI.endpoint,
  config.azureOpenAI.deployment,
  config.azureOpenAI.apiVersion,
  queryGuidance,
  config.queryPlanning.maxQueriesPerIteration,
);
const service = new MovieChatService(
  sessions,
  webIq,
  queryPlanner,
  model,
  config.azureOpenAI.deployment,
  config.queryPlanning,
  config.webiq.maxSources,
);
const clientDistPath = fileURLToPath(new URL("../../client/dist", import.meta.url));
const app = createApp(service, clientDistPath);

const server = app.listen(config.server.port, () => {
  logEvent("service_started", { port: config.server.port });
});

function shutdown(): void {
  sessions.close();
  server.close((error) => {
    if (error) {
      logEvent("service_shutdown_error", { errorType: error.name }, "error");
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
