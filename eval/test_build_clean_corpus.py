import json
from pathlib import Path

from build_clean_corpus import AUTHORED, derive_golden_outputs


def test_derive_golden_outputs_dedupes_and_tags(tmp_path: Path) -> None:
    golden = tmp_path / "golden.jsonl"
    golden.write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "id": 1,
                        "cat": "sva",
                        "input": "She go to school.",
                        "golden": "She goes to school.",
                    }
                ),
                json.dumps(
                    {
                        "id": 2,
                        "cat": "clean",
                        "input": "Nothing wrong here.",
                        "golden": "Nothing wrong here.",
                    }
                ),
                json.dumps(
                    {
                        "id": 3,
                        "cat": "sva",
                        "input": "She go to school!",
                        "golden": "She goes to school.",
                    }
                ),  # dup golden
            ]
        )
        + "\n"
    )
    rows = derive_golden_outputs(str(golden))
    texts = [r["text"] for r in rows]
    assert "She goes to school." in texts
    assert "Nothing wrong here." in texts
    assert len(texts) == len(set(texts))  # deduped
    assert all(r["register"] == "golden" for r in rows)
    assert all(r["id"].startswith("g") for r in rows)


def test_authored_sentences_are_tagged_and_nonempty() -> None:
    assert len(AUTHORED) >= 30
    registers = {r for _, r in AUTHORED}
    assert registers == {"casual", "technical", "british"}
    assert all(s.strip() for s, _ in AUTHORED)
