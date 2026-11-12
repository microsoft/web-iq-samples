// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ClientCertificateCredential, getBearerTokenProvider } from "@azure/identity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWebIqTokenProvider } from "./webIqAuth.js";

vi.mock("@azure/identity", () => ({
  ClientCertificateCredential: vi.fn(class {}),
  getBearerTokenProvider: vi.fn(),
}));

describe("Web IQ certificate authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AZURE_TENANT_ID", "test-tenant");
    vi.stubEnv("AZURE_CLIENT_ID", "test-client");
    vi.stubEnv("AZURE_CLIENT_CERTIFICATE_PATH", String.raw`C:\certs\webiq.pem`);
    vi.stubEnv("AZURE_CLIENT_CERTIFICATE_PASSWORD", undefined);
    vi.stubEnv("WEBIQ_API_KEY", "unused-api-key");
    vi.stubEnv("AZURE_CLIENT_SECRET", "unused-client-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the explicit certificate identity and Web IQ scope, preserving the password", async () => {
    vi.stubEnv("AZURE_CLIENT_CERTIFICATE_PASSWORD", " password with spaces ");
    const tokenProvider = vi.fn().mockResolvedValue("test-access-token");
    vi.mocked(getBearerTokenProvider).mockReturnValue(tokenProvider);

    const provider = createWebIqTokenProvider();

    expect(ClientCertificateCredential).toHaveBeenCalledWith(
      "test-tenant",
      "test-client",
      {
        certificatePath: String.raw`C:\certs\webiq.pem`,
        certificatePassword: " password with spaces ",
      },
    );
    expect(getBearerTokenProvider).toHaveBeenCalledWith(
      vi.mocked(ClientCertificateCredential).mock.instances[0],
      "https://api.microsoft.ai/.default",
    );
    expect(await provider()).toBe("test-access-token");
  });

  it("allows an unencrypted PEM without a password", () => {
    createWebIqTokenProvider();
    expect(ClientCertificateCredential).toHaveBeenCalledWith(
      "test-tenant",
      "test-client",
      { certificatePath: String.raw`C:\certs\webiq.pem`, certificatePassword: undefined },
    );
  });

  it.each([
    "AZURE_TENANT_ID",
    "AZURE_CLIENT_ID",
    "AZURE_CLIENT_CERTIFICATE_PATH",
  ])("rejects missing %s instead of falling back to another identity or an API key", (variable) => {
    vi.stubEnv(variable, " \t");
    expect(createWebIqTokenProvider).toThrow(variable);
    expect(ClientCertificateCredential).not.toHaveBeenCalled();
    expect(getBearerTokenProvider).not.toHaveBeenCalled();
  });
});
