# Router Policy Benchmark

Seed: deterministic · buckets: 12 · turns: 600 · judge correctness: 0.85

| policy | judge call rate | learned agreement | success rate | cost units |
|---|---|---|---|---|
| judge-only | 100.0% | n/a | 91.0% | 6167 |
| gate | 14.0% | 87.2% | 90.0% | 3124 |
| gate+explore | 28.7% | 93.0% | 94.8% | 3758 |
| sticky+gate | 14.3% | 80.0% | 96.2% | 5806 |

**gate** vs judge-only: judge calls **-86.0%**, success rate -1.0pp, cost **-49.3%** vs baseline.
**gate+explore** vs judge-only: judge calls **-71.3%**, success rate +3.8pp, cost **-39.1%** vs baseline.
**sticky+gate** vs judge-only: judge calls **-85.7%**, success rate +5.2pp, cost **-5.9%** vs baseline.

