# Web IQ named scopes

Two independent scenarios for developers using named source filters with Web IQ:

1. **Manage scopes through the customer API:** discover authorized billing accounts,
   list and read scopes, create a scope, replace its site lists, and delete it.
2. **Consume a named scope through the web endpoint:** use the same search command
   whether someone created the scope through the API or through the portal's
   **Scopes** UI. Search does not require the management API.

This is an educational REST example, not a production client. It intentionally
uses explicit account/profile selection, conditional writes, and no automatic
retries or unscoped fallback.

The same scenarios are also available in [.NET](../../dotnet/named-scopes/README.md)
and [Rust](../../rust/named-scopes/README.md). All three use the
[shared portal setup guide](docs/portal-setup.md).

## Prerequisites

- Python 3.11 or later; PowerShell 7.3 or later for the Windows commands below.
- A provisioned Web IQ account with **named-scope management and scoped web search
  enabled**. Availability depends on your account; confirm access before running.
- For the management scenario, an existing Microsoft Entra application with an
  organization-approved certificate/private key. A human administrator must first
  add that workload identity to the intended billing account and grant
  **CustomerApiAccess** in the [Web IQ portal](https://webiq.microsoft.ai).
  See the [portal setup guide](docs/portal-setup.md).
- For search, a Web IQ API key for the intended profile, or an Entra application
  separately bound to that profile with Web access. The profile must belong to
  the billing account that owns the scope.

**Management authorization and runtime authorization are separate.** A runtime
profile binding does not grant management access. A management grant does not
bind an application to a search profile or provision search access. A search-only
application using a UI-authored scope needs runtime access, not CustomerApiAccess.

## Install

Run from this sample directory:

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install .
```

For macOS/Linux, use `python3 -m venv .venv`, `source .venv/bin/activate`, and the
same installation command. Translate environment assignments to `export NAME=value`;
the CLI commands are otherwise the same. Preserve the double quotes inside ETag
values when passing them to your shell.

## Scenario 1: create and manage scopes with the API

### Register and configure the management workload

Complete [Account settings: add the management workload](docs/portal-setup.md#account-settings-add-the-management-workload)
first. The administrator grants access to an existing identity; the sample does
not create an Entra application or grant itself permissions.

Configure the certificate in your current shell. Use the **application/client
ID**, not an object ID. Keep the private-key file outside the repository:

```powershell
$env:AZURE_TENANT_ID = "<directory-tenant-id>"
$env:AZURE_CLIENT_ID = "<application-client-id>"
$env:AZURE_CLIENT_CERTIFICATE_PATH = "<absolute-path-to-private-key-pfx-or-pem>"
$password = Read-Host "Existing certificate password, if encrypted" -AsSecureString
$env:AZURE_CLIENT_CERTIFICATE_PASSWORD = (
  [System.Net.NetworkCredential]::new("", $password).Password
)
```

For an unencrypted certificate, omit the password variable. These settings use
Azure Identity's `CertificateCredential` explicitly, without Azure CLI,
client-secret, managed-identity, or interactive credential-chain fallbacks.
The token-request scope is `https://api.microsoft.ai/.default`. Token acquisition
alone does not prove that the workload has service authorization.

### Discover and deliberately select the account

```powershell
webiq-scopes discover
$env:WEBIQ_BILLING_ACCOUNT_ID = "<billing-account-id-from-discovery>"
webiq-scopes list
```

Discovery calls `GET https://api.microsoft.ai/v1/customer/authorized-resources`.
It returns customers and their billing accounts, including IDs for your local
selection. An unknown or unassigned workload can receive `200` with an empty
array; this is not evidence that setup succeeded. Have an administrator check
the active tenant/client registration and billing-account CustomerApiAccess.
Never select the first returned account automatically.

`permissions.canWrite` in discovery is a legacy billing-configuration permission,
**not** scope-write authority. Do not treat `false` as a scopes denial or `true`
as permission to grant workload access. The management API cannot grant that
access.

The `list` command follows all pages (default page size 50, maximum 100) and
passes opaque continuation tokens back unchanged. List entries contain metadata
and counts, not site selectors; use `get` for the actual definition.

### Create, read, and replace a definition

`product-docs.json` contains public site selectors, with no credentials or account
identifiers:

```json
{
  "includeSites": ["learn.microsoft.com/en-us/entra"],
  "excludeSites": ["learn.microsoft.com/en-us/entra/identity/monitoring-health"]
}
```

```powershell
webiq-scopes create ProductDocs --definition product-docs.json
webiq-scopes get ProductDocs
```

Create sends `POST /v1/customer/billing-accounts/{billingAccountId}/scopes` with
`name`, `includeSites`, and `excludeSites`. It expects `201` and a strong ETag.
Create is **not an upsert**: a case-insensitive duplicate name or a full collection
returns `409`. Choose a dedicated demo name rather than replacing an existing
scope owned by someone else.

For an update, read the current definition, reconcile your desired changes with
it, and pass that exact quoted ETag. Edit `product-docs.json` to contain **both
complete desired lists** before replacing:

```powershell
$snapshot = webiq-scopes get ProductDocs | ConvertFrom-Json
# Review $snapshot and edit product-docs.json before continuing.
webiq-scopes replace ProductDocs --definition product-docs.json --if-match $snapshot.etag
```

Replace sends `PUT .../scopes/{name}` with both lists and `If-Match`. It replaces
the entire definition, not just changed entries; it does not rename the scope.
Missing or `null` arrays are not equivalent to explicit `[]` and are rejected by
this sample. An empty `includeSites` means **all non-excluded sources**, not no
results. The CLI requires `--allow-all-sites` to acknowledge that broadening.
Exclusions win over inclusions.

ETags are opaque strong quoted values. Do not remove quotes, use `*`, substitute
weak tags, or blindly fetch a new ETag and overwrite another writer's work.
On `412`, read and reconcile before attempting a new write. The sample never
retries a write automatically.

### Propagation and optional cleanup

A successful write or a new ETag acknowledges **authoring storage**, not serving
readiness. Scope changes propagate asynchronously; there is no fixed wait time
or serving-status API used by this sample. Verify the intended source behavior
with scoped queries before depending on an update. A search result count alone
is not proof that a particular revision has propagated.

Delete only the dedicated sample scope when no caller needs it, after reviewing
its current definition:

```powershell
$snapshot = webiq-scopes get ProductDocs | ConvertFrom-Json
webiq-scopes delete ProductDocs --if-match $snapshot.etag
```

Delete requires the current ETag and expects `204`; it does not parse a response
body. Deletion also propagates asynchronously. On a timeout or server failure
during any write, the operation may already have taken effect: read/reconcile
before retrying instead of assuming it failed.

## Scenario 2: search with an API- or UI-authored named scope

You can skip scenario 1 entirely if an administrator or author has
[created and published a scope in the UI](docs/portal-setup.md#scopes-create-and-publish-in-the-ui).
There is no separate runtime selector for UI-created scopes.

Use the API key for the **profile associated with the scope's billing account**:

```powershell
$env:WEBIQ_API_KEY = "<api-key-for-the-intended-webiq-profile>"
webiq-scopes search ProductDocs "Microsoft Entra app authentication"
```

The request is:

```http
POST https://api.microsoft.ai/v3/search/web
Content-Type: application/json
x-apikey: <runtime-api-key>
```

```json
{
  "query": "Microsoft Entra app authentication",
  "scopeName": "ProductDocs",
  "failOnMissingScope": true,
  "maxResults": 5,
  "language": "en",
  "region": "US",
  "contentFormat": "passage",
  "maxLength": 3000
}
```

The selector is **one string named `scopeName`**, not a `scopes` or `scopeNames`
array. Names accept 1-128 ASCII letters, digits, periods, underscores, and hyphens;
lookup is case-insensitive. `failOnMissingScope` remains `true`: a missing or
unavailable scope fails rather than silently searching the unscoped web. This
sample does not expose a flag to disable that behavior.

The command prints only the number of web results, not queries, URLs, passages,
tokens, or raw search responses. To inspect retrieved data in your own application,
consume the response's `webResults` array at the `search` function, keeping it
out of logs and reviewing it before sharing.

### Runtime Entra authentication instead of an API key

Follow [Profile Management: bind the runtime application](docs/portal-setup.md#profile-management-bind-the-runtime-application)
and configure the certificate variables above for that runtime application.
It can be different from the management application. Then run:

```powershell
webiq-scopes search ProductDocs "Microsoft Entra app authentication" --auth entra
```

The runtime token uses the same token-request scope, but authorization still
requires the correct runtime profile binding and Web access. If that application
is bound to multiple profiles, explicitly select the intended profile:

```powershell
webiq-scopes search ProductDocs "Microsoft Entra app authentication" `
  --auth entra --app-id "<webiq-appid-for-the-intended-profile>"
```

`--app-id` sends `?APPID=...` and means the **Web IQ AppID**, not the Entra
application/client ID. It is only valid for Entra search. API-key search must
not include `APPID`, and management requests do not use it.

## Errors and operational limits

| Result | Action |
| --- | --- |
| Discovery returns `[]` | Verify active workload registration and billing-account CustomerApiAccess with a human administrator. |
| `400` | Check definition/name/ETag input. For search, check scope availability and the selected profile; do not remove the scope selector to make the request succeed. |
| `401` / `403` | Check certificate/API key and token audience, then the separate management grant or runtime profile binding and entitlement. |
| `404` | Verify the account, profile, and scope selection. |
| `409` | Read the collection; inspect duplicate-name or capacity conflicts before deciding what to do. |
| `412` / `428` | Read/reconcile with the latest definition and use its exact strong ETag; do not blindly overwrite. |
| `429` | Respect service retry guidance; retries are deliberate, not automatic. |
| Timeout, redirect, or server error on a write | Treat the outcome as uncertain; read/reconcile before retrying. Redirects are not followed. |

Requests have a 30-second HTTP timeout. Error diagnostics show a status and fixed
guidance, not raw server bodies or exception details. Discovery, list, and get
deliberately print management data to stdout; discovery includes account IDs.
Do not capture or share those outputs without reviewing/redacting them. Avoid
shell tracing/transcripts with real credentials. Environment variables are a
delivery mechanism, not a secret store; never commit them or the private-key file.
Clear process-local secret variables after the final run.

The sample collects no custom telemetry and writes no response files.
Dependency and Web IQ service-side data handling are separate; see the
[Web IQ privacy guidance](https://learn.microsoft.com/en-us/web-iq/resources/faq#privacy-and-data-handling).
Live search can incur Web IQ usage charges. Management commands mutate real
resources when you explicitly run them; offline tests do not.

## Validate locally without service access

```powershell
python -m pip install -e ".[dev]"
python -m pytest -q
webiq-scopes --help
webiq-scopes search --help
```

Tests use `httpx.MockTransport` and mocked certificate acquisition. They do not
request tokens, contact Web IQ, create grants, or mutate live scopes. They cover
exact route/body/header shapes, both runtime authentication modes, pagination,
ETags, full replacements, explicit empty lists, propagation messaging, missing
scope failure, sanitized errors, and no automatic retries.

Open **Documentation** in the [Web IQ portal](https://webiq.microsoft.ai) for
authentication and web endpoint guidance available to your account.
