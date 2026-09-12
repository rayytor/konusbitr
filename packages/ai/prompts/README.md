# Prompts

Every prompt Konusbitr sends lives here as a versioned file, never as an inline
string literal in the code that sends it.

The reason is measurement. Phase 08 adds the eval harness' two gates — recall@8
and faithfulness, each failing CI on a drop of more than two points — and a
score that moves has to be attributable to something. A prompt edited inside a
`streamText` call is a change with no diff of its own: it shows up in a commit
touching twelve other things, and six weeks later nobody can say which change
cost two points of faithfulness.

Naming: `<role>.<purpose>.v<n>.md`, e.g. `chat.answer.v1.md`. A prompt is never
edited in place once it has an eval result attached to it; a new version gets a
new number and the old file stays until nothing references it.

Phase 10 writes the first one.
