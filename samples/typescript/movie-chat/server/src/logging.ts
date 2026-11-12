// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { AsyncLocalStorage } from "node:async_hooks";

export const requestContext = new AsyncLocalStorage<string>();

export function logEvent(
  event: string,
  fields: Record<string, unknown>,
  level: "info" | "error" = "info",
): void {
  console[level](JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    level,
    requestId: requestContext.getStore(),
    ...fields,
  }));
}
