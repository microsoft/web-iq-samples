# Web IQ API Management Gateway

Deploy an Azure API Management gateway that:

- validates a Microsoft Entra user access token, delegated scope, and approved client application;
- requires a `deptId` request header for attribution;
- redacts common SSN and payment-card patterns in the Web IQ `query`;
- calls Web IQ with the APIM system-assigned managed identity; and
- optionally sends operational telemetry to Application Insights without logging request or response bodies.

The sample forwards `POST /search/web` to `https://api.microsoft.ai/v3/search/web`.
It is an educational starting point, not a production-ready reference architecture.

## Architecture

```text
Approved desktop/public client
  |
  | Delegated access token + deptId + Web IQ JSON body
  v
Azure API Management
  |-- validate tenant, audience, client application, and delegated scope
  |-- validate deptId and JSON body
  |-- redact sensitive-number patterns from query
  |-- optionally log operational metadata to Application Insights
  |-- replace user token with managed identity token
  v
Web IQ
```

## Prerequisites

- Terraform 1.9 or later
- Azure CLI authenticated to the target subscription
- Permission to create a resource group, API Management, Log Analytics, Application Insights, and role assignments
- The `Microsoft.ApiManagement`, `Microsoft.OperationalInsights`, and `Microsoft.Insights` resource providers registered in the subscription
- A Microsoft Entra application registration representing the gateway API
- A delegated scope for callers, such as `access_as_user`
- An approved desktop/public-client application with permission to request that scope
- Web IQ access and permission to bind the APIM managed identity in the Web IQ Portal

## Frontend authentication

Use a single-tenant Entra API registration for the gateway unless an approved
registration already exists. Expose a delegated scope such as `access_as_user`,
grant the desktop client that permission, and obtain the required consent or
preauthorization. A desktop client should use MSAL interactive authentication
with PKCE; do not embed a client secret.

Configure `api_audience` to match the access token's `aud` claim: v2 access tokens
use the gateway API's application (client) ID, while v1 tokens commonly use its
Application ID URI. Configure `api_allowed_client_ids` with the separate
application (client) IDs of the approved callers. APIM validates the tenant,
audience, client application, and delegated `scp` claim. An ID token or an
application-only token is not sufficient.

The gateway's managed identity authenticates only the APIM-to-Web IQ hop. This is
not an on-behalf-of flow; Web IQ sees APIM's identity, not the desktop user.
See the public [Entra API setup guidance](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-expose-web-apis)
and [APIM token policy reference](https://learn.microsoft.com/en-us/azure/api-management/validate-azure-ad-token-policy).

## Configure

Copy the example variables:

```powershell
Copy-Item terraform.tfvars.example terraform.tfvars
```

Replace every angle-bracket placeholder in `terraform.tfvars` with your own:

- Azure subscription and publisher values
- Microsoft Entra tenant ID
- frontend API audience
- delegated scope required in the user's `scp` claim
- allowed frontend application (client) IDs

Do not check in your configured values. `terraform.tfvars`, state, plans, and
provider downloads are ignored by Git. The provider lock file remains committed
for reproducibility.

This sample creates a **new resource group and APIM instance**, rather than
modifying a shared gateway. The default SKU is `Developer_1`, which is billed
while provisioned and has no production SLA. Monitoring and Web IQ usage can
incur additional charges. Set a budget and review
[APIM pricing](https://azure.microsoft.com/en-us/pricing/details/api-management/)
before applying. Other SKUs require checking feature compatibility; changing the
SKU alone is not a validated Consumption deployment.

Request telemetry is off by default. Review [Logging](#logging) before opting in
with `enable_telemetry = true`.

Web IQ access requires manual binding in the Web IQ Portal after deployment.
Azure RBAC does not grant Web IQ access. Terraform configures a separate,
resource-scoped role assignment for Application Insights logging only.

## Deploy

```powershell
terraform init -input=false -lockfile=readonly
terraform plan -out main.tfplan
terraform apply main.tfplan
```

API Management provisioning can take significantly longer than the other resources.
Saved plans and Terraform state may contain sensitive details; store them securely.

## Bind the managed identity in the Web IQ Portal

After deployment, look up the APIM managed identity's Application (Client) ID:

```powershell
$principalId = terraform output -raw apim_managed_identity_principal_id
az ad sp show --id $principalId --query appId --output tsv
```

Bind the returned **Application (Client) ID** to your Web IQ AppID in the
Web IQ Portal. Do not use the object/principal ID from the Terraform output
as the binding value. Directory read permissions may be required for the lookup.

Terraform does not create this binding. Complete the Portal binding and confirm
it is visible before calling the gateway. Use a dedicated Web IQ AppID for this
sample so APIM's managed identity is bound to only one AppID; selecting among
multiple AppIDs is outside this sample.
See [Web IQ authentication guidance](https://webiq.microsoft.ai/documentation/faq/).

## Call the API

Acquire a delegated token for the gateway API with your approved client, then
call the `gateway_url` Terraform output. For a development-only Azure CLI test,
the API owner must explicitly grant/consent to the Azure CLI client's delegated
permission and include that client's ID in `api_allowed_client_ids`. Do not add
test clients to a production allowlist simply to make this command work.
Sign in to the configured tenant first:

```powershell
az login --tenant "<microsoft-entra-tenant-id>"

$token = az account get-access-token `
  --scope "api://<frontend-api-application-client-id>/access_as_user" `
  --query accessToken `
  --output tsv

$gatewayUrl = terraform output -raw gateway_url

$body = @{
  query         = "Recent developments for customer 123-45-6789"
  maxResults    = 5
  contentFormat = "markdown"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri $gatewayUrl `
  -Headers @{
    Authorization = "Bearer $token"
    deptId        = "finance"
  } `
  -ContentType "application/json" `
  -Body $body

Remove-Variable token
```

The SSN-like value is synthetic test data and is replaced with `[REDACTED-SSN]`
before APIM forwards the request. Use only synthetic or approved public queries.
Do not print tokens, enable request debugging, or save retrieved response content
to shared logs.

## Query inspection and redaction

The policy section marked `Sensitive query inspection and redaction` is the
extension point. The sample currently replaces:

- SSN-like values formatted as `123-45-6789`, `123 45 6789`, or `123456789`
- payment-card-like sequences containing 13-19 digits, optionally separated by spaces or hyphens

This is a lightweight example, not a complete data-loss-prevention system.
Regex matching can produce false positives and cannot identify every sensitive
value. Only the `query` field is inspected; other JSON fields are forwarded
unchanged. Production deployments should use an approved DLP service and
organization-specific policies if sensitive data might be submitted.

The custom trace does not contain raw or sanitized query text. It contains only:

- the validated, caller-supplied department label;
- whether redaction occurred; and
- the APIM correlation ID.

When enabled, API diagnostics set all request and response body logging limits
to zero and log only the `content-type` header.

## Security notes

- `deptId` is caller-supplied attribution, not an authorization boundary. Derive or validate allowed departments from trusted claims or another authorization service for production.
- Tokens must come from the configured tenant and an allowed client, and contain the configured audience and delegated scope.
- APIM replaces frontend authorization with its managed identity token for `https://api.microsoft.ai`. It does not fall back to caller credentials if token acquisition fails.
- Caller-provided `x-apikey`, `Ocp-Apim-Subscription-Key`, and `deptId` headers are removed before forwarding.
- The gateway and Web IQ endpoints are public HTTPS endpoints. Legacy SSL/TLS versions are explicitly disabled on this sample's gateway.
- Only trusted administrators should edit APIM policies or backend URLs: they can act as the managed identity. Use only the required Web IQ binding and logging role.
- Review inherited/global policies before adapting this to an existing gateway; they can independently log, cache, forward, or transform data.
- Add workload-appropriate rate limits, quotas, alerts, and user/department authorization before production. A client allowlist does not replace user access controls or consent.
- Terraform state can contain sensitive resource details even without application secrets. For shared deployments, use an access-controlled, encrypted remote state backend with locking. Never publish state or saved plans.
- This sample does not cache Web IQ responses. Respect the [Web IQ Terms of Use](https://webiq.microsoft.ai/documentation/faq/) when handling retrieved content.

## Logging

Terraform creates a Log Analytics workspace, workspace-based Application
Insights, an APIM logger authenticated with the APIM managed identity, and
opt-in API-level diagnostics.

With `enable_telemetry = true`, Application Insights captures frontend requests,
backend dependencies, failures, and `webiq-gateway` traces. Metadata includes
request/dependency URLs, status codes, timings, content types, correlation IDs,
validated department labels, and whether redaction occurred. Treat department
labels as non-sensitive codes, never names, secrets, or personal information.
Do not put queries or credentials in URLs: request URLs and diagnostic errors
can contain caller-controlled data even when body/header logging is disabled.

Telemetry stays in your subscription under Azure Monitor access controls.
Retention defaults to 30 days through `log_retention_days`. To stop collection,
set `enable_telemetry = false` and apply; this removes the sample's API diagnostic,
including error and custom-trace collection. It does not delete existing data or
disable independently configured Azure diagnostics. Monitoring resources still
exist when request telemetry is off. Use your Azure Monitor retention/purge
process to remove collected data when required.

Disabling gateway telemetry does not disable Web IQ's own service-side logging.
Review the [Web IQ privacy guidance](https://learn.microsoft.com/en-us/web-iq/resources/faq#privacy-and-data-handling).

## Validation

Run these checks from this sample's directory; none provisions Azure resources:

```powershell
terraform fmt -check -recursive
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
terraform test
```

The native Terraform tests use mocked providers to check telemetry opt-in,
body/header logging safeguards, and invalid tenant/client configuration. These
checks do not compile policy expressions or prove live APIM/Web IQ behavior.
Before using a deployed instance, verify with synthetic inputs that:

- missing/invalid tokens, a wrong audience/client/tenant, missing delegated scope, and application-only tokens are rejected without reaching Web IQ;
- missing/invalid `deptId`, malformed JSON, empty queries, and oversized requests are rejected;
- the managed-identity binding permits a valid request and missing backend access fails without falling back to caller credentials; and
- redaction changes the forwarded query and no query, token, or response content appears in enabled diagnostics.

## Clean up

```powershell
terraform destroy
```

This deletes the sample's resource group and all its resources. Remove the
managed-identity binding from Web IQ as well. Do not use this sample to manage
an existing/shared resource group.
