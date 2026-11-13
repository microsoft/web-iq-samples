// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useAuiState } from "@assistant-ui/react";
import { useState } from "react";

import { safeHttpUrl } from "./citations";
import type { MediaEvidence, Source } from "./types";

export function MediaCards() {
  const sources = useAuiState(
    (state) => state.message.metadata.custom.sources as Source[] | undefined,
  ) ?? [];
  const mediaSources = sources.filter(
    (source): source is Source & { media: MediaEvidence } =>
      !!source.media && !!safeHttpUrl(source.url),
  ).slice(0, 3);
  if (mediaSources.length === 0) return null;
  return (
    <section className="media-cards" aria-label="Retrieved media">
      {mediaSources.map((source) => <MediaCard key={source.id} source={source} />)}
    </section>
  );
}

function MediaCard({ source }: { source: Source & { media: MediaEvidence } }) {
  const [playing, setPlaying] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const media = source.media;
  const player = media.type === "video" ? safePlayerUrl(media.embeddingUrl) : undefined;
  const image = media.type === "image" ? safeMediaUrl(media.imageUrl) : undefined;
  const preview = safeMediaUrl(media.thumbnailUrl) ?? image;
  const thumbnail = !previewFailed && preview
    ? <img src={preview} alt={source.title} loading="lazy" decoding="async"
        referrerPolicy="no-referrer" onError={() => setPreviewFailed(true)} />
    : <span className="media-placeholder">Preview unavailable</span>;

  return (
    <figure className={`media-card media-${media.type}`}>
      {media.type === "image"
        ? <a href={image ?? source.url} target="_blank" rel="noopener noreferrer">{thumbnail}</a>
        : playing && player
          ? <iframe
              src={player}
              title={source.title}
              sandbox="allow-scripts allow-same-origin allow-presentation"
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          : player
            ? <button className="media-play" type="button" aria-label={`Play video: ${source.title}`}
                onClick={() => setPlaying(true)}>
                {thumbnail}
                <span className="media-play-label">Play video</span>
              </button>
            : <a href={source.url} target="_blank" rel="noopener noreferrer">{thumbnail}</a>}
      <figcaption>
        <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}</a>
        <span>{media.type === "video" ? "Video" : "Image"} from {new URL(source.url).hostname.replace(/^www\./, "")}</span>
        {media.type === "video" && <a href={source.url} target="_blank" rel="noopener noreferrer">Watch at source</a>}
      </figcaption>
    </figure>
  );
}

function safeMediaUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        url.hostname.includes(".") && !/^[\d.]+$/.test(url.hostname) &&
        !/\.(?:localhost|local|internal)$/.test(url.hostname)) return url.toString();
  } catch {
    // Media can only load from HTTPS evidence URLs.
  }
  return undefined;
}

function safePlayerUrl(value: string | undefined): string | undefined {
  const safe = safeMediaUrl(value);
  if (!safe) return undefined;
  const url = new URL(safe);
  if (/^(?:www\.)?youtube(?:-nocookie)?\.com$/.test(url.hostname) &&
      /^\/embed\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) return value;
  if (url.hostname === "player.vimeo.com" && /^\/video\/\d+$/.test(url.pathname)) {
    return value;
  }
  return undefined;
}
