// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";

import { SessionStore } from "./sessionStore.js";
import { emptyPreferences } from "./types.js";

describe("SessionStore", () => {
  it("ignores deleted sessions and stale objects with the same ID", () => {
    const store = new SessionStore(120, 4);
    try {
      const session = store.getOrCreate();
      const stale = { ...session };
      store.update(stale, [{ role: "user", content: "Stale request." }], emptyPreferences());
      expect(store.getOrCreate(session.id)).toBe(session);
      expect(session.messages).toEqual([]);
      store.delete(session.id);
      store.update(session, [{ role: "user", content: "Late request." }], emptyPreferences());
      expect(store.delete(session.id)).toBe(false);
      expect(session.messages).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("does not extend an expired session even before periodic cleanup runs", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const store = new SessionStore(1, 4);
    try {
      const session = store.getOrCreate();
      now.mockReturnValue(61001);
      store.update(session, [{ role: "user", content: "Expired request." }], emptyPreferences());
      expect(session.messages).toEqual([]);
      expect(session.lastAccessedAt).toBe(1000);
      expect(store.delete(session.id)).toBe(false);
      expect(store.getOrCreate(session.id).id).not.toBe(session.id);
    } finally {
      store.close();
      now.mockRestore();
    }
  });

  it("reuses an active session and deletes it explicitly", () => {
    const store = new SessionStore(120, 4);
    const created = store.getOrCreate();
    const reused = store.getOrCreate(created.id);

    expect(reused.id).toBe(created.id);
    expect(store.delete(created.id)).toBe(true);
    expect(store.getOrCreate(created.id).id).not.toBe(created.id);
    store.close();
  });
});
