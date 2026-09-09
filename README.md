# Reasearcher

**Lecture Series Generator** — an agent-driven pipeline that turns the
[`lecture-authoring-sop.md`](docs/lecture-authoring-sop.md) standard operating
procedure into executable, machine-checked tooling.

> ⚠️ **Repository name note:** this directory is spelled `Reasearcher` because
> that is the name the repository owner requested. The intended English word is
> `Researcher`. The name is kept as-is so paths, remotes and clones stay stable.

---

## What this project is

`docs/lecture-authoring-sop.md` is a rigorous specification for producing
verifiable, printable lecture series where exercises and answers are separated.
It defines 11 stages, 11 quality gates, and a set of hard constraints (⛔) —
for example: never hand-type a table, never let the verifier import the
generator, never leak a solution into the body, never trust a PDF text layer.

Reasearcher's job is to **make that SOP executable**:

| SOP stage | Intended tooling |
|---|---|
| 0 Task scoping | task-card template + interactive intake |
| 1 Template extraction | PDF → PNG → contact sheet renderer |
| 2 Information retrieval | query builder + source/evidence table recorder |
| 3 Outline | outline generator from the mapping table |
| 4 Model first | model registry + `gen_tables.py` scaffold |
| 5 Body | body writer with structure self-check |
| 6 Answers | answer writer with numbering mirror check |
| 7 Independent verification | `verify_lectureN.py` scaffold (must not import generator) |
| 8 Failure triage | expected-vs-actual side-by-side diff helper |
| 9 Read-through | over-assertion scanner |
| 10 Delivery | report generator |

**Status: repository initialised, design under discussion.** No pipeline code
has been written yet. See the design discussion in the chat / issues.

---

## Repository layout

```
Reasearcher/
├── README.md                      ← you are here
├── LICENSE                        ← MIT
├── .gitignore
└── docs/
    └── lecture-authoring-sop.md   ← the governing specification
```

Planned (not yet created):

```
├── src/reasearcher/               ← package
│   ├── intake/                    ← stage 0–1
│   ├── retrieval/                 ← stage 2
│   ├── authoring/                 ← stage 3, 5, 6, 9
│   ├── modelling/                 ← stage 4
│   ├── verification/              ← stage 7–8
│   └── delivery/                  ← stage 10
├── templates/                     ← task card, outline, body, answer, report
├── tests/
└── examples/                      ← a worked reference lecture series
```

---

## Quick start

Nothing to run yet. Clone and read the spec:

```bash
git clone https://github.com/Test1-23/Reasearcher.git
cd Reasearcher
less docs/lecture-authoring-sop.md
```

---

## Guiding constraints

1. **The SOP is the contract.** Where this README and the SOP disagree, the SOP
   wins.
2. **Verification is independent.** A verifier must never import a generator;
   shared bugs stay invisible otherwise.
3. **Nothing is hand-typed.** Every table, count and order comes from code.
4. **Honest reporting.** The delivery report states what is done, verified, and
   not done — no vague "mostly complete".

## License

MIT — see [LICENSE](LICENSE).
