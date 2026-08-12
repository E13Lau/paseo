# Domain docs

This repository uses a single-context domain documentation layout.

## Before exploring

Read:

- `CONTEXT.md` at the repository root when it exists.
- Relevant system and subject documentation under `docs/`. The repository's `CLAUDE.md` documentation table routes each subject to its source of truth.
- ADRs under `docs/adr/` that affect the area being changed.

If `CONTEXT.md` or `docs/adr/` does not exist, proceed silently. Do not create either preemptively. The `domain-modeling` skill creates them when domain language or architectural decisions are resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   ├── adr/
│   └── ...
└── packages/
```

`CONTEXT.md` owns shared domain language. `docs/adr/` owns system-wide architectural decisions. Existing subject documentation under `docs/` remains the source of truth for its subject.

## Use the glossary vocabulary

Use terms defined by `CONTEXT.md` and `docs/glossary.md` in issue titles, proposals, hypotheses, and test names. The UI label wins when the two differ.

If a required concept is absent, reconsider whether the project already uses another term. Record a real terminology gap for `domain-modeling`.

## Flag ADR conflicts

If proposed work contradicts an ADR, surface the conflict explicitly instead of silently overriding it:

> Contradicts ADR-0007 — worth reopening because…
