# budget-router architecture

Four source files, no dependencies. Everything runs inside Claude Code; nothing leaves the machine.

| File | Role | Engine calls |
|---|---|---|
| `hooks/register.ts` | The hooks, session state, the daily budget ledger and the route decision | `$.store`, `$.ui.status`, `$.ui.toast`, `$.session.usage`, `$.session.cwd`, `$.session.append` |
| `hooks/policy.ts` | Pure routing helpers: Unreal rule, cache-aware switching, pace controller, cost ladder, escalation, context notices | none |
| `hooks/smart.ts` | The learner: a cost-aware bandit over (model, effort) | none |
| `hooks/tips.ts` | Fixed-text tips and the rules for when to show one (the caller shows them as a toast) | none |
| `agents/*.md` | Five helper subagents Claude Code offers by their descriptions; not part of the mod | none |
| `study/report.py` (repository root) | Offline usage report with conclusions; never run by the plugin, outside the plugin folder | none (reads your transcripts when you run it) |

## Architecture

```mermaid
flowchart LR
  subgraph CC["Claude Code (the engine)"]
    direction TB
    EV["Events<br/>session.start · session.measure<br/>prompt.submit · turn.step<br/>tool.call · turn.complete"]
    UI["Status bar and notices"]
    ST[("Plugin store<br/>~/.claude/plugins/store")]
    TR["Transcript"]
  end
  subgraph MOD["budget-router mod"]
    direction TB
    REG["register.ts<br/>hooks + state + ledger + decide()"]
    POL["policy.ts<br/>pure helpers"]
    SM["smart.ts<br/>learner"]
    TP["tips.ts<br/>fixed-text tips"]
    REG --> POL
    REG --> SM
    REG --> TP
  end
  API["Anthropic API"]
  EV -- "every event, passed on with next(e)" --> REG
  REG -- "model + effort of each request (turn.step)" --> EV
  REG -- "$.ui.status / $.ui.toast" --> UI
  REG -- "$.store get / set / delete" --> ST
  REG -- "one system note when a cap starts" --> TR
  EV -- "requests (made by Claude Code, not the mod)" --> API
```

The mod makes no request of its own, runs no program, reads no file and registers no tool or command. The only thing it changes in an event is the `model` and `effort` of a request in `turn.step`.

## Modules and types

```mermaid
classDiagram
  direction LR
  class Register["register.ts"] {
    +register(on, options)
    -readOptions(options) Opts
    -absorb(ledger, rateLimits, now) Ledger
    -pressure(ledger, now) Pressure
    -classify(prompt, prevTier) Tier
    -decide(tier, why, pressure, x, kind) Route
    -escalate(step, base) Spec
    -learnFromTurn(isAborted, usage)
    -pacerUpdate(pressure, now)
    -showStatus(pressure)
    -notify(text)
  }
  class Policy["policy.ts"] {
    +isUnrealBuildPrompt(text) bool
    +shouldStick(ctx, distance, sinceLast) bool
    +targetPercent(hour, start, end) number
    +pacerStep(state, day, now, error) PacerState
    +shiftLadder(spec, steps) Spec
    +escalationFor(errors) Escalation
    +applyEscalation(spec, esc) Spec
    +idleRebuild(ctx, sinceLast) IdleRebuild
    +sizeNudgeText(ctx, family) string
  }
  class Smart["smart.ts"] {
    +ARMS : 13 model·effort pairs
    +features(prompt, ctx, prevSize) number[]
    +pickArm(PickInput) Choice
    +record(store, outcome) SmartStore
    +correct(store, outcome) SmartStore
    +fadeFamily(store, family) SmartStore
    +kindOf(prompt) string
    +followUp(prev, next) FollowUp
  }
  class Tips["tips.ts"] {
    +pickTip(signals, shown) Tip
  }
  class Opts {
    tiers : 5 x Spec
    warnPercent, warnCap
    criticalPercent, criticalCap
    wrapUpPercent, includeFiveHour
    pin, learnMode, idleGuard
    nudgeContext, paceControl
    unrealRules, escalateOnTrouble
  }
  class Ledger {
    day, windowReset
    windowStartPct, lastPct, carry
    budgetPts, fiveHourPct
    alerted, wrapped
  }
  class Pressure {
    daily, five, week : percent
    level 0..3
  }
  class Route {
    family, effort, tier, why
  }
  class SmartStore {
    v = 2
    cells : scope -> arm -> Cell
    weights : 256 numbers over prompt shape
    seen, saved, explore
  }
  class PacerState {
    i, u, day, lastE, lastT
  }
  Register ..> Policy : uses
  Register ..> Smart : uses
  Register ..> Tips : uses
  Register --> Opts
  Register --> Ledger : store key "ledger"
  Register --> SmartStore : store key "smart"
  Register --> PacerState : store key "pacer"
  Ledger ..> Pressure : pressure()
  Register ..> Route : decide()
```

Store keys: `ledger`, `models` (full model ids seen), `pacer`, `smart`. No prompt text is stored anywhere; `SmartStore` holds counts, costs, a fixed kind label and a hash of the project folder.

## Which model id is sent

`turn.step` receives the model Claude Code chose and may change it. The mod never invents an id it cannot justify:

```mermaid
flowchart TD
  S["Route says family F<br/>(haiku, sonnet or opus)"] --> R{"Is the current model one<br/>the plugin recognises?"}
  R -->|no| K["Leave the request alone"]
  R -->|yes| Q{"Already the right family?"}
  Q -->|yes| Same["Keep the current model id"]
  Q -->|no| L{"Has this session run<br/>an id for F?"}
  L -->|yes| U["Use that id"]
  L -->|no| P{"Current id is plain<br/>claude-family-version?"}
  P -->|yes| W["Swap the family word:<br/>same generation"]
  P -->|"Fable / Mythos"| N["Use the known current id for F"]
  P -->|"dated or provider id"| K
```

A dated id such as `claude-sonnet-4-5-20250929`, a provider-specific id or a company deployment name is never rewritten, because the swapped name may not exist for the other family.

## What happens in one turn

```mermaid
sequenceDiagram
  autonumber
  actor You
  participant CC as Claude Code
  participant Mod as budget-router
  participant Store as Plugin store
  participant API as Anthropic API

  Note over CC,Mod: once per session
  CC->>Mod: session.start
  Mod->>Store: load ledger, model ids, pacer, learner (delete retired keys)
  Mod-->>CC: next(e), status bar drawn

  You->>CC: types a prompt
  CC->>Mod: prompt.submit(text)
  Mod->>Mod: classify -> tier, decide() -> route
  opt a situation calls for a tip
    Mod-->>CC: toast only (never added to the conversation)
  end
  Mod-->>CC: next(e): the prompt unchanged

  loop each request of the turn
    CC->>Mod: turn.step(model, effort)
    Mod->>Mod: route, raised if tool calls keep failing, capped by the budget
    Mod-->>CC: next({model, effort})
    CC->>API: request on that model and effort
    opt the model calls a tool
      CC->>Mod: tool.call
      Mod-->>CC: whatever next(e) returned (a failure is counted)
    end
  end

  CC->>Mod: session.measure(rate limits, context size)
  Mod->>Store: ledger updated
  Mod-->>CC: status bar, plus a notice and system note when a cap starts
  CC->>Mod: turn.complete(usage)
  Mod->>Store: learner records outcome and cost
  Mod-->>CC: whatever next(e) returned
```

## How a route is decided

```mermaid
flowchart TD
  P["Typed prompt"] --> C{"classify<br/>keyword rules"}
  C -->|"think hard"| T5["max"]
  C -->|"ok / continue"| TP["previous tier"]
  C -->|"design, refactor, security..."| T4["deep"]
  C -->|"hi, thanks..."| T1["trivial"]
  C -->|otherwise| T3["standard (or previous)"]
  T5 & TP & T4 & T1 & T3 --> U{"Unreal build error<br/>on a cheap tier?"}
  U -->|yes| US["standard"] --> S
  U -->|no| S["tier -> model·effort<br/>(or the pin option)"]
  S --> K{"long conversation,<br/>cache warm, one-step switch?"}
  K -->|yes| KS["keep the current model"] --> L
  K -->|no| L{"learner on and<br/>evidence for a move?"}
  L -->|live| LM["move one step"] --> F
  L -->|no evidence / shadow| F{"model family's own<br/>weekly limit >= 92%?"}
  F -->|yes| FD["one family down"] --> PC
  F -->|no| PC{"ahead of the<br/>even-pace line?"}
  PC -->|yes| PS["1-2 cost steps cheaper"] --> CAP
  PC -->|no| CAP{"today's budget"}
  CAP -->|">= 80% (or 5h)"| C2["cap at Haiku·medium"]
  CAP -->|">= 50%"| C1["cap at Sonnet·high"]
  CAP -->|below| H
  C1 & C2 --> H{"Haiku on a context<br/>over 100k tokens?"}
  H -->|yes| HS["Sonnet instead"] --> R
  H -->|no| R["route for the turn"]
  R --> E["per request: +1 effort after 3 failed tool calls,<br/>+1 model after 6 (caps still apply)"]
```

A pin skips the sticky rule, the learner, the family rule, pace control and escalation; the caps still apply.

## Budget states

```mermaid
stateDiagram-v2
  [*] --> Normal: first reading of the day sets today's budget
  Normal --> Capped: 50% of today (or 5-hour window)
  Capped --> CappedHard: 80%
  CappedHard --> Spent: 100%
  Normal --> Normal: wrap-up notice at 90% (once)
  Spent --> [*]: local midnight, a new share
  note right of Spent: nothing is refused, turns stay at the second cap
```
