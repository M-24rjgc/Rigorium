# Router Policy Benchmark

Seed: deterministic · buckets: 12 · turns: 600 · judge correctness: 0.85

| policy | judge call rate | learned agreement | success rate | cost units |
|---|---|---|---|---|
| judge-only | 100.0% | n/a | 92.7% | 6207 |
| heuristic+judge | 81.5% | n/a | 92.7% | 5323 |
| gate | 12.5% | 87.4% | 91.8% | 3079 |
| gate+explore | 15.8% | 86.7% | 92.2% | 3241 |
| sticky+gate | 9.3% | 65.1% | 90.5% | 4417 |

**heuristic+judge** vs judge-only: judge calls **-18.5%**, success rate +0.0pp, cost **-14.2%** vs baseline.
**gate** vs judge-only: judge calls **-87.5%**, success rate -0.8pp, cost **-50.4%** vs baseline.
**gate+explore** vs judge-only: judge calls **-84.2%**, success rate -0.5pp, cost **-47.8%** vs baseline.
**sticky+gate** vs judge-only: judge calls **-90.7%**, success rate -2.2pp, cost **-28.8%** vs baseline.

