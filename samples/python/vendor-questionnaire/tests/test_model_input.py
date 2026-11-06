# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

from webiq_vendor_questionnaire.client import Page
from webiq_vendor_questionnaire.model_input import (
    INSTRUCTIONS,
    build_model_input,
    check_model_answer,
    longest_copied_run,
)

SOURCE = "Synthetic source sentence number {} for demonstration only. "
PAGE = Page(
    "https://contoso.example/trust",
    "Trust",
    "".join(SOURCE.format(i) for i in range(20)),
    None,
    None,
)


def test_model_input_numbers_the_sources_and_includes_the_passages():
    prompt = build_model_input("Where is data stored?", (PAGE,))
    assert prompt.startswith(INSTRUCTIONS)
    assert "Question: Where is data stored?" in prompt
    assert "[1] Trust" in prompt
    assert PAGE.url in prompt
    assert PAGE.content.strip() in prompt


def test_paraphrased_answer_passes_the_check():
    answer = "The trust page describes where data is kept [1]."
    assert check_model_answer(answer, (PAGE,)) == []


def test_copied_answer_is_flagged():
    copied = PAGE.content[:250]
    findings = check_model_answer(f"The page says: {copied} [1]", (PAGE,))
    assert len(findings) == 1
    assert findings[0].url == PAGE.url
    assert findings[0].copied_characters >= 250


def test_longest_copied_run():
    assert longest_copied_run("abc hello world xyz", "hello world") == len("hello world")
    assert longest_copied_run("", "source") == 0
