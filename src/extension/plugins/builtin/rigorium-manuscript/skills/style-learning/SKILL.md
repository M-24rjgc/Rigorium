---
name: style-learning
description: Learn a target venue's writing style at fine granularity from a ~10-paper corpus — sentence templates, paragraph structure, figure conventions, story arc — and persist the resulting style profile before drafting any paper for that venue.
---

# Learn a Venue's Writing Style (Fine-Grained)

AI-written papers have an "AI taste" — this skill exists so yours don't.
Before drafting any paper for a venue, learn what the venue's best papers
actually do, at the finest granularity you can manage. **One corpus, one
profile, per paper target** — never reuse another project's profile.

## Prerequisites

- The target venue is pinned (see `venue-template` skill).
- A corpus of ~10 papers exists (`venue_corpus action=papers_list`).
  Collect high-quality papers first if it is empty: recent Best Papers,
  top-scored papers (OpenReview/arXiv/Zotero), and surveys.

## Study procedure (per paper, then across papers)

Study each paper's PDF (use `describe_image` / page reading for figures;
`read_file` on LaTeX sources when available). Take notes per dimension:

1. **Story arc** — the order and weight of sections; how motivation opens,
   where the gap is stated, how the method is introduced, where ablations
   sit, how implications close. Note paragraph counts per section.
2. **Sentence templates** — collect 5-10 verbatim sentence shapes per slot:
   claim openers, transition/gap sentences, related-work comparisons,
   limitation statements, contribution bullets. Record them with the paper
   id as an example.
3. **Paragraph patterns** — how paragraphs open (claim first?), how evidence
   is woven in, how the last sentence hands off. Label patterns
   (claim-evidence-explanation, compare-contrast, ...).
4. **Figures** — style (palette, fonts, grid), caption structure
   (What → How → Takeaway?), rendering approach (tikz/matplotlib/vector).
5. **LaTeX conventions** — packages, notation habits, theorem environments,
   citation density and placement (parenthetical vs textual).

Then **synthesize across papers**: keep what is consistent, note variance,
and discard one-off quirks.

## Save the profile

`venue_corpus action=style_save profile={venue, computedAt, learnedFrom:[...paperIds], storyArc:[...], sentenceTemplates:[...], paragraphPatterns:[...], figureConventions:[...], latexConventions:{...}, writingVoice:"..."}`

The store validates structure; **you** validate fidelity. A saved profile
supersedes earlier ones for the same venue — save only when the learning is
genuinely better.

## Hard rules

- Study **each** of the ~10 papers individually before synthesizing — do not
  write a profile from a single paper or from memory of the venue.
- Quote real sentences as examples (with paper ids); never fabricate examples.
- One profile per venue per project; this paper's profile is this project's
  profile — the venue choice and the learning both happen up front, before
  drafting.
- After saving, every writing step for this paper must consult the profile:
  draft section openers from the sentence templates, follow the story arc,
  match figure conventions, and keep the writing voice.
