# Slippay agents — four units, mechanically bounded

Money agents, not chatbots. Every one is a **pair**: enforcement code (the teeth,
holds even if the agent's model is fully compromised) + an `.ssl` policy (the
auditable statement). If code and spec disagree, **the code wins**.

| agent | role | teeth | tests |
|---|---|---|---|
| **Billing** | proposes charge intents | `billing/bill.mjs` — eligibility (active, period-elapsed, not expired/maxed); consented amount+recipient only | 7 |
| **Authority** | the gate | `authority/authorize.mjs` — ed25519 signature + consent-digest (anti slow-drift) + replay | 5 |
| **Settlement** | reconciles payments | `settlement/settle.mjs` — memo + **consented-recipient** (closes redirection) + amount + replay | 8 |
| **AntiAbuse** | the panopticon | `antiabuse/antiabuse.mjs` — velocity + conservation + non-interference; **HALT = disarm to empty toolset** | 7 |
| **Validator** | policy cross-checker | `policy_validator.test.mjs` — validates `.ssl` specifications against runtime code constants | 7 |

`node --test agents/**/*.test.mjs` → 53/53 (incl. the Axl primitives and Policy Validator).

## The chain composes

```
Billing.proposeCharge ─intent→ Authority.authorizeIntent ─ok→ Settlement.verifySettlement ─ok→ mark paid
                                         ▲                                                      
                            AntiAbuse observes every edge; HALT disarms any agent
```

The emitted intent shape is shared end-to-end, so the four units snap together
without a shared mutable helper that could become a backdoor.

## Policy Specification Mechanisms: AXL vs SSL

The repository contains two policy-expression mechanisms designed for distinct, non-overlapping purposes:

```
┌───────────────────────────────────────────────────────────────────────────┐
│                              Slippay Policies                             │
└─────────────────────┬───────────────────────────────┬─────────────────────┘
                      │                               │
        [Normative & Machine-Checked]    [Descriptive & Auditable Spec]
               AXL Framework                       SSL Documents
       (agents/axl, axl-compiler)                (agents/**/*.ssl)
                      │                               │
                      ▼                               ▼
    - Mechanical toolset binding (`bind`)       - High-level governance spec
    - Output schema constraint (`constrain`)    - Human- and auditor-readable
    - Formal SMT/Z3 invariant proofs (`prove`)   - Authoritative: CODE WINS
    - Gated by `axl-gate.sh` in CI              - Cross-checked by `policy_validator.test.mjs`
```

### 1. Status of `.ssl` Files (Descriptive & Auditable)
- **Status**: **Descriptive**. `.ssl` documents provide an auditable statement of intent for humans, compliance teams, and security auditors.
- **Precedence**: In a money system, an agent cannot be trusted to honor its own assertions. If an `.ssl` file and runtime code disagree, **the code wins**.
- **Anti-Drift Guard**: To prevent documentation from becoming an untrustworthy dead letter, `agents/policy_validator.test.mjs` continuously validates:
  1. Every error `reason` in code is declared in the matching `.ssl` `@assertions`.
  2. Every tool bound in `.ssl` `@bind` matches the agent's actual capability whitelist.
  3. Prohibited capabilities (`HARD_DENY`) are absent from code and toolsets.
  4. Operational intervals and thresholds (e.g. in `pulse.ssl` and `pulse.py`) match exactly.

### 2. Status of AXL (Normative & Machine-Checked)
- **Status**: **Normative**. AXL (`agents/axl/` and `axl-compiler/`) is compiled into runtime code and discharged as mathematical proofs.
- **Enforcement**:
  1. `bind` mechanically restricts the tool definitions presented to the LLM. An unbound tool (such as `transfer_funds`) is omitted from the request schema entirely.
  2. `constrain` enforces JSON schema decoding constraints.
  3. `prove` evaluates deterministic predicates in code and checks budget invariants via Z3/SMT solvers (`proofs/spending_policy_prover.py`).

### 3. When to Use Each
- **Use AXL** when creating or modifying executable agent boundaries, toolsets, and mathematical proof obligations.
- **Use SSL** when defining declarative domain governance, auditor-facing vows, event-trigger mappings, and state lifetimes.
- **Always update both** when modifying agent behavior, and verify with `node --test agents/**/*.test.mjs`.

## Why this is mechanical, not advisory

For a money system an `.ssl` `@assertion` is **not** the security boundary — a
compromised agent will not honor its own assertions. The boundary is what the
agent cannot control:

1. **Axl `bind`** — each agent's `tools=[...]` array contains only its bound
   capabilities. Billing/Authority/Settlement/AntiAbuse all lack `transfer_funds`;
   the model cannot emit a tool that isn't in the request. (`agents/axl/`)
2. **`prove` as code** — Authority/Settlement/Billing decisions are deterministic
   checks (signatures, consent digests, periods), never an LLM judge.
3. **On-chain ceiling** — the audited Soroban wallet (cap + allowlist) bounds any
   authorized spend, and its budget invariant is **machine-checked** (`outflow ≤
   2·window_cap` over all action sequences — `agents/axl/proofs/`).
4. **HALT** — AntiAbuse recompiles a flagged agent to the empty toolset: zero
   action space, not a request to stop.

A fully IPI-compromised agent still cannot move money: it lacks the tool, its
proposal fails the deterministic gate, the on-chain cap bounds it, and AntiAbuse
can disarm it.

## Honest gaps

- The agents are tested in isolation; wiring the chain into the live charge path
  (`supabase/functions/api`) + the listener is the integration step, not done.
- AntiAbuse's per-event label check is money-path-local; the full non-interference
  checker over a declared flow graph is `agents/ifc/` (Python, 16/16) — production
  AntiAbuse delegates whole-graph checks to it (cross-language boundary).
- The `.ssl` files are descriptive auditable specs whose synchronization with
  runtime code is asserted by `policy_validator.test.mjs`.
