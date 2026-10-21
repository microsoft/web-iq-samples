# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from datetime import date

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
    assert "A supported finding [1]." in markdown
    assert "## Sources" in markdown
    assert "1. [Example source](https://example.com/report)" in markdown
