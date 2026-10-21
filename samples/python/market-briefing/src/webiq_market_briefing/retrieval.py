# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from collections.abc import Iterable

from webiq import WebIQClient
from webiq.types import ContentFormat

from .models import Evidence

MAX_CONTENT_CHARACTERS = 3_500
MAX_EVIDENCE_ITEMS = 18


def retrieve_evidence(
    api_key: str,
    queries: Iterable[str],
    max_results: int,
    region: str,
) -> list[Evidence]:
    evidence_by_url: dict[str, Evidence] = {}

    with WebIQClient(api_key=api_key, timeout=30.0) as client:
        for query in queries:
            web_response = client.web.search(
                query,
                max_results=max_results,
                language="en",
                region=region,
                content_format=ContentFormat.markdown,
                max_length=MAX_CONTENT_CHARACTERS,
            )
            for result in web_response.webResults or []:
                item = _to_evidence(
                    title=result.title,
                    url=result.url,
                    content=result.content,
                    query=query,
                    result_type="web",
                    updated_at=result.lastUpdatedAt,
                )
                if item:
                    evidence_by_url.setdefault(item.url, item)

            news_response = client.news.search(
                query,
                max_results=max_results,
                language="en",
                region=region,
                content_format=ContentFormat.markdown,
                max_length=MAX_CONTENT_CHARACTERS,
            )
            for result in news_response.newsResults or []:
                item = _to_evidence(
                    title=result.title,
                    url=result.url,
                    content=result.content,
                    query=query,
                    result_type="news",
                    publisher=result.source,
                    updated_at=result.lastUpdatedAt,
                )
                if item:
                    evidence_by_url.setdefault(item.url, item)

    return list(evidence_by_url.values())[:MAX_EVIDENCE_ITEMS]


def _to_evidence(
    *,
    title: str | None,
    url: str | None,
    content: str | None,
    query: str,
    result_type: str,
    publisher: str | None = None,
    updated_at: str | None = None,
) -> Evidence | None:
    if not title or not url or not content:
        return None

    return Evidence(
        title=title.strip(),
        url=url.strip(),
        content=content.strip()[:MAX_CONTENT_CHARACTERS],
        query=query,
        result_type=result_type,
        publisher=publisher.strip() if publisher else None,
        updated_at=updated_at,
    )
