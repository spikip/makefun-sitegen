[![Competition](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/spikip/makefun-sitegen/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/spikip/makefun-sitegen/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# makefun-sitegen

A faster drop-in replacement for makefun-site 1.0.0, built for the make.fun
bounty [Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122).
`solve.js` exports `run(input)`, which returns exactly the output tree
makefun-site 1.0.0's build returns for a case's `{ site, templates, files }` —
every page's `index.html`, the index and tag pages, `build-report.txt` and
each static file, byte for byte — and `main.ts` is the harness driver that
reads `/input/cases.json`, answers each case with `run`, and writes
`/output/answers.json`.

## How it is faster

The reference walks generic plugin, lexer and tree-walking renderer stages;
this entry keeps the semantics (front matter, the Markdown subset, the
template dialect, the slug rule, the build report) and rebuilds the machinery
for CPU:

- Templates are parsed once per case and **compiled into generated
  functions**; includes are inlined at compile time with the same depth cap,
  and lookup paths are hoisted into constants.
- Markdown is rendered in **one pass over the lines**, and the inline
  renderer works on index ranges of the original string, jumping between
  marks with a native scan instead of slicing substrings per mark.
- HTML escaping is a single native scan; clean values pass through untouched.
- Front matter is parsed by scanning lines in place — the body is sliced out
  of the source, never split and rejoined.
- Slugs, long dates and resolved link targets are **memoised within a case**
  (titles, tag names and dates repeat heavily across a site); nothing is
  cached between cases.
- Slugification keeps a pure-ASCII fast path that skips Unicode
  normalisation, and word counting uses a whitespace table instead of a
  regex per document.

Measured beside the house baseline on this machine (process CPU, practice
set, interleaved medians): about **3.1× faster** warm, about **2.2× faster**
on the build phase of a cold run. Verified byte-identical on the practice
set and on 60 additional cases drawn with the competition's own generator
from fresh seeds.

## Run it

```sh
node main.ts   # reads /input/cases.json, writes /output/answers.json
```

Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in
for `/input` and `/output`. Node 22, no dependencies.
