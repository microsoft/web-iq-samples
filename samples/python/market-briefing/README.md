# Web IQ Market Briefing

Generate a cited Markdown report from current web and news passages. Web IQ retrieves the evidence and Azure OpenAI turns it into a concise briefing. Click a numbered citation to jump to its source entry, with a linked title and the full URL.

## Prerequisites

- Python 3.11 or later
- A Web IQ API key, or a Microsoft Entra app registration with an RSA certificate credential and Web IQ access
- An Azure OpenAI resource with a deployed model
- An Azure OpenAI API key

## Get started

Open PowerShell in this directory, then create an environment and install the sample:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install .
```

Set your API keys:

```powershell
$env:WEBIQ_API_KEY = "<your Web IQ API key>"
$env:AZURE_OPENAI_API_KEY = "<your Azure OpenAI API key>"
```

Edit `config.json` and replace the Azure OpenAI placeholders:

```json
{
  "azure_openai": {
    "endpoint": "https://<your-resource-name>.openai.azure.com/",
    "deployment": "<your-deployment-name>",
    "api_version": "<your-api-version>"
  }
}
```

Generate the report:

```powershell
webiq-market-briefing `
  "North American energy market" `
  --output reports\energy-briefing.md
```

Open the result:

```powershell
code reports\energy-briefing.md
```

## Configuration

API keys are read from environment variables. Azure OpenAI endpoint, deployment, and API version are read from `config.json`. The deployment name may differ from the underlying model name. Azure OpenAI continues to use its API key in both Web IQ authentication modes.

Use another configuration file with:

```powershell
webiq-market-briefing "Energy market" --config path\to\config.json
```

### Use Microsoft Entra ID for Web IQ

API-key authentication is the default. To use Entra instead, first have your Entra application provisioned for Web IQ with the required web and news entitlements. Obtaining a token alone does not grant API access.

The sample explicitly uses Azure Identity's `CertificateCredential` and requests the scope `https://api.microsoft.ai/.default`. Entra mode reads the following environment variables:

| Variable | Purpose |
| --- | --- |
| `AZURE_TENANT_ID` | Directory (tenant) ID of the app registration |
| `AZURE_CLIENT_ID` | Application (client) ID, not the application's object ID |
| `AZURE_CLIENT_CERTIFICATE_PATH` | Path to a PEM or PKCS12/PFX file containing the RSA certificate and its private key |
| `AZURE_CLIENT_CERTIFICATE_PASSWORD` | Password for an encrypted certificate file; omit only when the file is not encrypted |

There is no credential-chain fallback: Azure CLI sign-in, managed identity, and `AZURE_CLIENT_SECRET` are not used. `WEBIQ_API_KEY` is not read in Entra mode. Missing required settings or an unreadable/invalid certificate stop the run rather than falling back to another identity.

#### Register a certificate and run locally

Use your organization's approved certificate issuance process. For local testing only, if policy permits, this PowerShell example creates a self-signed RSA certificate valid for 90 days. It writes outside the repository and prompts for a new export password without placing it in command history:

```powershell
$certDir = Join-Path $env:USERPROFILE ".webiq-certs"
New-Item -ItemType Directory -Path $certDir -Force | Out-Null
$cert = New-SelfSignedCertificate `
  -Subject "CN=WebIQ-MarketBriefing-Dev" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyExportPolicy Exportable -KeySpec Signature `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddDays(90)
$password = Read-Host "Choose a PFX export password" -AsSecureString
Export-PfxCertificate -Cert $cert `
  -FilePath "$certDir\webiq-dev.pfx" -Password $password | Out-Null
Export-Certificate -Cert $cert `
  -FilePath "$certDir\webiq-dev.cer" | Out-Null
```

In Microsoft Entra ID, open **App registrations > your application > Certificates & secrets > Certificates > Upload certificate** and upload only `webiq-dev.cer`. Never upload or share the PFX or private key.

Set the following in the same PowerShell session that runs the sample. If using an existing PFX, enter its existing export password, not a new password:

```powershell
$env:AZURE_TENANT_ID = "<directory-tenant-id>"
$env:AZURE_CLIENT_ID = "<application-client-id>"
$env:AZURE_CLIENT_CERTIFICATE_PATH = Join-Path `
  $env:USERPROFILE ".webiq-certs\webiq-dev.pfx"
$password = Read-Host "Existing PFX password" -AsSecureString
$env:AZURE_CLIENT_CERTIFICATE_PASSWORD = (
  [System.Net.NetworkCredential]::new("", $password).Password
)
$env:AZURE_OPENAI_API_KEY = "<your Azure OpenAI API key>"
webiq-market-briefing "Energy market" --webiq-auth entra
```

The password decrypts the local private key; it is not your Microsoft account password or an Entra client secret. Azure Identity receives it explicitly from the sample and handles token acquisition and in-memory token caching. No interactive sign-in is required. After finishing all runs in this shell, clear the process-local password:

```powershell
Remove-Item Env:\AZURE_CLIENT_CERTIFICATE_PASSWORD -ErrorAction SilentlyContinue
```

Set it again before the next run if you cleared it or opened a new shell. `Failed to deserialize certificate in PEM or PKCS12 format` means the local file could not be loaded: verify the path points to the private-key PFX/PEM, not the public CER, and that the existing password is available in the process.

The application identity must resolve to your provisioned Web IQ App ID with **both Web and News entitlements**. This sample does not select among multiple App IDs; use an identity with one mapping. A successful token request does not prove endpoint access. For a 401 or 403, check the application mapping and both entitlements rather than repeatedly signing in.

#### Production certificate handling

- Use a dedicated, least-privileged application identity and an organization-approved certificate, not the development self-signed certificate.
- Deliver the private-key file through your deployment's secret mechanism, restrict file access to the workload identity, and supply its password through a protected runtime secret setting. Environment variables are a delivery mechanism, not a secret vault; do not print them, place secrets in command-line arguments, or bake credentials into images.
- Never put PFX/PEM private keys, passwords, tokens, or API keys in `config.json`, source control, reports, or logs. The sample does not retrieve certificates from a vault or renew them.
- Monitor expiration and rotate before expiry: register the new public certificate while the old one is still valid, deploy the corresponding private key/password, restart the process and verify both Web and News access, then remove the old credential after all callers have switched.
- Managed identity is a separate production authentication option, but this sample's `entra` mode intentionally supports certificate authentication only. It does not silently switch to a host identity. Azure OpenAI remains API-key authenticated.

See Microsoft's [CertificateCredential reference](https://learn.microsoft.com/en-us/python/api/azure-identity/azure.identity.certificatecredential), [development certificate creation guide](https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-self-signed-certificate), and [application credential management guidance](https://learn.microsoft.com/en-us/entra/identity-platform/security-best-practices-for-app-registration#credentials-and-secrets).

## Options

Run `webiq-market-briefing --help` for the complete list.

```text
--lookback-days N   Reporting window; default: 7
--max-results N     Results requested per Web IQ search; default: 5
--query TEXT        Use a specific query; repeat for multiple queries
--config PATH       Configuration file; default: config.json
--region REGION     Web IQ market region; default: US
--webiq-auth MODE   api-key (default) or entra (certificate); Web IQ only
--output PATH       Markdown output path; default: market-briefing.md
```

Provide `--query` to replace the generated query set:

```powershell
webiq-market-briefing "Energy market" `
  --query "North American natural gas price developments" `
  --query "US electricity market reliability developments" `
  --output reports\energy-briefing.md
```

## How it works

1. Builds a small set of date-bounded queries, unless explicit queries are supplied.
2. Searches Web IQ web and news endpoints with `contentFormat: "passage"` and a 3,000-character limit per result.
3. Deduplicates results by URL and limits the evidence sent to the model.
4. Instructs Azure OpenAI to synthesize only from the supplied evidence.
5. Rejects missing or out-of-range numeric citations and incomplete model responses.
6. Turns `[1]`-style citations into internal links and writes the briefing and a compact numbered Sources list to one Markdown file, without passage excerpts.

Citation links use Markdown such as ` [[1]](#source-1)`, displaying bracketed numbers with a preceding space and linking to the source entry. Each entry includes a linked title, available publisher/last-updated metadata, and the full clickable URL, without a web/news label.

After changing the sample code, reinstall it before generating another report. Alternatively, use `python -m pip install -e ".[dev]"` as described below so code changes take effect without reinstalling. Existing reports are not updated automatically.

The prompt requires a citation immediately after each factual claim, separate citation tokens for multiple sources, and explicit treatment of uncertainty. The application checks that numeric citations exist and refer to supplied sources; it does **not** verify that each claim is cited or that a passage actually supports the claim. Review the passages and original sources before relying on a report. Search date constraints do not guarantee that every returned item was published within the reporting window.

Passages are extracts, not full documents. The sample deduplicates by URL, keeps up to 18 sources, and sends the retained passages to the model without including them in the Sources list. It does not fetch full pages or infer missing content. Retrieved content is treated as untrusted evidence in the prompt; source titles, metadata, and URL labels are escaped for display. The application rejects inline Markdown links, HTML, and triple-backtick code fences in model output; this check is not a general-purpose Markdown sanitizer.

## Retries and support diagnostics

Web IQ calls have a 30-second request timeout and at most two retries, managed by the sample without stacking SDK retries. Connection failures, timeouts, and HTTP 408, 429, 430, 500, 502, 503, and 504 use exponential backoff with jitter (0.5–1 seconds, then 1–2 seconds). A valid response-body `retryAfter` duration such as `3s` increases that delay. Guidance longer than 60 seconds fails immediately instead of retrying too early. Invalid input, authentication, and permission errors are not retried. Exhausting retries stops generation rather than silently omitting a failed search.

Azure OpenAI uses its SDK's two retries with exponential backoff for connection failures, timeouts, HTTP 408, 409, 429, and 5xx errors, with a 60-second request timeout. See the [OpenAI Python SDK retry documentation](https://github.com/openai/openai-python#retries). These are per-request timeouts, not an overall briefing deadline; multiple queries and retries can take several minutes.

Logs are enabled automatically; no configuration switch or logging argument is required. Timestamped diagnostics go to stderr, while the three progress messages go to stdout. Web IQ logs the query before each web/news search and every returned source URL, including duplicates and results later excluded from model evidence. These `query` and `source_url` values use JSON quoting to preserve the full text while escaping line breaks and other control characters. Each attempt also logs its operation, status, trace ID, request ID when supplied, and the machine-readable error-response code. Retry logs show the retry number and delay. Azure OpenAI logs the final response request ID, or the final failure's status, request ID, and error code. Missing IDs appear as `-`. Save diagnostics separately from the report:

```powershell
webiq-market-briefing "Energy market" --output reports\briefing.md 2> reports\diagnostics.log
```

To display and save both progress and diagnostics:

```powershell
webiq-market-briefing "Energy market" --output reports\briefing.md 2>&1 |
  Tee-Object -FilePath market-briefing.log
```

If a successful run shows only progress, ensure the command is installed from this updated source using the editable-install command below. Earlier versions of the sample did not emit service diagnostics.

Create the `reports` directory first when redirecting to it. When contacting support, include the service, UTC failure time, HTTP status, error code, correlation IDs, and retry history. Codes and identifiers are bounded and restricted to single-line characters. Logs now contain the search queries and full returned source URLs, which may include sensitive search terms or URL parameters; review and redact them before sharing. Error messages, arbitrary response bodies, model prompts, passages, API keys, tokens, and authentication headers are deliberately excluded; do not enable HTTP wire logging or share credentials to obtain more detail. The report itself contains the searched topic and source references, so review it before sharing.

A citation-validation failure does not write a new report; review or rerun generation. An existing output file is left unchanged on retrieval or generation failure. For a 401/403, check credentials and service provisioning. For 429/430, wait for service guidance before rerunning. For exhausted transient failures, retain the diagnostic IDs for support.

## Contribute

Install the sample in editable mode with its test dependency:

```powershell
python -m pip install -e ".[dev]"
```

Run the tests:

```powershell
pytest
```
