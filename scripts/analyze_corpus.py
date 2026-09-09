"""Reverse-engineer the authoring conventions from the reference corpus.

Read-only analysis. Prints a structured report to stdout.
Run: C:/Python314/python.exe scripts/analyze_corpus.py <corpus_dir>
"""
import os
import re
import sys
from collections import Counter

sys.stdout.reconfigure(encoding="utf-8")

CORPUS = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\elon2008\Documents\Group-Theory-v2"

BLOCKS = [
    ("Definition", r"\*\*Definition\.\*\*"),
    ("Theorem", r"\*\*Theorem\s+\d+"),
    ("Lemma", r"\*\*Lemma\s+\d+"),
    ("Corollary", r"\*\*Corollary\s+\d+"),
    ("Proposition", r"\*\*Proposition\s+\d+"),
    ("Proof", r"\*\*Proof\.\*\*"),
    ("Example", r"\*\*Example\.\*\*"),
    ("Non-example", r"\*\*Non-example\.\*\*"),
    ("Remark", r"\*\*Remark"),
    ("Step", r"\*\*Step\s+\d+"),
    ("Conclusion", r"\*\*Conclusion\.\*\*"),
]

rows = []
for n in range(1, 6):
    body_p = os.path.join(CORPUS, f"group-theory-lecture-{n}.md")
    ans_p = os.path.join(CORPUS, f"group-theory-lecture-{n}-answers.md")
    if not os.path.exists(body_p):
        print(f"!! missing {body_p}")
        continue
    body = open(body_p, encoding="utf-8").read()
    ans = open(ans_p, encoding="utf-8").read() if os.path.exists(ans_p) else ""

    inline = re.findall(r"\*\*Exercise (\d+\.\d+)\.\*\*", body)
    chap = re.findall(r"\*\*Chapter Exercise (\d+)\.\*\*", body)
    sections = re.findall(r"^## (\d+\.\d+) ", body, re.M)
    chapters = re.findall(r"^# (\d+) ", body, re.M)
    disc = re.findall(r"^## Discussion:\s*$", body, re.M)
    review_items = re.findall(r"^\d+\. .*?______", body, re.M)
    notes_items = re.findall(r"^- \[ \] ", body, re.M)
    tables = re.findall(r"^\|[^\n]*\|$", body, re.M)
    # group table lines into tables
    table_count = 0
    prev = False
    for line in body.splitlines():
        is_row = bool(re.match(r"^\|.*\|$", line))
        if is_row and not prev:
            table_count += 1
        prev = is_row

    # blank budget: count <br> between an exercise header and the next header
    def blank_budget(text, header_re):
        out = []
        hits = list(re.finditer(header_re, text))
        for i, m in enumerate(hits):
            end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
            segment = text[m.end():end]
            # stop at the next section/chapter heading if one comes first
            cut = re.search(r"^(#|## )", segment, re.M)
            if cut:
                segment = segment[:cut.start()]
            out.append(segment.count("<br>"))
        return out

    br_inline = blank_budget(body, r"\*\*Exercise \d+\.\d+\.\*\*")
    br_chapter = blank_budget(body, r"\*\*Chapter Exercise \d+\.\*\*")

    # cross references
    xref_thm = re.findall(r"Theorem\s+\d+\s+of\s+Lecture\s+(\d+)", body)
    xref_sec = re.findall(r"§[\d.]+ of Lecture (\d+)", body)
    xref_lec = re.findall(r"Lecture (\d+),", body)
    xref_ex = re.findall(r"Exercise\s+[\d.]+(?:\([a-z]\))?", body)
    planned = re.findall(r"^> Lecture (\d+) \(planned\)", body, re.M)

    # answers side
    ans_headers = re.findall(r"^## (?:Chapter )?Exercise ([\d.]+)", ans, re.M)
    ans_review = re.findall(r"^# Review\s*$", ans, re.M)
    ans_remark = re.findall(r"\*\*Remark\.\*\*", ans)
    ans_concl = re.findall(r"\*\*Conclusion\.\*\*", ans)
    ans_steps = re.findall(r"\*\*Step\s+\d+\*\*", ans)
    verify_note = re.findall(r"scripts/verify_lecture\d+\.py", ans)

    rows.append(dict(
        n=n,
        chapters=len(chapters),
        sections=len(sections),
        inline=len(inline),
        chap=len(chap),
        discussion=len(disc),
        review=len(review_items),
        notes=len(notes_items),
        tables=table_count,
        br_inline=sorted(set(br_inline)),
        br_chap=sorted(set(br_chapter)),
        ans_headers=len(ans_headers),
        ans_concl=len(ans_concl),
        ans_steps=len(ans_steps),
        verify=verify_note,
        xref_thm=len(xref_thm), xref_sec=len(xref_sec),
        xref_lec=len(xref_lec), xref_ex=len(xref_ex),
        planned=planned,
        block_counts={name: len(re.findall(pat, body)) for name, pat in BLOCKS},
        marks=len(re.findall(r"\[\d+\]", body)),
        inline_ids=inline, chap_ids=chap, ans_ids=ans_headers,
    ))

print("=" * 78)
print("REFERENCE CORPUS — MEASURED CONVENTIONS")
print("=" * 78)
hdr = f"{'L':>2} {'chapters':>8} {'sects':>5} {'inline':>6} {'chap':>4} {'disc':>4} {'rev':>3} {'notes':>5} {'tables':>6} {'marks':>5}"
print(hdr)
for r in rows:
    print(f"{r['n']:>2} {r['chapters']:>8} {r['sections']:>5} {r['inline']:>6} "
          f"{r['chap']:>4} {r['discussion']:>4} {r['review']:>3} {r['notes']:>5} {r['tables']:>6} {r['marks']:>5}")

print()
print("BLANK BUDGET (<br> count immediately after an exercise)")
for r in rows:
    print(f"  L{r['n']}: inline={r['br_inline']}  chapter={r['br_chap']}")

print()
print("BLOCK INVENTORY (body)")
names = [b[0] for b in BLOCKS]
print("  L  " + "  ".join(f"{x[:9]:>9}" for x in names))
for r in rows:
    print(f"  {r['n']}  " + "  ".join(f"{r['block_counts'][x]:>9}" for x in names))

print()
print("ANSWER FILE")
for r in rows:
    print(f"  L{r['n']}: headers={r['ans_headers']} (inline={r['inline']}, chapter={r['chap']}) "
          f"Conclusion={r['ans_concl']} Step-labels={r['ans_steps']} verify_ref={r['verify']}")

print()
print("CROSS-REFERENCES (body)")
for r in rows:
    print(f"  L{r['n']}: Thm-of-Lec={r['xref_thm']} §-of-Lec={r['xref_sec']} "
          f"Lec-comma={r['xref_lec']} Exercise-refs={r['xref_ex']} planned={r['planned']}")

print()
print("ID MIRROR CHECK (body order == answer order)")
for r in rows:
    body_ids = [f"{r['n']}.{i}" for i in []]  # placeholder
    ok_inline = all(a == b for a, b in zip(r['inline_ids'], r['ans_ids']))
    print(f"  L{r['n']}: inline ids {r['inline_ids']}")
    print(f"       answer ids {r['ans_ids']}")
    print(f"       chapter ids {r['chap_ids']}")
