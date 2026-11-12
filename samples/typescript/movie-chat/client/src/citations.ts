// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Link, Root, Text } from "mdast";
import { visit } from "unist-util-visit";

import type { Source } from "./types";

export function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString();
    }
  } catch {
    // Invalid source URLs remain visible but are never clickable.
  }
  return undefined;
}

// Link numeric citations in parsed prose without touching code.
export function remarkCitations({ sources }: { sources: Source[] }) {
  const validIds = new Set(
    sources.filter((source) => safeHttpUrl(source.url)).map((source) => source.id),
  );
  function citationNodes(values: string[]): Array<Text | Link> {
    const ids = [...new Set(values.map(Number))];
    const known = ids.filter((id) => validIds.has(id));
    const unknown = ids.filter((id) => !validIds.has(id));
    const nodes: Array<Text | Link> = [];
    if (known.length > 0) {
      nodes.push({
        type: "link",
        url: `#citation-${known.join(",")}`,
        children: [{ type: "text", value: known.map((id) => `[${id}]`).join("") }],
      });
    }
    if (unknown.length > 0) {
      nodes.push({ type: "text", value: unknown.map((id) => `[${id}]`).join(" ") });
    }
    return nodes;
  }
  return (tree: Root) => {
    visit(tree, (node, index, parent) => {
      if (!parent || index === undefined) return;
      if (node.type === "link" || node.type === "linkReference") {
        const label = node.children.length === 1 && node.children[0]?.type === "text"
          ? node.children[0].value
          : "";
        const match = /^\[?(\d+(?:[,\s]+\d+)*)\]?$/.exec(label);
        if (match) {
          // A model-authored URL cannot override a returned citation's URL.
          const nodes = citationNodes(match[1]!.match(/\d+/g)!);
          parent.children.splice(index, 1, ...nodes);
          return index + nodes.length;
        }
        return "skip";
      }
      if (node.type !== "text") return;
      const parts: Array<Text | Link> = [];
      let offset = 0;
      for (const match of node.value.matchAll(/\[\d+(?:[,\s]+\d+)*\](?:\s*\[\d+(?:[,\s]+\d+)*\])*/g)) {
        parts.push({ type: "text", value: node.value.slice(offset, match.index) });
        parts.push(...citationNodes(match[0].match(/\d+/g)!));
        offset = match.index + match[0].length;
      }
      if (offset > 0) {
        parts.push({ type: "text", value: node.value.slice(offset) });
        parent.children.splice(index, 1, ...parts);
        return index + parts.length;
      }
    });
  };
}
