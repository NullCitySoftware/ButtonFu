# `_future` - work deliberately deferred to down the line

Plan folders in here are **not blocked and not owed**. Nothing is waiting on a credential, a
deploy, a sibling session or a bug. Somebody looked at the work, agreed it was worth doing, and
decided it belongs **later**.

That is the whole distinction from `_incomplete`. Blocked on something nameable → `_incomplete`.
Nobody's blocked and we simply chose not to do it yet → here.

This is **not** a backlog dump and not a graveyard. Everything in here was consciously deferred,
with a reason and a trigger. A folder that can't say what would bring it back doesn't belong.

## The plan lifecycle

A staged plan (see the `/plan` skill for how they're authored) lives in exactly one of four
places, and the folder it sits in tells you its state:

| Location | State |
|---|---|
| `plans/<feature>-plan/` | **Live.** Being written, or being executed right now. |
| `plans/_incomplete/<feature>-plan/` | **Parked.** Started, has outstanding work, blocked on something identifiable. |
| `plans/_future/<feature>-plan/` | **Deliberately later.** Nothing blocked; doing it is a decision for down the line. |
| `plans/_complete/<feature>-plan/` | **Finished.** Every stage done and verified; nothing left. |

## Carve out - never park a finished plan to carry a straggler

The rule that keeps this folder honest, and the main reason it exists:

**When a plan is done except for one deliberately-deferred item, do not move the whole plan
here.** That buries a folder of completed work under an open heading, and every future reader
has to re-read the whole plan to find the one live line.

Instead:

1. **Carve the straggler into its own small plan** - often a single stage plus verification. Its
   status line and a *Carved out of* line in `00-overview.md` name the plan it came from, with a
   relative link to that plan's new home.
2. `git mv` the carved plan into here.
3. Note the carve-out in the **original** plan - one line: what left, why, where it went - and
   file the original to `_complete`.

The original then reads as finished, because it is. This folder holds exactly the work that is
actually outstanding and nothing else.

Carve **per coherent item**, not per leftover checkbox - three related stragglers are one carved
plan, not three. And don't invent a middle disposition ("mostly complete", a TODO section at the
bottom of an otherwise-done plan): carve, then close.

## What a plan in here must say

`00-overview.md`'s status line answers, in a line or two:

- **what this would add** - the value, stated for someone who has forgotten the context;
- **why it was deferred** rather than built - the actual reason, not "no time";
- **what it was carved out of**, if anything, with a link;
- **the trigger** - the concrete event that should bring it back: a user asking for it, a
  dependency landing, a threshold crossed, a release it should ride.

A `_future` plan with no trigger is a wish, and reads as noise to whoever finds it. If you can't
name one, the options are to build it now or to close it as won't-do - not to file it here.

## Reviving one

`git mv` it back out to `plans/<feature>-plan/`, refresh its grounding (plans go stale fast in
these repos - re-derive file numbers and paths from the live tree, never from the plan text),
and work it like any other live plan.
