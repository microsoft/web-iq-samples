// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ClientCertificateCredential, getBearerTokenProvider } from "@azure/identity";

import { requiredEnvironmentVariable } from "./config.js";

export function createWebIqTokenProvider(): () => Promise<string> {
  const credential = new ClientCertificateCredential(
    requiredEnvironmentVariable("AZURE_TENANT_ID"),
    requiredEnvironmentVariable("AZURE_CLIENT_ID"),
    {
      certificatePath: requiredEnvironmentVariable("AZURE_CLIENT_CERTIFICATE_PATH"),
      certificatePassword: process.env["AZURE_CLIENT_CERTIFICATE_PASSWORD"],
    },
  );
  return getBearerTokenProvider(credential, "https://api.microsoft.ai/.default");
}
