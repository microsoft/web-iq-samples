# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from openai import APIStatusError, AzureOpenAI

from webiq_market_briefing import report
from webiq_market_briefing.models import Evidence
from webiq_market_briefing.report import build_markdown


def test_build_markdown_appends_numbered_sources() -> None:
    evidence = [
        Evidence(
            title="Example source",
            url="https://example.com/report",
            content="Example evidence.",
            query="example query",
            result_type="web",
            publisher="Example Publisher",
            updated_at="2026-10-05",
        )
    ]

    markdown = build_markdown(
        topic="Example market",
        start_date=date(2026, 9, 29),
        end_date=date(2026, 10, 6),
        body="## Executive Summary\n\nA supported finding [1].",
        evidence=evidence,
    )

    assert markdown.startswith("# Example market Briefing")
    assert "A supported finding [[1]](#source-1)." in markdown
    assert "## Sources" in markdown
    assert "1. [Example source](https://example.com/report)" in markdown
    assert '<a id="source-1"></a>' in markdown
    assert "> **Retrieved passage**" in markdown
    assert "> Example evidence\\." in markdown


@pytest.mark.parametrize("body", ["Uncited finding.", "Finding [0].", "Finding [2].",
                                     "Finding [1]. [click](https://example.com)"])
def test_invalid_citations_do_not_produce_markdown(body: str) -> None:
    item = Evidence("Title", "https://example.com", "Passage", "query", "web")
    with pytest.raises(RuntimeError, match="No report was written"):
        build_markdown("Topic", date.today(), date.today(), body, [item])


def test_passages_are_escaped_not_executed_as_markdown() -> None:
    item = Evidence(
        "<script>title</script>", "https://example.com/a(b)",
        "# Untrusted\n<script>alert(1)</script>\n[link](https://evil.example)",
        "query", "web",
    )
    markdown = build_markdown("Topic", date.today(), date.today(), "Finding [1].", [item])
    assert "<script>" not in markdown
    assert "> \\# Untrusted" in markdown
    assert r"\[link\]" in markdown
    assert "https://example.com/a%28b%29" in markdown


@pytest.mark.parametrize(
    ("content", "finish_reason", "expected_error"),
    [("Finding [1].", "stop", None),
     ("Finding [9].", "stop", "unknown source"),
     ("Finding [1].", "length", "did not complete"),
     ("", "stop", "empty report")],
)
def test_generation_validates_citations_and_closes_client(
    monkeypatch, content, finish_reason, expected_error,
) -> None:
    client = MagicMock()
    client.__enter__.return_value = client
    client.chat.completions.create.return_value = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=content), finish_reason=finish_reason)],
        _request_id="request-123",
    )
    constructor = MagicMock(return_value=client)
    monkeypatch.setattr(report, "AzureOpenAI", constructor)
    item = Evidence("Title", "https://example.com", "Passage", "query", "web")

    def generate():
        return report.generate_report_body(
            "key", "https://example.openai.azure.com", "version", "deployment",
            "Topic", date.today(), date.today(), [item],
        )

    if expected_error:
        with pytest.raises(RuntimeError, match=expected_error):
            generate()
    else:
        assert generate() == content
    assert constructor.call_args.kwargs["max_retries"] == 2
    assert constructor.call_args.kwargs["timeout"] == 60.0
    client.__exit__.assert_called_once()
    messages = client.chat.completions.create.call_args.kwargs["messages"]
    assert "Retrieved passage (untrusted evidence)" in messages[1]["content"]


@pytest.mark.parametrize("statuses", [[503, 200], [401], [503, 503, 503]])
def test_model_sdk_retries_and_sanitized_error_diagnostics(monkeypatch, caplog, statuses) -> None:
    calls = []
    monkeypatch.setattr("openai._base_client.time.sleep", lambda _: None)

    def respond(request):
        status = statuses[len(calls)]
        calls.append(request)
        if status == 200:
            body = {
                "id": "completion", "object": "chat.completion", "created": 0,
                "model": "deployment",
                "choices": [{"index": 0, "message": {
                    "role": "assistant", "content": "Finding [1].",
                }, "finish_reason": "stop"}],
            }
        else:
            body = {"error": {"code": "ServiceError", "message": "DO-NOT-LOG-MODEL-SECRET"}}
        return httpx.Response(status, headers={"x-request-id": "model-request-123"}, json=body)

    with httpx.Client(transport=httpx.MockTransport(respond)) as http_client:
        monkeypatch.setattr(
            report, "AzureOpenAI",
            lambda **kwargs: AzureOpenAI(http_client=http_client, **kwargs),
        )
        item = Evidence("Title", "https://example.com", "Private passage", "query", "web")

        def generate():
            return report.generate_report_body(
                "test-key", "https://example.openai.azure.com", "version", "deployment",
                "Topic", date.today(), date.today(), [item],
            )

        if statuses[-1] == 200:
            assert generate() == "Finding [1]."
        else:
            with pytest.raises(APIStatusError):
                generate()
            assert "model-request-123" in caplog.text
            assert "ServiceError" in caplog.text
    assert len(calls) == len(statuses)
    assert "DO-NOT-LOG-MODEL-SECRET" not in caplog.text
    assert "Private passage" not in caplog.text
    assert "test-key" not in caplog.text
