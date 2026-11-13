// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";

import type { Source } from "./types";

export function Citation({ sources }: { sources: Source[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restoringFocus = useRef(false);
  const domain = new URL(sources[0]!.url).hostname.replace(/^www\./, "");

  function cancelClose() {
    clearTimeout(closeTimer.current);
  }

  function show() {
    cancelClose();
    if (!restoringFocus.current) setOpen(true);
  }

  function closeAfterPointerLeaves() {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (document.activeElement !== trigger.current &&
          !content.current?.contains(document.activeElement)) {
        setOpen(false);
      }
    }, 180);
  }

  function restoreTriggerFocus() {
    restoringFocus.current = true;
    trigger.current?.focus();
    restoringFocus.current = false;
  }

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={trigger}
        className="citation-pill"
        aria-label={`View sources: ${sources.map((source) => source.title).join("; ")}`}
        onPointerEnter={(event) => { if (event.pointerType !== "touch") show(); }}
        onPointerLeave={closeAfterPointerLeaves}
        onFocus={show}
        onBlur={closeAfterPointerLeaves}
        onClick={(event) => { event.preventDefault(); show(); }}
      >
        <span className="citation-domain">{domain}</span>
        {sources.length > 1 && <span className="citation-count">+{sources.length - 1}</span>}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          className="citation-preview"
          aria-label="Citation sources"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          hideWhenDetached
          onPointerEnter={cancelClose}
          onPointerLeave={closeAfterPointerLeaves}
          onBlur={closeAfterPointerLeaves}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={restoreTriggerFocus}
        >
          <div className="citation-preview-header">
            <span>{sources.length === 1 ? "Source" : `${sources.length} sources`}</span>
            <Popover.Close aria-label="Close sources" onClick={restoreTriggerFocus}>
              Close
            </Popover.Close>
          </div>
          <ul className="citation-preview-list">
            {sources.map((source) => (
              <li key={source.id}>
                <a href={source.url} target="_blank" rel="noopener noreferrer">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <ellipse cx="12" cy="12" rx="4" ry="9" />
                    <path d="M3 12h18" />
                  </svg>
                  <span className="citation-source">
                    <span className="citation-title">{source.title}</span>
                    <span className="citation-url">{source.url}</span>
                    {source.updatedAt && <span className="citation-date">{source.updatedAt}</span>}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
