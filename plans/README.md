# `plans/` - staged implementation plans

Every plan in this repo lives here, **not** in `docs/`. The split is deliberate:

| Folder | Holds |
|---|---|
| `plans/` | **Work**: staged plans an agent executes, and the record of ones that finished. |
| `docs/` | **Documentation**: conventions, specs, runbooks, architecture, how-tos - the things plans *produce* and that outlive them. |

A plan is a unit of work with an end. A doc is a description of how the thing is. When a plan
finishes it stays here as its own record, and whatever lasting documentation it wrote lives in
`docs/`.

## The lifecycle - the folder a plan sits in IS its state

| Location | State |
|---|---|
| `plans/<feature>-plan/` | **Live.** Being written, or being executed right now. |
| `plans/_incomplete/<feature>-plan/` | **Parked.** Started, has outstanding work, blocked on something identifiable. |
| `plans/_future/<feature>-plan/` | **Deliberately later.** Nothing blocked; doing it is a decision for down the line. |
| `plans/_complete/<feature>-plan/` | **Finished.** Every stage done and verified; nothing left. |

New plans are authored at `plans/<feature>-plan/` and stay there while they're worked. When the
work stops, `git mv` the folder **wholesale** into one of the three buckets - never split a plan.
A brand-new plan nobody has started is still **live** at the root; `_future` means somebody
consciously decided to do it later.

Each bucket's own `README.md` carries the rules for landing there, including the **carve-out**
rule that stops a finished plan being parked to carry one straggler.

## Related

- The `/plan` skill authors these folders; `/runplan` executes one; `/listplans` lists them all
  across every repo in the workspace.
- Every plan folder holds `00-overview.md` (locked decisions + stage map), numbered stage files,
  a final verification stage, and `AI_SEED.md` - the single prompt that drives the whole plan.
