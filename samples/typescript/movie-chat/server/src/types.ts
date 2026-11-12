// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export interface Preferences {
  genres: string[];
  dislikedGenres: string[];
  favoriteMovies: string[];
  actors: string[];
  critics: string[];
  location?: string;
  notes: string[];
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SessionState {
  id: string;
  createdAt: number;
  lastAccessedAt: number;
  messages: ConversationMessage[];
  preferences: Preferences;
}

export type MediaEvidence =
  | { type: "image"; imageUrl: string; thumbnailUrl?: string }
  | { type: "video"; embeddingUrl?: string; thumbnailUrl?: string };

export interface WebIqPassage {
  query: string;
  content: string;
  fingerprint?: string;
}

export interface WebIqSource {
  id: number;
  title: string;
  url: string;
  content: string;
  contentSource?: string;
  updatedAt?: string;
  query: string;
  passages?: WebIqPassage[];
  media?: MediaEvidence;
}

export type WebIqMode = "lite" | "advanced";

export interface WebIqQuery {
  query: string;
  autoMode?: WebIqMode;
}

export interface PlannedWebIqQuery extends WebIqQuery {
  purpose: string;
  iteration: number;
}

export interface ModelCallDebug {
  stage: "query_planning" | "evidence_assessment" | "answer_generation";
  purpose: string;
  iteration?: number;
  durationMs: number;
}

export interface WebIqCallDebug extends PlannedWebIqQuery {
  durationMs: number;
  traceId?: string;
}

export interface ChatDebug {
  modelCalls: ModelCallDebug[];
  webIqCalls: WebIqCallDebug[];
  evidence: WebIqSource[];
  totals: {
    modelCalls: number;
    webIqCalls: number;
    modelDurationMs: number;
    webIqDurationMs: number;
  };
}

export interface ChatResult {
  message: string;
  preferences: Preferences;
  answerDurationsMs?: number[];
}

export interface ChatResponse {
  sessionId: string;
  message: string;
  preferences: Preferences;
  webIqQueries: PlannedWebIqQuery[];
  debug: ChatDebug;
  sources: Array<Omit<WebIqSource, "content" | "query" | "passages">>;
}

export function emptyPreferences(): Preferences {
  return {
    genres: [],
    dislikedGenres: [],
    favoriteMovies: [],
    actors: [],
    critics: [],
    notes: [],
  };
}
