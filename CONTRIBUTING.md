# Contributing to Web IQ Samples

Thank you for contributing a Web IQ sample.

## Repository structure

Place each sample in a self-contained directory:

```text
samples/
  <language-or-technology>/
    <sample-name>/
      README.md
      <source and configuration files>
      <tests or validation scripts>
```

Use lowercase, hyphen-separated directory names. Do not place shared
dependencies at the repository root unless multiple samples require them.

## Sample requirements

Every sample must:

- Explain the scenario and intended audience.
- List all prerequisites.
- Provide complete setup, configuration, and run instructions.
- Read credentials from environment variables or an approved secret store.
- Include placeholder values instead of resource names, tenant IDs,
  subscription IDs, or other environment-specific identifiers.
- Include tests or documented validation steps appropriate to the technology.
- Handle service and authentication failures explicitly.
- Link only to public documentation from checked-in content.
- Add an entry to the sample table in the root `README.md`.

## Public-content boundary

This is a public repository. Do not commit:

- Credentials, tokens, certificates, connection strings, or generated secrets.
- Microsoft-internal URLs, tenant details, resource identifiers, or
  environment-specific configuration.
- Customer, partner, employee, or other nonpublic data.
- Private previews, unreleased service details, or internal-only instructions.
- Generated outputs containing retrieved content unless their publication has
  been reviewed and approved.
- Third-party code or content without a compatible license and attribution.

Use synthetic examples and public information. If you are unsure whether
content is publishable, remove it from the change until the appropriate review
is complete.

## Pull requests

Keep pull requests focused on one sample or one repository-level concern. In
the pull request description:

1. Explain the scenario and important design choices.
2. List the commands used to validate the change.
3. Identify any service access, cost, or deployment requirements.
4. Confirm that the public-content boundary above has been reviewed.

Pull requests require review from the owners configured in
`.github/CODEOWNERS`. Do not merge until required checks and reviews pass.
