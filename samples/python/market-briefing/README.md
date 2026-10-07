# Web IQ Market Briefing

Generate a cited Markdown report from current web evidence. Web IQ retrieves the evidence and Azure OpenAI turns it into a concise briefing.

## Prerequisites

- Python 3.11 or later
- A Web IQ API key
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

Only API keys are read from environment variables. Azure OpenAI endpoint, deployment, and API version are read from `config.json`. The deployment name may differ from the underlying model name.

Use another configuration file with:

```powershell
webiq-market-briefing "Energy market" --config path\to\config.json
```

## Options

Run `webiq-market-briefing --help` for the complete list.

```text
--lookback-days N   Reporting window; default: 7
--max-results N     Results requested per Web IQ search; default: 5
--query TEXT        Use a specific query; repeat for multiple queries
--config PATH       Configuration file; default: config.json
--region REGION     Web IQ market region; default: US
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
2. Searches Web IQ web and news endpoints for Markdown passages.
3. Deduplicates results by URL and limits the evidence sent to the model.
4. Instructs Azure OpenAI to synthesize only from the supplied evidence.
5. Writes the briefing and a complete source list to one Markdown file.

Retrieved page content is treated as untrusted evidence, not as instructions to the model.

## Contribute

Install the sample in editable mode with its test dependency:

```powershell
python -m pip install -e ".[dev]"
```

Run the tests:

```powershell
pytest
```
