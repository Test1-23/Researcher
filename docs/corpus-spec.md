# Measured conventions of the reference corpus

Source: `Group-Theory-v2`, lectures 1–5 (body + answers files).
Produced by `scripts/analyze_corpus.py`; raw output in `corpus_report.txt`.

This file is the **evidence base** for `style-contract.yaml`. Every claim here
is a measurement, not an impression. Re-run the script to reproduce it.

---

## 1 Structural counts

| L | content chapters | subsections | inline exercises | chapter exercises | Discussion blocks | Review items | Notes checkboxes | hand-made tables | mark tags |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 2 | 4 | 16 | 8 | 1 | 5 | 6 | 10 | 15 |
| 2 | 4 | 15 | 16 | 8 | 4 | 5 | 9 | 3 | 17 |
| 3 | 4 | 10 | 16 | 8 | 4 | 5 | 11 | 1 | 21 |
| 4 | 6 | 9 | 24 | 8 | 6 | 6 | 11 | 0 | 21 |
| 5 | 5 | 11 | 20 | 8 | 5 | 6 | 9 | 0 | 24 |

Readings:

- **Inline exercises are exactly 4 per numbered chapter** — 4×4=16, 4×4=16,
  4×4=16, 4×6=24, 4×5=20. The count follows the chapter count, not the
  subsection count: Lecture 2 chapter 3 has five subsections and four exercises,
  Lecture 4 chapter 5 has no subsections and four exercises. Measured
  per-chapter in every lecture, the value is 4 without exception.
- **Chapter exercises are exactly 8 in every lecture.**
- Every content chapter carries a `## Discussion:` block with questions only —
  **with one exception**: Lecture 1 chapter 2 has none. That chapter is a table
  of examples and non-groups rather than a theory chapter, so the exception is
  structural, not an oversight.
- Review is fill-in-the-blank; item count drifts between 5 and 6.
- Notes is a checkbox list; item count drifts between 6 and 11.
- Lectures 4 and 5 contain **no hand-made tables**; earlier lectures do, and
  that is precisely where the error-prone content sat.

## 2 Blank budget

Measured as the number of `<br>` tags between an exercise header and the next
header:

| Lecture | inline | chapter |
|---|---|---|
| 1 | 4 | 12 |
| 2 | 4 | 12 |
| 3 | 4 | 12 |
| 4 | 4 | 12 |
| 5 | 4 | 12 |

**Zero variance across 20 lectures-worth of exercises.** This is a hard lint
target, not a guideline.

## 3 Numbering

The theorem-like environments share **one** counter per lecture:

```
L2: The1 The2 The3 Cor4 The5 Lem6 The7 The8 The9 The10 Lem11 The12
L3: The1 The2 The3 Cor4 The5 The6 Lem7 The8 Lem9 Lem10 The11 Cor12 Cor13 Cor14 Cor15
L4: The1 The2 The3 The4 Cor5 Cor6 The7 The8 Cor9 Lem10 The11 The12 The13 The14 Cor15
L5: The1 The2 The3 Cor4 Cor5 The6 Lem7 The8 The9 Cor10 Lem11 Cor12
```

The counter restarts at 1 in each lecture and runs across `Theorem`, `Lemma`,
`Corollary` and `Proposition` alike. Lecture 1 has no numbered theorem
environments at all (it is definitions and tables only).

Exercise numbering is `n.m` where `n` is the chapter and `m` the position within
it; chapter exercises are plain `1..8`.

## 4 Block inventory

| L | Definition | Theorem | Lemma | Corollary | Proof | Example | Non-example | Remark | Step | Conclusion |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 | 2 | 10 | 0 |
| 2 | 3 | 9 | 2 | 1 | 12 | 4 | 0 | 6 | 0 | 0 |
| 3 | 4 | 7 | 3 | 5 | 15 | 4 | 0 | 4 | 0 | 0 |
| 4 | 4 | 10 | 1 | 4 | 14 | 8 | 1 | 5 | 0 | 0 |
| 5 | 5 | 6 | 2 | 4 | 11 | 7 | 1 | 5 | 0 | 0 |

`Step` appears only in Lecture 1, where it labels the standard five-step group
check (`**Step 1: State the axioms.**` … `**Draw the conclusion.**`). It is not
the answer-file step format.

## 5 Answer file conventions

| L | answer headers | body inline | body chapter | Conclusion | verification note |
|---|---|---|---|---|---|
| 1 | 24 | 16 | 8 | 5 | — |
| 2 | 24 | 16 | 8 | 0 | — |
| 3 | 24 | 16 | 8 | 0 | — |
| 4 | 32 | 24 | 8 | 0 | — |
| 5 | 28 | 20 | 8 | 0 | `scripts/verify_lecture5.py` |

- **Answer headers exactly mirror the body**, in body order, with no extras and
  none missing — true for all five lectures. This is the strongest invariant in
  the corpus.
- Answers use `## Exercise n.m` and `## Chapter Exercise k` headings.
- `**Conclusion.**` is used sparingly (only Lecture 1, 5 times); most solutions
  end with a plain statement or a `**Remark.**`.
- `**Step 1** ...` chains appear in the SOP but **not** in this corpus's answer
  files. Treat step-labelling as optional furniture, not a requirement.

## 6 Cross-references

| L | `Theorem N of Lecture M` | `§x.y of Lecture M` | `Lecture N,` | exercise self-refs | planned forward ref |
|---|---|---|---|---|---|
| 1 | 0 | 0 | 0 | 29 | `> Lecture 2 (planned): ...` |
| 2 | 0 | 0 | 3 | 31 | `> Lecture 3 (planned): ...` |
| 3 | 7 | 1 | 6 | 24 | `> Lecture 4 (planned): ...` |
| 4 | 2 | 0 | 1 | 33 | — |
| 5 | 0 | 0 | 0 | 29 | — |

Cross-lecture references take the form `Theorem 10 of Lecture 2` and
`§3.5 of Lecture 2`. Forward references are explicit and marked `(planned)`.
A series-wide symbol table is required to validate these; a single-lecture view
cannot.

## 7 Fixed scaffolding

Every lecture file opens with:

```
<u>Group Theory Ethan Yan</u>

# Group Theory N: <Title>

> All answers to the exercises in this lecture are collected in
> `group-theory-lecture-N-answers.md`, in the same folder.

# Review

Complete the blanks.

1. ... ______ ...
```

Every answers file opens with:

```
<u>Group Theory N: <Title> — Answers Ethan Yan</u>

# Answers

This file contains the full solutions to every exercise in
`group-theory-lecture-N.md`. The numbering follows the lecture: ...
```

Every lecture closes with `# <N> Notes` (checkbox self-check) and
`# <N+1> Chapter Exercises` (8 questions, each followed by 12 `<br>`).

## 8 Mark allocations

Chapter exercises carry a total mark in square brackets, with sub-parts marked:

```
**Chapter Exercise 1.** [5] Let ... (a) [3] Prove ... (b) [2] Deduce ...
```

Per-lecture totals: L1 15, L2 17, L3 21, L4 21, L5 24 mark tags; the per-exercise
totals observed run 4–6 and the eight exercises sum to 37–45 marks.
