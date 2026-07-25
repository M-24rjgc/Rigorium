# Manuscript and LaTeX upstream record

Verified on 2026-07-25. URLs, releases, venue rules, and local executables can change; refresh this record before adding a new venue year or redistributing third-party files.

## Adopted boundaries

| Candidate | Verified version or pin | License evidence | Use in Rigorium |
| --- | --- | --- | --- |
| ICLR Master Template | commit `a28d335b0d46a3c39b205704a65faf41c9748433`, `iclr2026.zip`, SHA-256 `b6d63b29992e153f804bb6d170c57db156c011b5bedf96a9f31d58813b909acf`, 241296 bytes | The repository has no top-level LICENSE. Individual bundled files mention LPPL, while the aggregate archive does not declare one license. | Pin and probe only. The template is not vendored or redistributed. Users supply or fetch it from the official source. |
| ICLR 2026 Author Guide | `https://iclr.cc/Conferences/2026/AuthorGuide` | Official venue policy page | Supplies the anonymous-submission, 9-page main-text, references, and appendix checks. |
| Latexmk | upstream CTAN 4.88, local exercised version 4.86a | GPL-2.0 (`https://ctan.org/pkg/latexmk`) | Preferred external process orchestrator. No code is copied or linked. |
| pdfTeX / XeTeX / LuaTeX | TeX Live 2025; local pdfTeX 1.40.27, XeTeX 0.999997, LuaTeX 1.22.0 | Local version notices report LGPL terms for pdfTeX/XeTeX and GPL-2.0-or-later for LuaTeX. | External engine fallbacks detected from PATH. No binaries are bundled. |
| BibTeX / Biber | local BibTeX 0.99d; local Biber 2.20; upstream Biber 2.21 | Biber Artistic-2.0 (`https://github.com/plk/biber`) | External bibliography executables only. Biber probe timeout is reported instead of assumed healthy. |
| Tectonic | upstream release 0.16.9; official Windows MSVC asset SHA-256 `131a24604785a9600989a3d91225f597df52ac06f00aeffe86fd529f99ee5cdd` | MIT for Tectonic, with its bundle carrying additional upstream licenses (`https://github.com/tectonic-typesetting/tectonic`) | Supported as an external detected engine. The hash-verified release binary accepted `--untrusted --version`; it remains absent from PATH and is not added as a dependency. |

The pinned official ICLR 2026 archive was downloaded into a system temporary directory and compiled successfully with local Latexmk, pdfTeX, and BibTeX. The upstream sample produced a seven-page PDF and retained an `end occurred inside a group` warning, which is why RenderRun records diagnostics independently from exit status.

Compiler processes receive only a small runtime environment allowlist plus deterministic-build variables. Latexmk, pdfTeX, XeTeX, and LuaTeX are invoked with shell escape disabled; the hash-verified Tectonic 0.16.9 CLI exposed and accepted its `--untrusted` mode. Temporary staging and these process restrictions reduce exposure, but they are not an operating-system sandbox.

## Evaluated citation parsers

| Candidate | Verified release | License | Decision |
| --- | --- | --- | --- |
| `@citation-js/core` and `@citation-js/plugin-bibtex` | 0.8.2 | MIT | Not added. The module consumes structured BibTeX entry data and existing normalized Zotero items, so raw BibTeX parsing is outside this increment and no shared package change is needed. |
| `@retorquere/bibtex-parser` | 10.0.0 | ISC | Not added for the same boundary. Prefer it over a handwritten raw BibTeX parser if raw-import parsing becomes an approved capability. |

The local serializer handles already-structured entry fields only. It is not presented as a general BibTeX parser.

## Venue-year guard

The official ICLR 2027 Call for Papers and Author Guide URLs returned HTTP 404 during verification, and the official template repository head still identified its latest template commit as `iclr2026`. Rigorium therefore returns `unverified_year` for ICLR 2027 and does not infer a template from prior years.
