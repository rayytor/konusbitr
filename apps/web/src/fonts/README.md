# Vendored fonts

## `line-seed-jp-*.woff2`

**LINE Seed JP**, the UI typeface required by `design.md` §2, subset to Latin and
Latin Extended-A (English, Turkish, and most European diacritics). Text outside
that range falls through to the system sans stack declared in
`src/app/globals.css`.

It is vendored rather than fetched because the full family is a 3.6 MB CJK font
that `next/font/google` does not carry, and because a self-hosted Konusbitr
should not call out to a third-party CDN — the deployment may be air-gapped, and
its users' addresses are not Google's business.

Regenerate with [`scripts/vendor-fonts.py`](../../../../scripts/vendor-fonts.py);
do not hand-edit these files.

Licensed under the **SIL Open Font License 1.1**, which permits redistribution
and bundling. Copyright LINE Corporation. The OFL applies to these font files
only and does not affect the Apache-2.0 licensing of Konusbitr itself.

## Instrument Serif

Not vendored. It ships in `next/font/google`, which downloads and self-hosts it
at build time, so it is already offline-safe. It is also OFL-1.1.
