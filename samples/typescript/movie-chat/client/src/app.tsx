// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useLocalRuntime,
} from "@assistant-ui/react";
import { useMemo, useState } from "react";

import { AssistantAnswer, QueryDebug } from "./assistantAnswer";
import { createChatAdapter, SESSION_STORAGE_KEY } from "./chatAdapter";
import { emptyPreferences, type Preferences } from "./types";
import { MediaCards } from "./media";

const suggestions = [
  "What is showing near Seattle tonight?",
  "Find thoughtful science-fiction movies like Arrival.",
  "What are the latest movie announcements this week?",
  "Compare Arrival reviews from rogerebert.com and variety.com.",
  "Show me the trailer for Avengers: Doomsday.",
  "Show me the Titanic movie poster.",
  "What was the total box office for each of the 2024 Best Picture Oscar nominees?",
];

export function App() {
  const [conversation, setConversation] = useState(0);
  return (
    <Conversation
      key={conversation}
      onReset={() => setConversation((value) => value + 1)}
    />
  );
}

function Conversation({ onReset }: { onReset: () => void }) {
  const [preferences, setPreferences] = useState(emptyPreferences);
  const adapter = useMemo(() => createChatAdapter(setPreferences), []);
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MovieChat preferences={preferences} onReset={onReset} />
    </AssistantRuntimeProvider>
  );
}

function MovieChat({
  preferences,
  onReset,
}: {
  preferences: Preferences;
  onReset: () => void;
}) {
  const running = useAuiState((state) => state.thread.isRunning);
  const [resetting, setResetting] = useState(false);
  const busy = running || resetting;

  async function resetSession() {
    setResetting(true);
    const sessionId = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (sessionId) {
      await fetch(`/api/session/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
    sessionStorage.removeItem(SESSION_STORAGE_KEY);
    onReset();
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">WEB IQ SAMPLE</p>
          <h1>Movie Night</h1>
          <p className="subtitle">
            Explore movies, actors, reviews, recommendations, and current
            showtimes through web-grounded conversation.
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={busy}
          onClick={resetSession}
        >
          New conversation
        </button>
      </header>
      <section className="workspace">
        <aside className="preferences-panel">
          <h2>Your session preferences</h2>
          <p className="panel-copy">
            Preferences are inferred only from this conversation and disappear
            when the server session expires.
          </p>
          <PreferenceList value={preferences} />
          <h2>Try asking</h2>
          <div className="suggestion-list">
            {suggestions.map((prompt) => (
              <ThreadPrimitive.Suggestion
                key={prompt}
                prompt={prompt}
                send={false}
                disabled={busy}
              >
                {prompt}
              </ThreadPrimitive.Suggestion>
            ))}
          </div>
        </aside>
        <ThreadPrimitive.Root className="chat-panel" aria-label="Movie chat">
          <ThreadPrimitive.Viewport className="messages" aria-live="polite">
            <AuiIf condition={(state) => state.thread.isEmpty}>
              <article className="message assistant-message">
                <div className="message-label">Movie Night</div>
                <p>
                  Tell me what you enjoy, ask about a movie or actor, or give me
                  your location for current showtimes.
                </p>
              </article>
            </AuiIf>
            <ThreadPrimitive.Messages>
              {({ message }) => message.role === "user"
                ? <UserMessage />
                : <AssistantMessage />}
            </ThreadPrimitive.Messages>
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="composer">
            <label htmlFor="message" className="sr-only">Message</label>
            <ComposerPrimitive.Input
              id="message"
              rows={2}
              maxLength={2000}
              placeholder="Ask about a movie, actor, review, recommendation, or showtime..."
              disabled={busy}
              submitMode="enter"
              cancelOnEscape={false}
              autoFocus
            />
            <ComposerPrimitive.Send disabled={busy}>Send</ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
          <p className="status" role="status">
            {running
              ? "Searching Web IQ and preparing a response..."
              : resetting ? "Starting a new conversation..." : ""}
          </p>
        </ThreadPrimitive.Root>
      </section>
    </main>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message user-message">
      <div className="message-label">You</div>
      <div className="user-text"><MessagePrimitive.Parts /></div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message assistant-message">
      <div className="message-label">Movie Night</div>
      <MessagePrimitive.Parts components={{ Text: AssistantAnswer }} />
      <MediaCards />
      <MessagePrimitive.Error>
        <ErrorPrimitive.Root className="message-error" role="alert">
          <ErrorPrimitive.Message />
        </ErrorPrimitive.Root>
      </MessagePrimitive.Error>
      <QueryDebug />
    </MessagePrimitive.Root>
  );
}

function PreferenceList({ value }: { value: Preferences }) {
  const groups: Array<[string, string[]]> = [
    ["Location", value.location ? [value.location] : []],
    ["Genres", value.genres],
    ["Avoid", value.dislikedGenres],
    ["Movies", value.favoriteMovies],
    ["Actors", value.actors],
    ["Critics", value.critics],
    ["Notes", value.notes],
  ];
  const populated = groups.filter(([, items]) => items.length > 0);
  return (
    <div className="preference-list">
      {populated.length === 0 && <span className="empty-state">No preferences yet.</span>}
      {populated.map(([label, items]) => (
        <section key={label}>
          <h3>{label}</h3>
          <div className="chips">
            {items.map((item, index) => <span className="chip" key={index}>{item}</span>)}
          </div>
        </section>
      ))}
    </div>
  );
}
