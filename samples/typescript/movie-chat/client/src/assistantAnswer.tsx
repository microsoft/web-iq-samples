// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useAuiState } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { Citation } from "./citation";
import { remarkCitations, safeHttpUrl } from "./citations";
import type { ChatDebug, Source } from "./types";

const noSources: Source[] = [];

export function AssistantAnswer() {
  const sources = useAuiState(
    (state) => state.message.metadata.custom.sources as Source[] | undefined,
  ) ?? noSources;
  return (
      <MarkdownTextPrimitive
        className="markdown"
        smooth={false}
        skipHtml
        remarkPlugins={[remarkGfm, remarkBreaks, [remarkCitations, { sources }]]}
        urlTransform={(url, key) => key === "href" &&
          (/^#citation-\d+(?:,\d+)*$/.test(url) || safeHttpUrl(url)) ? url : ""}
        components={{
          img: () => null,
          a: ({ href, children }) => {
            const citation = /^#citation-(\d+(?:,\d+)*)$/.exec(href ?? "");
            if (citation) {
              const citedSources = citation[1]!.split(",")
                .map((id) => sources.find((source) => source.id === Number(id)))
                .filter((source): source is Source => !!source && !!safeHttpUrl(source.url));
              return citedSources.length > 0
                ? <Citation sources={citedSources} />
                : <span>{children}</span>;
            }
            const url = safeHttpUrl(href ?? "");
            if (!url) return <span>{children}</span>;
            return (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {children}
              </a>
            );
          },
        }}
      />
  );
}

export function QueryDebug() {
  const debug = useAuiState(
    (state) => state.message.metadata.custom.debug as ChatDebug | undefined,
  );
  if (!debug) return null;
  const evidence = debug.evidence ?? [];
  const stages = {
    query_planning: "Query planning",
    evidence_assessment: "Evidence assessment",
    answer_generation: "Answer generation",
  };
  return (
    <details className="query-debug">
      <summary>
        Debug: {debug.totals.modelCalls} model calls ({duration(debug.totals.modelDurationMs)})
        {" / "}{debug.totals.webIqCalls} Web IQ calls
        {" "}({duration(debug.totals.webIqDurationMs)} cumulative)
      </summary>
      <h4>Model calls</h4>
      <ol className="debug-call-list">
        {debug.modelCalls.map((call, index) => (
          <li key={index}>
            <strong>
              {stages[call.stage]}{call.iteration ? ` / iteration ${call.iteration}` : ""}
              {" / "}{duration(call.durationMs)}
            </strong>
            <span>{call.purpose}</span>
          </li>
        ))}
      </ol>
      <h4>Web IQ calls</h4>
      {debug.webIqCalls.length > 0
        ? (
          <ol className="debug-call-list">
            {debug.webIqCalls.map((call, index) => (
              <li key={index}>
                <strong>
                  Iteration {call.iteration} / {duration(call.durationMs)}: {call.purpose}
                </strong>
                <code>{call.query}</code>
              </li>
            ))}
          </ol>
        )
        : <p className="debug-empty">No Web IQ call was needed for this turn.</p>}
      <details className="evidence-inspector">
        <summary>Inspect evidence ({evidence.length} {evidence.length === 1 ? "source" : "sources"})</summary>
        <p className="evidence-intro">
          This is the deduplicated evidence supplied to the answer model, including sources
          not cited in its response. Text passages are limited to 3,000 characters per source.
          {" "}Media sources may contain normalized descriptions.
        </p>
        {evidence.length > 0
          ? <ol className="evidence-list">
              {evidence.map((source) => {
                const url = safeHttpUrl(source.url);
                const queries = [...new Set(
                  source.passages?.map(({ query }) => query) ?? [source.query],
                )];
                return (
                  <li key={source.id}>
                    <details className="evidence-source">
                      <summary>[{source.id}] ({evidenceTypeLabel(source)}) {source.title}</summary>
                      <div className="evidence-body">
                        {url
                          ? <a href={url} target="_blank" rel="noopener noreferrer">{url}</a>
                          : <span>Source URL unavailable</span>}
                        <span>{queries.length === 1 ? "Query" : "Queries"}: <code>{queries.join("; ")}</code></span>
                        <p>
                          <strong>{source.media
                            ? `${source.media.type === "image" ? "Image" : "Video"} source evidence`
                            : "Retrieved passage"}</strong>
                        </p>
                        <pre className="evidence-content">{source.content}</pre>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ol>
          : <p className="debug-empty">No usable evidence was supplied to the model for this turn.</p>}
      </details>
    </details>
  );
}

function evidenceTypeLabel(source: Source): string {
  if (source.media) return source.media.type === "image" ? "Image" : "Video";
  switch (source.contentSource?.trim().toLowerCase()) {
    case "web": return "Web";
    case "news": return "News";
    default: return "Text";
  }
}

function duration(milliseconds: number): string {
  return `${Math.round(milliseconds).toLocaleString()} ms`;
}
