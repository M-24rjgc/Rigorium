---
name: research-method
description: Turn a ready, selected-candidate ResearchBrief into an executable and auditable method specification, isolated verification record, and read-only implementation snapshot. Use when formalizing mathematical definitions, assumptions, pseudocode, model structure, implementation routes, tests, failure boundaries, or evidence-backed conclusions for a research method.
---

# Specify and Verify a Research Method

Start only from a ready ResearchBrief with a selected candidate. Preserve its artifact reference and revise an existing MethodSpec by superseding it rather than replacing its identity.

Use `research_method` with `create_spec` or `revise_spec` to materialize the contract, `run_checks` to execute one isolated route, and `capture_snapshot` to preserve its verified implementation evidence.

- Define every symbol, domain, assumption, model component, procedure, and interface needed to implement the selected mechanism.
- Include pseudocode, complexity conditions, counterexamples, failure boundaries, stop rules, non-goals, and explicit training or inference applicability.
- Cross-reference each implementation route to its source files, test files, interfaces, and unit, numerical, or smoke checks. Keep every declared interface and check reachable from a route.
- Treat expected conclusions as hypotheses. State which passed verification checks would be required to support each one.
- Run checks only in a separate implementation workspace, using an executable plus argument list without a shell wrapper and with a minimal runtime environment. Treat the route's network setting as declared policy metadata: the local process runner does not itself provide a network sandbox, so use an external isolated runner when network enforcement is required.
- Record pass, failure, timeout, and cancellation distinctly. Preserve command identity, output hashes, byte counts, exit state, duration, and numerical tolerances.
- Capture source, test, and configuration files by relative path and content hash. Reject path escapes, symbolic links, and non-regular files.
- Keep capture read-only: never write to or commit the user Project, never include Git internals, and preserve dirty user content.
- Report observed conclusions separately from expected conclusions. Claim support only when every required check passed and the observation cites those exact records; otherwise mark it contradicted or inconclusive.
