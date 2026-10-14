# Issue tracker: Local Markdown

Issues and specs for this locally maintained fork live as Markdown files
in `.scratch/`. Keep issue creation, comments, and triage updates local.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- The spec is `.scratch/<feature-slug>/spec.md`.
- Implementation issues are one file per ticket:
  `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`.
- Triage state is a `Status:` line near the top of each issue file.
  Use the role strings from `triage-labels.md`.
- Record the triage category as `Category: bug` or `Category: enhancement`.
- Append comments and conversation history under `## Comments`.

## When a skill says "publish to the issue tracker"

Create a local file under `.scratch/<feature-slug>/`, creating directories
as needed.

## When a skill says "fetch the relevant ticket"

Read the referenced local file. The user normally supplies its path or
issue number; resolve numbers within the relevant feature directory.

## Wayfinding operations

Used by `/wayfinder`. The map is a file with one child file per ticket.

- Map: `.scratch/<effort>/map.md`, with Notes, Decisions-so-far, and Fog.
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`.
  Record `Type: research`, `prototype`, `grilling`, or `task`.
- Blocking: a `Blocked by: NN, NN` line near the top.
  A ticket is unblocked when every listed ticket is resolved.
- Frontier: scan the effort's tickets for open, unblocked, unclaimed work;
  first by number wins.
- Claim: set `Status: claimed` and save before work.
- Resolve: append the answer under `## Answer`, set `Status: resolved`,
  and append a summary and local link to the map's Decisions-so-far.

Wayfinding tickets use `claimed` and `resolved` for their lifecycle;
triaged issues use the states in `triage-labels.md`.
