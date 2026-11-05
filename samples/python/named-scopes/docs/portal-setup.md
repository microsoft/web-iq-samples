# Portal setup: workload identities and scopes

[Back to the sample](../README.md)

Use the [Web IQ portal](https://webiq.microsoft.ai), also referred to as the
grounding-mcp portal. Sign in with an identity authorized for the intended
customer and billing account. Controls depend on account access and feature
availability; if a control is absent, ask your administrator or Web IQ support
to confirm access instead of trying an undocumented route.

The portal does not create an Entra application, certificate, or private key in
the management-grant flow below. Start with an existing application, and use your
organization's approved credential provisioning process. For certificate-based
authentication, register the public certificate on the Entra application and
keep the private-key file outside source control. See the public
[CertificateCredential reference](https://learn.microsoft.com/en-us/python/api/azure-identity/azure.identity.certificatecredential).

## Account settings: add the management workload

An active human **BillingAccount Admin**, or an inherited **Customer Admin**, must
perform this setup. Use the existing application's tenant ID and application/client
ID, not its object ID.

1. Open **Account settings** and select the intended billing account.
2. Find **Application (Client) Ids**, then choose **Add client ID**.
3. Enter **Tenant ID** and **Application (client) ID**. Optionally enter a
   **Display name**, such as `Scopes sample management`.
4. Review the intended identity/account and select **Grant CustomerApiAccess to
   this application** only if management access is appropriate.
5. Choose **Grant access** to authorize that existing workload.

**CustomerApiAccess is broader than scope management.** Use a dedicated,
least-privileged workload and review this grant as a management permission, not
as a search credential or a per-scope permission. A management workload cannot
grant workload access to itself or to other applications. If self-service is
unavailable for your account, have an authorized administrator arrange onboarding.

After setup, configure the management certificate variables and run
`webiq-scopes discover`. Select the billing account deliberately. An empty array
can mean that the workload is unknown or not assigned; acquiring an Entra token
does not validate the grant.

## Profile Management: bind the runtime application

This step is separate from the management grant. It is necessary for runtime
Entra authentication, not for API-key search.

1. Open **Profile Management** and select the Web IQ profile in the billing account
   that owns the desired scope.
2. Open **Application (Client) IDs** and choose **Bind Application (Client) ID**.
3. Enter the runtime application's Entra application/client GUID and complete
   the binding using your authorized account.
4. Confirm that the profile has Web access. Record the profile's **Web IQ AppID**
   if the runtime application is bound to multiple profiles.

The Entra application/client ID and the Web IQ AppID are different identifiers.
The sample's `--app-id` is the latter, used only to disambiguate runtime Entra
requests. API-key search selects its profile through the key and must not send
`APPID`.

The runtime application can differ from the management workload. UI-authored
scopes are consumable without granting the runtime application CustomerApiAccess.

## Scopes: create and publish in the UI

Instead of calling `webiq-scopes create`, an authorized author can create the
same kind of named scope in the portal:

1. Open **Scopes** and choose the intended **Billing account**.
2. Choose **New scope**. In **Create new scope**, set **Scope name** to a dedicated
   name such as `ProductDocs`.
3. Open the scope's details. Under **Included**, use **Add URL** to add
   `learn.microsoft.com/en-us/entra`.
4. Under **Excluded**, use **Add URL** to add
   `learn.microsoft.com/en-us/entra/identity/monitoring-health`.
5. Review the entire definition, choose **Publish**, and confirm **Publish
   changes?** where shown.

Exclusions win. An empty Included list means all non-excluded sources; it is not
a deny-all scope. Scope names are case-insensitive and accept 1-128 ASCII letters,
digits, periods, underscores, and hyphens.

Publishing acknowledges authoring, not serving readiness. Changes propagate
asynchronously; no fixed wait or status endpoint is assumed. The runtime sample
keeps `failOnMissingScope: true` and never substitutes an unscoped query while a
scope is missing or unavailable.

Once available to the intended profile, consume a UI-authored scope with exactly
the same `webiq-scopes search ProductDocs "Microsoft Entra app authentication"`
command as an API-authored scope. No management credential is needed for API-key
search.
