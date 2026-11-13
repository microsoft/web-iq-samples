// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ChatModelAdapter } from "@assistant-ui/react";

import type { ChatResponse, Preferences } from "./types";

export const SESSION_STORAGE_KEY = "webiq-movie-chat-session";

export function createChatAdapter(
  onPreferences: (preferences: Preferences) => void,
): ChatModelAdapter {
  return {
    async run({ messages, abortSignal }) {
      const lastMessage = messages.at(-1);
      if (lastMessage?.role !== "user") {
        throw new Error("Send a new message to continue.");
      }
      const message = lastMessage.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

      // Express owns bounded conversation history; send only the new user turn.
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: abortSignal,
        body: JSON.stringify({
          sessionId: sessionStorage.getItem(SESSION_STORAGE_KEY) ?? undefined,
          message,
        }),
      });
      const payload = (await response.json()) as ChatResponse | { error: string };
      if (!response.ok || !("sessionId" in payload)) {
        throw new Error("error" in payload ? payload.error : "The chat request failed.");
      }
      abortSignal.throwIfAborted();
      sessionStorage.setItem(SESSION_STORAGE_KEY, payload.sessionId);
      onPreferences(payload.preferences);
      return {
        content: [{ type: "text", text: payload.message }],
        metadata: { custom: { sources: payload.sources, debug: payload.debug } },
      };
    },
  };
}
