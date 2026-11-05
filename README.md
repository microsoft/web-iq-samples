# Web IQ Samples

Runnable examples for building applications with Microsoft Web IQ.

## Project status

This repository includes the runnable Market briefing, APIM managed identity
gateway, and Python, .NET, and Rust named scopes samples listed below. These are
educational samples, not production-ready reference architectures. Review each sample's security,
cost, and operational requirements before use or deployment. No third-party
source code is vendored; the samples install their dependencies separately.

## Samples

Samples are organized by implementation language or infrastructure technology:

```text
samples/
  <language-or-technology>/
    <sample-name>/
```

Each sample is self-contained and includes its own prerequisites, configuration,
run instructions, and validation steps.

| Sample | Language | Description |
|---|---|---|
| [Market briefing](samples/python/market-briefing/) | Python | Uses Web IQ web and news passages to generate a cited Markdown briefing. Azure OpenAI is the example model provider; other chat models require small integration changes. Model usage is a separate cost. Supports API-key or certificate-based Microsoft Entra authentication for Web IQ. |
| [APIM managed identity gateway](samples/terraform/apim-managed-identity/README.md) | Terraform | Protect Web IQ with Entra authentication, query redaction, and optional operational telemetry. |
| [Named scopes (Python)](samples/python/named-scopes/) | Python | Manage named scopes through the customer API, then use an API- or UI-authored scope with the web endpoint. Covers workload-identity setup, ETag-protected writes, and separate runtime authentication. Requires account access to named scopes. |
| [Named scopes (.NET)](samples/dotnet/named-scopes/) | .NET / C# | Manage scopes and consume scoped web search with `HttpClient` and certificate-based Entra authentication or a runtime API key. Includes offline contract tests and the shared portal setup guide. Requires account access to named scopes. |
| [Named scopes (Rust)](samples/rust/named-scopes/) | Rust | Manage scopes and consume scoped web search with `reqwest` and certificate-based Entra authentication or a runtime API key. Includes offline transport tests and the shared portal setup guide. Requires account access to named scopes. |

## Telemetry

The APIM sample's Application Insights request telemetry is disabled by default.
You can opt in with `enable_telemetry = true` and opt out again by setting it to
`false` and applying the change. See the sample's
[logging guidance](samples/terraform/apim-managed-identity/README.md#logging)
for collected metadata, privacy limits, and deletion guidance. Telemetry is
stored in your Azure subscription, not sent to this repository's maintainers.
Web IQ service-side data handling is separate; see the
[Web IQ privacy guidance](https://learn.microsoft.com/en-us/web-iq/resources/faq#privacy-and-data-handling).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for repository structure, sample
requirements, validation expectations, and public-content restrictions.

This project has adopted the [Microsoft Open Source Code of Conduct](CODE_OF_CONDUCT.md).

## Support

See [SUPPORT.md](SUPPORT.md) for questions, bug reports, and feature requests.

## Security

Do not report security vulnerabilities through public GitHub issues. See
[SECURITY.md](SECURITY.md) for reporting guidance.

## License

This project is licensed under the [MIT License](LICENSE.txt).

## Trademarks

This project may contain trademarks or logos for projects, products, or services.
Authorized use of Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks).
Use of Microsoft trademarks or logos in modified versions of this project must
not cause confusion or imply Microsoft sponsorship. Any use of third-party
trademarks or logos are subject to those third-party's policies.
