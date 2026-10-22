# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

import json
import logging
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest
from webiq import WebIQClient
from webiq.errors import APIConnectionError, APIStatusError

from webiq_market_briefing import retrieval


@pytest.mark.parametrize("auth_mode", ["api-key", "entra"])
def test_passage_search_and_authentication(monkeypatch, caplog, auth_mode) -> None:
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(
            200, headers={"x-traceid": "trace-success"},
            json={"webResults": [{
                "title": "Title", "url": "https://example.com", "content": "Passage",
            }]} if request.url.path.endswith("/web") else {"newsResults": []},
        )

    credential = MagicMock()
    credential.__enter__.return_value = credential
    credential.get_token.return_value = SimpleNamespace(token="test-token")
    credential_factory = MagicMock(return_value=credential)
    monkeypatch.setattr(retrieval, "DefaultAzureCredential", credential_factory)
    with httpx.Client(base_url="https://api.microsoft.ai/v3", transport=httpx.MockTransport(respond)) as http_client:
        monkeypatch.setattr(
            retrieval, "WebIQClient",
            lambda **kwargs: WebIQClient(http_client=http_client, **kwargs),
        )
        with caplog.at_level(logging.INFO, logger="webiq_market_briefing"):
            evidence = retrieval.retrieve_evidence(
                "test-key" if auth_mode == "api-key" else None,
                ["query"], 5, "US", auth_mode=auth_mode,
            )
    assert len(evidence) == 1
    assert len(requests) == 2
    for request in requests:
        body = json.loads(request.content)
        assert body["contentFormat"] == "passage"
        assert body["maxLength"] == 3000
        if auth_mode == "api-key":
            assert request.headers["x-apikey"] == "test-key"
            assert "authorization" not in request.headers
        else:
            assert request.headers["authorization"] == "Bearer test-token"
            assert "x-apikey" not in request.headers
    assert "trace-success" in caplog.text
    assert "test-key" not in caplog.text
    assert "test-token" not in caplog.text
    if auth_mode == "entra":
        credential.get_token.assert_called_with("https://api.microsoft.ai/.default")
        credential.__exit__.assert_called_once()
    else:
        credential_factory.assert_not_called()


@pytest.mark.parametrize(
    ("statuses", "guidance", "expected_calls"),
    [([503, 200], None, 2), ([429, 200], "3s", 2),
     ([430, 200], None, 2), ([401], None, 1), ([403], None, 1),
     ([400], None, 1), ([503, 503, 503], None, 3),
     ([429], "120s", 1), ([503], "120s", 1)],
)
def test_bounded_retries_and_sanitized_diagnostics(
    monkeypatch, caplog, statuses, guidance, expected_calls,
) -> None:
    requests = []
    sleeps = []

    def respond(request):
        status = statuses[len(requests)]
        requests.append(request)
        return httpx.Response(status, headers={"x-traceid": f"trace-{len(requests)}"}, json={
            "errorCode": "TransientError",
            "requestId": "request-123",
            "userMessage": "DO-NOT-LOG-SECRET",
            "retryAfter": guidance,
        })

    monkeypatch.setattr(retrieval.time, "sleep", sleeps.append)
    monkeypatch.setattr(retrieval.random, "uniform", lambda *args: 1.0)
    with httpx.Client(base_url="https://api.microsoft.ai/v3", transport=httpx.MockTransport(respond)) as http_client:
        with WebIQClient(
            api_key="test-key", http_client=http_client,
            retry=retrieval.RetryPolicy(max_retries=0),
            telemetry_hook=retrieval.log_webiq_attempt,
        ) as client:
            call = lambda: client.web.search("private query")
            if statuses[-1] == 200:
                retrieval._search_with_retry(call)
            else:
                with pytest.raises(APIStatusError):
                    retrieval._search_with_retry(call)
    assert len(requests) == expected_calls
    assert len(sleeps) == expected_calls - 1
    if guidance == "3s":
        assert sleeps == [3.0]
    if statuses == [503, 503, 503]:
        assert sleeps == [1.0, 2.0]
    assert "trace-1" in caplog.text
    assert "request-123" in caplog.text
    assert "TransientError" in caplog.text
    assert "DO-NOT-LOG-SECRET" not in caplog.text
    assert "private query" not in caplog.text


def test_connection_failure_retries_then_succeeds(monkeypatch) -> None:
    monkeypatch.setattr(retrieval.time, "sleep", lambda _: None)
    call = MagicMock(side_effect=[APIConnectionError("private detail"), "result"])
    assert retrieval._search_with_retry(call) == "result"
    assert call.call_count == 2


@pytest.mark.parametrize("url,content", [("javascript:alert(1)", "data"), ("https://example.com", " ")])
def test_unusable_evidence_is_not_sent_to_model(url, content) -> None:
    assert retrieval._to_evidence(
        title="Title", url=url, content=content, query="query", result_type="web",
    ) is None
