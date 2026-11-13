// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";

import { logEvent, requestContext } from "./logging.js";
import type { MovieChatService } from "./movieChatService.js";

export function createApp(service: MovieChatService, clientDistPath?: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use("/api", (request, response, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      logEvent("api_request", {
        requestId,
        method: request.method,
        route: request.route?.path ?? "unmatched",
        status: response.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
        ...response.locals.metrics,
      });
    });
    requestContext.run(requestId, next);
  });
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post("/api/chat", async (request, response, next) => {
    try {
      const body = request.body as {
        sessionId?: unknown;
        message?: unknown;
      };
      const sessionId =
        typeof body.sessionId === "string" ? body.sessionId : undefined;
      if (typeof body.message !== "string") {
        response.status(400).json({ error: "message must be a string." });
        return;
      }
      if (!body.message.trim()) {
        response.status(400).json({ error: "message is required." });
        return;
      }
      if (body.message.length > 2_000) {
        response
          .status(400)
          .json({ error: "message must be 2,000 characters or fewer." });
        return;
      }

      const result = await service.chat(sessionId, body.message);
      response.locals.metrics = result.debug.totals;
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/session/:sessionId", (request, response) => {
    service.deleteSession(request.params.sessionId);
    response.status(204).send();
  });

  if (clientDistPath) {
    app.use(express.static(clientDistPath));
    app.get("*path", (_request, response) => {
      response.sendFile("index.html", { root: clientDistPath });
    });
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    // SDK error messages can include request bodies or authorization details.
    logEvent("api_error", {
      requestId: response.getHeader("x-request-id"),
      errorType: error instanceof Error ? error.name : "UnknownError",
    }, "error");
    response
      .status(500)
      .json({
        error: error instanceof Error && error.name === "ExcessiveCopyingError"
          ? "The answer was withheld because it copied too much source text. Please try asking for a shorter summary."
          : "The movie service could not complete the request.",
      });
  };
  app.use(errorHandler);

  return app;
}
