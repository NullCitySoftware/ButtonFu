# `_complete` - finished plans

Plan folders in here are **done, 100%**. Every stage shipped and was verified, and nothing is
outstanding - including the follow-ups a plan logged as "out of this plan's hands". A plan
only lands here once that last box is genuinely ticked.

The point of this folder is that it can be **trusted at a glance**. If a plan is in here, you
do not need to read it to find out whether there is work left. There isn't.

## The plan lifecycle

A staged plan (see the `/plan` skill for how they're authored) lives in exactly one of three
places, and the folder it sits in tells you its state:

| Location | State |
|---|---|
| `plans/<feature>-plan/` | **Live.** Being written, or being executed right now. |
| `plans/_incomplete/<feature>-plan/` | **Parked.** Started, but has outstanding work. |
| `plans/_complete/<feature>-plan/` | **Finished.** Every stage done and verified; nothing left. |

New plans are authored at `plans/<feature>-plan/` and stay there while they're being worked.
When the work stops - whether because it finished or because it was parked - the folder moves
into `_complete` or `_incomplete` accordingly. Move the folder **wholesale**; never split a
plan across two folders.

## What counts as complete

All of these must hold. If any one of them doesn't, the plan belongs in `_incomplete`:

- Every stage's status line reads done - or **intentionally** design-only/descoped against a
  locked decision. An explicit "we decided not to build this" counts as complete; a stage that
  merely never got built does not.
- The verification stage ran and passed.
- Every follow-up the plan logged is closed, **including ones that depend on another repo, a
  package bump, or a deploy**. This is the one people get wrong: a plan whose stages are all
  ticked but which ends "…awaits a deploy to light up at runtime" is **not** complete. It is
  `_incomplete` until that deploy lands and someone verifies the thing actually works.

When in doubt, `_incomplete`. A plan filed here wrongly is worse than a plan filed nowhere,
because it silently retires work that was never finished.

## Moving a plan

Use **`git mv`**, so the folder keeps its history. Leave the stage docs alone otherwise - a
finished plan is a record of what was built, not a document to tidy up. Update the status line
in `00-overview.md` if it's stale, and that's it.
