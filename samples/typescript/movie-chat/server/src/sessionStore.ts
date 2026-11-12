// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";

import { emptyPreferences, type ConversationMessage, type Preferences, type SessionState } from "./types.js";

export class SessionStore {
  readonly #sessions = new Map<string, SessionState>();
  readonly #ttlMilliseconds: number;
  readonly #maxHistoryMessages: number;
  readonly #cleanupTimer: NodeJS.Timeout;

  constructor(ttlMinutes: number, maxHistoryMessages: number) {
    this.#ttlMilliseconds = ttlMinutes * 60_000;
    this.#maxHistoryMessages = maxHistoryMessages;
    this.#cleanupTimer = setInterval(() => this.deleteExpired(), 60_000);
    this.#cleanupTimer.unref();
  }

  getOrCreate(sessionId?: string): SessionState {
    const now = Date.now();
    if (sessionId) {
      const existing = this.#sessions.get(sessionId);
      if (existing && now - existing.lastAccessedAt <= this.#ttlMilliseconds) {
        existing.lastAccessedAt = now;
        return existing;
      }
      this.#sessions.delete(sessionId);
    }

    const created: SessionState = {
      id: randomUUID(),
      createdAt: now,
      lastAccessedAt: now,
      messages: [],
      preferences: emptyPreferences(),
    };
    this.#sessions.set(created.id, created);
    return created;
  }

  update(
    session: SessionState,
    messages: ConversationMessage[],
    preferences: Preferences,
  ): SessionState {
    if (this.#sessions.get(session.id) !== session) return session;
    if (Date.now() - session.lastAccessedAt > this.#ttlMilliseconds) {
      this.#sessions.delete(session.id);
      return session;
    }
    session.messages = messages.slice(-this.#maxHistoryMessages);
    session.preferences = preferences;
    session.lastAccessedAt = Date.now();
    return session;
  }

  delete(sessionId: string): boolean {
    return this.#sessions.delete(sessionId);
  }

  deleteExpired(now = Date.now()): number {
    let deleted = 0;
    for (const [id, session] of this.#sessions) {
      if (now - session.lastAccessedAt > this.#ttlMilliseconds) {
        this.#sessions.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  close(): void {
    clearInterval(this.#cleanupTimer);
  }
}
