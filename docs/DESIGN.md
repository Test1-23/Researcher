# Researcher — Design

Status: **draft, under discussion**. No pipeline code written yet.
Companion documents: `docs/lecture-authoring-sop.md` (prior art), `docs/corpus-spec.md` (measured conventions).

---

## 0 What this is

An automated, general-purpose lecture-series generator.

Give it a topic, an audience and (optionally) a style template; it runs the whole
production line end to end — research, outline, modelling, computation, tables,
prose, answers, review, verification, export — and hands back a printable
lecture series plus an honest report of what it did and did not verify.

It is **not** a prompt wrapper. The design bet is:

> **The language model owns the narrative. Code owns the numbers.**

Every countable or computable value in the output is produced by executed code,
recorded in a ledger with full provenance, and re-derived independently before
delivery. Prose refers to values by identifier; the model never types a number
that code has not computed.

---

## 1 What the reference corpus taught us

The five-lecture group-theory series (`Group-Theory-v2`) is a worked example of
the target output quality. Measuring it produced a machine-checkable style
specification. Full numbers in `docs/corpus-spec.md`; the load-bearing findings:

| Finding | Measured value | Why it matters |
|---|---|---|
| Theorem numbering | **shared counter** across Theorem/Lemma/Corollary/Proposition, restarting each lecture | A generator that numbers per-type produces a document that looks wrong to anyone who knows the series |
| Exercise blank budget | **exactly 4** `<br>` inline, **exactly 12** chapter | Perfectly regular across all 5 lectures — a linter target with zero tolerance |
| Chapter exercises | **exactly 8**, every lecture, marks summing 37–45 | Fixed quota, not "some exercises" |
| Inline exercises | 16, 16, 16, 24, 20 — i.e. **exactly 4 per numbered chapter** | Structure is derived, not improvised |
| Discussion sections | one per numbered section, questions only | Every section ends with an unanswered prompt |
| Answer mirroring | body order == answer order, 100%, all 5 lectures | The single most valuable structural invariant |
| Review section | 5–6 fill-in-the-blank items | Not free-form recall |
| Notes section | 6–11 checkbox items | Self-check list, one per chapter |
| Cross-lecture refs | `Theorem 10 of Lecture 2`, `§3.5`, `(planned)` | Requires a series-wide symbol table to validate |
| Hand-made tables | 0 in L4, L5; 1–10 in L1–L3 | Tables were the most error-prone artifact |

Two further observations that shaped the architecture:

1. **Lecture 5's answers file ends with a verification note** naming
   `scripts/verify_lecture5.py`. Verification was already part of the workflow —
   just not automated for every lecture.
2. **Lecture 1 defers to a future lecture** (`> Lecture 2 (planned): ...`). The
   series is authored in order and forward-references are explicit.

### 1.1 Inferred workflow

Reading the artifacts backwards gives the process that produced them:

```
pick scope for this lecture
  → fix the section list
  → for each section: definitions first, then theorems (proofs), then a worked
    example, then remarks, then 4 exercises
  → generate the tables the section needs
  → write the 8 chapter exercises with mark allocations
  → write the answers file in body order
  → cross-check numbering and references
  → verify the numbers
  → write the Notes self-check list
  → export
```

Researcher automates exactly this, with a human gate where the corpus author
would have thought hardest: the outline.

---

## 2 Architecture: everything is a plugin

The hard requirement: **workflows, search tools, and every other operation are
plugins**, so the system can be extended without touching the core.

```
┌──────────────────────────────────────────────────────────────┐
│  Kernel  (small, stable, knows nothing about group theory)    │
│  · plugin registry + manifest loader                          │
│  · capability bus (typed events between plugins)              │
│  · run store (append-only artifacts, versions, provenance)    │
│  · scheduler (DAG of stages, resume, cancel, budget)          │
│  · credential vault                                           │
└───────────────┬──────────────────────────────────────────────┘
                │  plugins register capabilities
   ┌────────────┼────────────┬─────────────┬──────────────┐
   │            │            │             │              │
 sources/    providers/   compute/      authoring/     verification/
 · web       · deepseek   · sandbox     · outline      · structure
 · pdf       · openai     · brute enum  · body         · numeric
 · local     · local llm  · formula     · answers      · reference
 · arxiv     · vision     · CAS         · tables       · critique
   │            │            │             │              │
   └────────────┴────────────┴─────────────┴──────────────┘
                │
           workflows/         export/
           · math-lecture     · markdown
           · generic-lecture  · pdf
           · outline-only     · docx
```

**The core has no domain knowledge.** A "lecture about group theory" and a
"lecture about the Thirty Years' War" are the same pipeline with different
plugins loaded.

### 2.1 Plugin contract

Every plugin is a directory with a manifest:

```yaml
# plugins/sources/web/manifest.yaml
id: sources.web
kind: source
version: 1.0.0
entry: plugin.py
provides: [search, fetch]
requires: [kernel.http]
config_schema: schema.json      # drives the settings UI automatically
```

```python
# plugins/sources/web/plugin.py
from researcher.kernel import SourcePlugin, capability

class WebSource(SourcePlugin):
    id = "sources.web"

    @capability("search")
    def search(self, query: str, limit: int = 5) -> list[Result]: ...

    @capability("fetch")
    def fetch(self, url: str) -> Document: ...
```

Rules:

- Plugins communicate **only** through the capability bus, never by importing
  each other. This is what makes replacement possible.
- Every plugin declares a `config_schema`; the desktop settings UI is generated
  from it. No plugin-specific UI code.
- Plugins are sandboxed per their declared permissions (`network`, `filesystem`,
  `subprocess`). A source plugin gets network; a compute plugin gets subprocess
  but no network.
- **Verification plugins may not declare a dependency on any authoring plugin.**
  Enforced at load time by import-graph analysis.

### 2.2 Plugin kinds

| Kind | Contract | Ships with |
|---|---|---|
| `source` | `search`, `fetch` → `Document` | web, pdf, local files |
| `provider` | `complete`, `complete_structured`, `embed` | any OpenAI-compatible endpoint |
| `compute` | `evaluate(spec) -> Value` with provenance | sandbox python, brute-force enumerator, symbolic |
| `authoring` | `plan`, `write_section`, `write_exercise`, ... | lecture body, answers |
| `verification` | `check(artifact) -> [Finding]` | structure, numbers, cross-references |
| `workflow` | declares a stage DAG | math-lecture, generic |
| `export` | `render(artifact, format) -> file` | markdown, pdf, docx |

The built-in workflow is itself a plugin, so a user can fork it.

---

## 3 The pipeline

| # | Stage | Produces | Plugin kind | Gate |
|---|---|---|---|---|
| 0 | Intake | `task-card.yaml` | workflow | required fields present |
| 1 | Template | `style-contract.yaml` | source + provider (vision) | human confirm |
| 2 | Research | `evidence/*.yaml` | source | every claim has a URL + date |
| 3 | Boundary | `scope.md`, `termbase.yaml` | authoring | — |
| 4 | Outline | `outline.md`, `outline.json` | authoring | **human approve** |
| 5 | Model | `models/*.py` | provider + sandbox | sandbox exit 0 |
| 6 | Compute | `ledger.json`, `tables/*.md` | compute | two independent paths agree |
| 7 | Body | `lecture-N.md` | authoring | structure lint |
| 8 | Answers | `lecture-N-answers.md` | authoring | numbering mirrors body |
| 9 | Critique | `critique-N.json` | verification | no blocking findings |
| 10 | Verify | `verify-N.json`, report | verification | exit 0, 0 FAIL |
| 11 | Deliver | `report.md`, export | export | — |

Every stage writes to `.researcher/runs/<run-id>/`, append-only. Any stage can be
re-run in isolation; downstream stages resume from stored artifacts.

---

## 4 How "LLM writes the code" stays trustworthy

The owner's decision: the model may write computation code, and that code counts
as a verification path. Four mechanisms make this safe.

### 4.1 Sandbox with provenance

Each generated snippet runs in a subprocess: isolated mode, temporary working
directory, no network, wall-clock timeout, output cap, memory cap. Every run
records model, prompt hash, code hash, stdout, exit code, random seed, and
timing. **A value without provenance cannot enter the ledger.**

### 4.2 Cross-redundant derivation

```
              one value
            ╱          ╲
   implementation A    implementation B
   (model X, prompt P1) (model Y or same model, prompt P2, cannot see A)
            ╲          ╱
         must agree → ledger entry
```

Two independent implementations agreeing is strong evidence; one implementation
asserting itself is not. Disagreement escalates: a third implementation, or a
value flagged for human review. This is the replacement for "the verifier must
not import the generator" in a world where the model writes both.

### 4.3 Invariant self-check

When the model writes a model, it must also declare checkable properties:
the table is a Latin square; the count equals brute-force enumeration; the
probabilities sum to 1; the subgroup order divides the group order. Code executes
those assertions. **A value with no declared invariant is marked lower-trust.**

### 4.4 Independent verifier

The verifier re-parses the finished Markdown and re-derives every number from
the stored model, never importing the generator. Structural checks are pure text
analysis against the corpus spec.

---

## 5 Style contract

Derived from the corpus, `style-contract.yaml` is the frozen agreement:

```yaml
header: "<u>{series} {author}</u>"
title: "# {series} {n}: {title}"
answer_title: "<u>{series} {n}: {title} — Answers {author}</u>"
numbering:
  theorem_counter: shared          # Theorem/Lemma/Corollary share one counter
  restart_per_lecture: true
  sections: "## {n}.{m}"
  exercises_inline: "**Exercise {n}.{m}.**"
  exercises_chapter: "**Chapter Exercise {k}.**"
blank_budget:
  inline: 4
  chapter: 12
quota:
  chapter_exercises: 8
  inline_per_section: 4
  review_items: 5-6
blocks: [Definition, Theorem, Lemma, Corollary, Proof, Example, Non-example,
         Remark, Step, Conclusion]
sections_per_lecture: [Review, numbered chapters, Discussion, Notes,
                       Chapter Exercises]
```

A `structure` verification plugin enforces this mechanically. Because the
contract is data, a different teacher's style is a different YAML file.

---

## 6 Desktop application

Electron 33 + Vite 6 + React 18 + TypeScript, mirroring the MdReader stack.

| Region | Contents |
|---|---|
| Left | Projects → run list → stage tree (status, duration, cost) |
| Centre | Artifact viewer: Markdown + KaTeX, diff between runs |
| Right | Review panel (approve/reject/annotate a gate) + chat with the agent |
| Settings | API providers (base_url, key, models, **test connection**); role → model mapping; autonomy level; budget cap; sandbox level; export options |

Settings are generated from each plugin's `config_schema`, so adding a provider
plugin adds a settings pane with no UI work.

---

## 7 Decisions taken

| Decision | Choice |
|---|---|
| Automation | Full pipeline automated, every stage |
| Generality | No domain in core; domain arrives via plugins |
| LLM-written compute code | Allowed, and may serve as a verification path |
| Safety net | Sandbox + provenance + cross-redundant derivation + invariants |
| Interface | Desktop app (Electron), CLI shares the same engine |
| Output | Markdown first, PDF on demand |
| Non-math domains | Deferred; the plugin boundary is left open for them |
| Human gate | Outline approval, adjustable via autonomy level |

## 8 Open questions

1. Sandbox default level: basic subprocess, hardened (no network + import
   allowlist + memory cap), or Docker when available?
2. Engine transport for the app: local HTTP + SSE, or stdio JSON-RPC?
3. Reference corpus as test fixture: pin a copy into `examples/` or read from
   the user's folder?

## 9 Milestones

| # | Scope | Done when |
|---|---|---|
| M0 | Kernel: plugin registry, run store, capability bus, provider plugin | `researcher init` creates a task card |
| M1 | Source plugins + research stage + evidence ledger | a topic yields a sourced boundary note |
| M2 | Outline stage + gate | outline produced and blocks on approval |
| M3 | Sandbox + compute plugins + ledger + cross-redundancy | values agree across two paths |
| M4 | Authoring plugins: body + answers with id injection | one lecture, zero unregistered numbers |
| M5 | Verification plugins + critique loop | verifier exit 0 |
| M6 | Export to PDF | printable output |
| M7 | Desktop app | full run driven from the UI |
| M8 | Corpus conformance | generated lecture passes the structure contract derived from `Group-Theory-v2` |
