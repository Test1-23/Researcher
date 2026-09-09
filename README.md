# Researcher

**An LLM-powered lecture-series generator.** Give it a topic, an audience and a
style template; it produces a complete, printable lecture series — with the
exercises and the answers in separate files, and with every number, table and
count produced by code rather than guessed by a language model.

> **Status: repository initialised. Design under discussion — no pipeline code yet.**
> `docs/lecture-authoring-sop.md` is a *record of what has worked before*, kept
> as reference input to the design. It is not the specification this project is
> being built to satisfy; the design is deliberately broader.

---

## The problem this solves

Asking an LLM for a lecture series fails in predictable ways:

| Failure | Why it happens |
|---|---|
| Wrong arithmetic, wrong counts | The model predicts tokens; it does not compute |
| Broken tables | Markdown tables are hand-assembled and drift |
| Exercises without matching answers | Two documents generated independently |
| Answers that skip questions | No cross-document numbering check |
| Confident false claims | No verifiable grounding step |
| Style drift between lectures | No template contract |

Researcher attacks these structurally rather than by prompting harder.

## Core principle

> **The language model owns the narrative. Code owns the numbers.**

Anything countable, computable or enumerable — group tables, orbit counts,
probabilities, order statistics, worked numerical examples — is produced by a
deterministic model in Python, and the prose refers to those values by
identifier. The model never types a number that code has not computed.

This is the one idea worth building around. Everything else is plumbing.

## Intended pipeline

```
topic, audience, template, language, volume
      │
  [1] Intake ──────── task card; asks for anything missing
      │
  [2] Template ────── PDF → page images → vision model → style feature list
      │                (user confirms the contract)
      │
  [3] Research ────── syllabus boundary, terminology, known traps
      │                → evidence ledger with URLs + access dates
      │
  [4] Outline ─────── template-feature mapping, scope, section list
      │                ⛔ GATE: user confirms before any prose is written
      │
  [5] Model first ─── LLM emits a *model spec*; code builds the objects,
      │                generates every table and self-checks the axioms
      │
  [6] Body ────────── prose written against the model; values injected by id
      │
  [7] Answers ─────── separate file, numbering mirrored from the body
      │
  [8] Verify ──────── independent verifier re-derives every number from the
      │                model; structural + consistency checks; exit 0 or fail
      │
  [9] Triage ──────── on failure, re-derive the expected value first
      │
  [10] Deliver ────── report (done / verified / not done) + export
```

Steps 2, 4 and 9 involve the human. Step 5 is where the LLM is on a leash: it
proposes a machine-checkable description of the mathematical objects, and code
decides what is true about them.

## Repository layout

```
Researcher/
├── README.md
├── LICENSE
├── .gitignore
└── docs/
    └── lecture-authoring-sop.md   ← prior-art reference, not the spec
```

## Planned layout

```
├── src/researcher/
│   ├── llm/          provider abstraction (OpenAI-compatible, DeepSeek, Anthropic)
│   ├── intake/       task card, template extraction
│   ├── research/     search, evidence ledger
│   ├── outline/      mapping table, scope, gate
│   ├── model/        model spec DSL, executors, axiom self-check, table generation
│   ├── authoring/    body + answer writers, value injection by id
│   ├── verify/       independent verifier, structural + numeric checks
│   ├── triage/       expected-vs-actual diffing, repair loop
│   └── deliver/      report, markdown → pdf/html export
├── templates/        task card, outline, body, answers, report
├── tests/            including deliberately broken fixtures
└── examples/         a worked reference lecture series
```

## Design commitments

1. **Numbers come from code.** The LLM emits a model spec; code computes.
2. **Verification is independent.** A verifier must never import a generator —
   shared code hides shared bugs. Enforced by static import-graph analysis.
3. **Gates are real.** The outline gate blocks prose generation; it is not advice.
4. **Honest reports.** The delivery report states what is done, verified and not
   done. No "mostly complete".
5. **The reference spec is prior art, not scripture.** Where a rule in
   `docs/lecture-authoring-sop.md` does not serve the product, it is dropped.

## License

MIT — see [LICENSE](LICENSE).
