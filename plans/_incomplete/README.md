# `_incomplete` - parked plans with work left

Plan folders in here were **started but are not finished**. Some stages shipped, or the plan
was fully authored and then paused, or everything was built but a follow-up never closed.
Whatever the reason, there is outstanding work.

This is a parking bay, not a graveyard. A plan in here is expected to be picked up again - so
it must say plainly what's left, and where to restart.

## The plan lifecycle

A staged plan (see the `/plan` skill for how they're authored) lives in exactly one of three
places, and the folder it sits in tells you its state:

| Location | State |
|---|---|
| `plans/<feature>-plan/` | **Live.** Being written, or being executed right now. |
| `plans/_incomplete/<feature>-plan/` | **Parked.** Started, but has outstanding work. |
| `plans/_complete/<feature>-plan/` | **Finished.** Every stage done and verified; nothing left. |

New plans are authored at `plans/<feature>-plan/` and stay there while they're being worked.
Park one in here the moment it stops being worked with anything left over. When the last
outstanding item finally closes, `git mv` it on to `_complete`.

## What lands here

Anything that isn't 100%. In particular, the case that's easy to misfile:

- **All stages ticked, but a follow-up is open.** A plan that ends "…awaits a package bump" or
  "…needs a deploy before it works at runtime" is **not** complete, however green its stage
  table looks. It parks here until the follow-up lands and someone verifies the feature
  actually works.

Also here: plans with unbuilt stages, plans paused mid-execution, and plans that were authored
but never started (a never-started plan can equally sit live at `plans/<feature>-plan/` - park
it here once it's clearly not being picked up soon).

A stage that was **intentionally** design-only or descoped against a locked decision does not
count as outstanding - that's a decision, not a gap.

## Parking a plan properly

Use **`git mv`** so the folder keeps its history, then make sure `00-overview.md`'s status line
answers, in one or two lines:

- what shipped,
- what's left,
- what unblocks it (a deploy? a decision? a dependency in another repo?).

Someone picking this up in three months should learn all that without reading the stages. If
the reason it parked was an external blocker, say whether that blocker is still real - a plan
parked on "blocked by X" long after X resolved is the main way this folder rots.
