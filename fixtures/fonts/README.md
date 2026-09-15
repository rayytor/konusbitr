# Fixture fonts

Subsets of the Noto families, committed so that regenerating the multilingual
PDF fixtures does not depend on what the person running `fixtures/generate.py`
happens to have installed.

That property is the point. `fixtures/generate.py` is byte-stable precisely so
that a diff on `fixtures/pdf/` means the corpus actually moved; a system font
would make it mean "this machine has a different version of Noto", and the one
fixture that always shows up in `git status` is the one nobody reads diffs of.

| File | Source | Used by |
|---|---|---|
| `NotoSans-subset.ttf` | Noto Sans Regular | the Turkish page, the scanned table, the chart labels |
| `NotoSansArabic-subset.ttf` | Noto Sans Arabic Regular | the Arabic page |
| `NotoSansCJK-subset.ttf` | Noto Sans CJK Regular | the Chinese and Japanese pages |

Each is cut down to exactly the characters `fixtures/fixture_text.py` uses,
which turns a 20MB CJK family into a few kilobytes that belong in a repository.
The Arabic subset keeps its `GSUB`/`GPOS` tables: Arabic is contextually shaped,
and a subset without them renders a row of disconnected letters that neither a
reader nor a recogniser would accept as Arabic.

Regenerate with `./scripts/vendor-fixture-fonts.py`, on a machine with
`fonts-noto-core` and `fonts-noto-cjk` installed. Re-run it only to widen the
character set or to pick up a new upstream release — and expect the fixture PDFs
to change when you do.

## Licensing

Noto is licensed under the [SIL Open Font License 1.1][ofl], which permits
redistribution of subsets under the same terms. The OFL is a font licence rather
than a software licence and places no condition on the rest of this repository,
which remains Apache-2.0; `services/worker/tests/test_licensing.py` audits the
*installed Python environment* and has nothing to say about these files, so this
note is where the provenance lives.

[ofl]: https://openfontlicense.org/
