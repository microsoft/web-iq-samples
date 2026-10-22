# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from webiq.errors import APIStatusError

from webiq_market_briefing import cli
from webiq_market_briefing.models import Evidence


@pytest.mark.parametrize("auth_mode", ["api-key", "entra"])
def test_cli_auth_and_passage_output(monkeypatch, tmp_path, auth_mode) -> None:
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "model-key")
    monkeypatch.delenv("WEBIQ_API_KEY", raising=False)
    if auth_mode == "api-key":
        monkeypatch.setenv("WEBIQ_API_KEY", "web-key")
    monkeypatch.setattr(cli, "load_azure_openai_settings", lambda _: SimpleNamespace(
        endpoint="endpoint", api_version="version", deployment="deployment",
    ))
    retrieve = MagicMock(return_value=[
        Evidence("Title", "https://example.com", "Retrieved passage", "query", "web"),
    ])
    monkeypatch.setattr(cli, "retrieve_evidence", retrieve)
    monkeypatch.setattr(cli, "generate_report_body", lambda **kwargs: "Finding [1].")
    output = tmp_path / "report.md"
    assert cli.main(["Topic", "--webiq-auth", auth_mode, "--output", str(output)]) == 0
    assert retrieve.call_args.kwargs["auth_mode"] == auth_mode
    assert retrieve.call_args.kwargs["api_key"] == ("web-key" if auth_mode == "api-key" else None)
    assert "[[1]](#source-1)" in output.read_text(encoding="utf-8")
    assert "Retrieved passage" in output.read_text(encoding="utf-8")


def test_cli_requires_api_key_by_default(monkeypatch) -> None:
    monkeypatch.delenv("WEBIQ_API_KEY", raising=False)
    with pytest.raises(ValueError, match="WEBIQ_API_KEY"):
        cli.main([])


def test_entrypoint_does_not_print_raw_service_error(monkeypatch, capsys) -> None:
    monkeypatch.setattr(cli, "main", MagicMock(side_effect=APIStatusError(
        400, "private response containing credentials",
    )))
    with pytest.raises(SystemExit) as error:
        cli.entrypoint()
    assert error.value.code == 1
    assert "private response" not in capsys.readouterr().err


def test_invalid_model_report_preserves_existing_output(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("WEBIQ_API_KEY", "web-key")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "model-key")
    monkeypatch.setattr(cli, "load_azure_openai_settings", lambda _: SimpleNamespace(
        endpoint="endpoint", api_version="version", deployment="deployment",
    ))
    monkeypatch.setattr(cli, "retrieve_evidence", lambda **kwargs: [
        Evidence("Title", "https://example.com", "Passage", "query", "web"),
    ])
    monkeypatch.setattr(cli, "generate_report_body", lambda **kwargs: "Uncited report")
    output = tmp_path / "existing.md"
    output.write_text("Previous valid report", encoding="utf-8")
    with pytest.raises(RuntimeError, match="No report was written"):
        cli.main(["Topic", "--output", str(output)])
    assert output.read_text(encoding="utf-8") == "Previous valid report"
