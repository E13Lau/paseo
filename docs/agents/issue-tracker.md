# Issue tracker: GitHub

Issues and PRDs for this fork live as GitHub issues in `E13Lau/paseo`. Use the `gh` CLI for all operations and pass `--repo E13Lau/paseo` explicitly. Do not infer the repository from the tracked branch because `main` tracks `upstream/main`.

## Conventions

- **Create an issue**: `gh issue create --repo E13Lau/paseo --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo E13Lau/paseo --comments`, filtering comments with `jq` and also fetching labels.
- **List issues**: `gh issue list --repo E13Lau/paseo --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo E13Lau/paseo --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --repo E13Lau/paseo --add-label "..."` or `--remove-label "..."`
- **Close**: `gh issue close <number> --repo E13Lau/paseo --comment "..."`

## Pull requests as a triage surface

**PRs as a request surface: no.**

Do not include pull requests in the triage queue. GitHub shares one number space across issues and pull requests, so verify ambiguous references before mutating them.

## When a skill says "publish to the issue tracker"

Create an issue in `E13Lau/paseo`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo E13Lau/paseo --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes, Decisions-so-far, and Fog body.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Where sub-issues are unavailable, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Use a `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`. Assign a claimed ticket to the driving developer.
- **Blocking**: use GitHub native issue dependencies. Add an edge with `gh api --method POST repos/E13Lau/paseo/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where the blocker database ID comes from `gh api repos/E13Lau/paseo/issues/<number> --jq .id`. Where dependencies are unavailable, use a `Blocked by: #<number>` line at the top of the child body.
- **Frontier query**: list the map's open children, remove assigned tickets and tickets with open blockers, then choose the first remaining ticket in map order.
- **Claim**: `gh issue edit <number> --repo E13Lau/paseo --add-assignee @me`. This is the session's first write.
- **Resolve**: comment with the answer, close the child, then append its context pointer to the map's Decisions-so-far.
