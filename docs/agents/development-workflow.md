# Fork repository execution rules

This document defines the repository-level execution rules for the `E13Lau/paseo` fork. Agents and contributors working in this checkout must follow these rules. They take precedence over upstream Paseo's default branch and pull request workflow when work targets this fork.

This fork uses trunk-based development. `main` is the integration branch and the default destination for completed changes.

## Remotes

- `origin` is the fork at `E13Lau/paseo`. Push fork changes here.
- `upstream` is the official `getpaseo/paseo` repository. Fetch from it; never push to it.
- Local `main` tracks `upstream/main` for upstream discovery. Git's default push remote remains `origin`.

## Land changes

Commit completed, verified changes directly to local `main`, then push them to `origin/main`:

```bash
git switch main
git push origin main
```

Do not create a feature branch or pull request by default. Use one only when the user requests isolation, review, or a pull request explicitly.

## Sync upstream

Merge official changes into the fork's trunk without rewriting published fork history:

```bash
git switch main
git fetch upstream --prune
git merge upstream/main
git push origin main
```

Resolve conflicts on `main`, run the relevant checks, and push the merge only after verification. Do not rebase or force-push published `main`.
