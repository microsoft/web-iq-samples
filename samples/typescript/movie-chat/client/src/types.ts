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

export type MediaEvidence =
  | { type: "image"; imageUrl: string; thumbnailUrl?: string }
  | { type: "video"; embeddingUrl?: string; thumbnailUrl?: string };

export interface Source {
  id: number;
  title: string;
  url: string;
  contentSource?: string;
  updatedAt?: string;
  media?: MediaEvidence;
}

export interface EvidenceSource extends Source {
  content: string;
  query: string;
  passages?: Array<{ query: string; content: string }>;
}

export interface ChatDebug {
  modelCalls: Array<{
    stage: "query_planning" | "evidence_assessment" | "answer_generation";
    purpose: string;
    iteration?: number;
    durationMs: number;
  }>;
  webIqCalls: Array<{
    query: string;
    autoMode?: "lite" | "advanced";
    purpose: string;
    iteration: number;
    durationMs: number;
    traceId?: string;
  }>;
  evidence: EvidenceSource[];
  totals: {
    modelCalls: number;
    webIqCalls: number;
    modelDurationMs: number;
    webIqDurationMs: number;
  };
}

export interface ChatResponse {
  sessionId: string;
  message: string;
  preferences: Preferences;
  sources: Source[];
  debug: ChatDebug;
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
