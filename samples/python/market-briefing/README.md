# Web IQ Market Briefing

Generate a cited Markdown report from current web and news passages. Web IQ retrieves the evidence and Azure OpenAI turns it into a concise briefing. Click a numbered citation to jump to its source and the retrieved passage, so readers can inspect the evidence behind the summary.

## Prerequisites

- Python 3.11 or later
- A Web IQ API key, or a Microsoft Entra identity provisioned for Web IQ
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

The sample uses Azure Identity's `DefaultAzureCredential` and requests the scope `https://api.microsoft.ai/.default`. It does not read `WEBIQ_API_KEY` in Entra mode. For local development with a provisioned Azure CLI identity:

```powershell
az login --tenant "<your-tenant-id>"
$env:AZURE_OPENAI_API_KEY = "<your Azure OpenAI API key>"
webiq-market-briefing "Energy market" --webiq-auth entra
```

The signed-in identity must resolve to your provisioned Web IQ App ID. This sample does not select among multiple App IDs; use an identity with one mapping. A 401 or 403 requires checking provisioning and entitlements rather than repeatedly signing in.

`DefaultAzureCredential` also supports environment-based application credentials and managed identity. Its credential order matters: an environment credential may be selected before the CLI identity. See the [Azure Identity documentation](https://learn.microsoft.com/en-us/python/api/overview/azure/identity-readme) for configuration and credential-chain behavior. Never put tokens or client secrets in `config.json` or commit them.

## Options

Run `webiq-market-briefing --help` for the complete list.

```text
--lookback-days N   Reporting window; default: 7
--max-results N     Results requested per Web IQ search; default: 5
--query TEXT        Use a specific query; repeat for multiple queries
--config PATH       Configuration file; default: config.json
--region REGION     Web IQ market region; default: US
--webiq-auth MODE   api-key (default) or entra; Web IQ only
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
6. Turns `[1]`-style citations into internal links and writes the briefing, linked sources, and blockquoted retrieved passages to one Markdown file.

The prompt requires a citation immediately after each factual claim, separate citation tokens for multiple sources, and explicit treatment of uncertainty. The application checks that numeric citations exist and refer to supplied sources; it does **not** verify that each claim is cited or that a passage actually supports the claim. Review the passages and original sources before relying on a report. Search date constraints do not guarantee that every returned item was published within the reporting window.

Passages are extracts, not full documents. The sample deduplicates by URL, keeps up to 18 sources, and quotes only the retained passage for each source. It does not fetch full pages or infer missing content. Retrieved content is treated as untrusted evidence in the prompt and escaped when displayed in the source section. The application rejects inline Markdown links, HTML, and triple-backtick code fences in model output; this check is not a general-purpose Markdown sanitizer.

## Retries and support diagnostics

Web IQ calls have a 30-second request timeout and at most two retries, managed by the sample without stacking SDK retries. Connection failures, timeouts, and HTTP 408, 429, 430, 500, 502, 503, and 504 use exponential backoff with jitter (0.5–1 seconds, then 1–2 seconds). A valid response-body `retryAfter` duration such as `3s` increases that delay. Guidance longer than 60 seconds fails immediately instead of retrying too early. Invalid input, authentication, and permission errors are not retried. Exhausting retries stops generation rather than silently omitting a failed search.

Azure OpenAI uses its SDK's two retries with exponential backoff for connection failures, timeouts, HTTP 408, 409, 429, and 5xx errors, with a 60-second request timeout. See the [OpenAI Python SDK retry documentation](https://github.com/openai/openai-python#retries). These are per-request timeouts, not an overall briefing deadline; multiple queries and retries can take several minutes.

Logs go to stderr. Web IQ logs each attempt's operation, status, trace ID, request ID when supplied, and the machine-readable error-response code. Retry logs show the retry number and delay. Azure OpenAI logs the final response request ID, or the final failure's status, request ID, and error code. Missing IDs appear as `-`. Save diagnostics separately from the report:

```powershell
webiq-market-briefing "Energy market" --output reports\briefing.md 2> reports\diagnostics.log
```

Create the `reports` directory first when redirecting to it. When contacting support, include the service, UTC failure time, HTTP status, error code, correlation IDs, and retry history. Codes and identifiers are bounded and restricted to single-line characters. Error messages, arbitrary response bodies, prompts, passages, API keys, tokens, and authentication headers are deliberately excluded; do not enable HTTP wire logging or share credentials to obtain more detail. The report itself contains the searched topic and retrieved evidence, so review it before sharing.

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
