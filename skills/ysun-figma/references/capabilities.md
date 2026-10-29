# Official workflow comparison and capability boundaries

Compared with the official Figma Codex plugin skills v17.0.0 on 2026-10-29. This is a workflow map, not a claim that local and hosted executors are identical. The pinned public typings expose a broader native surface than the official remote sandbox in some areas; remote convenience methods and cloud services add capabilities in other areas.

## Audit findings

The original local package had nine skill entrypoints, three short topic references and a full native declaration file. The official package has sixteen workflow entrypoints with detailed supporting recipes. Its advantage is task discovery and execution guidance, as well as hosted services; adding empty entrypoints would not close that gap.

Core layout, vectors, components, variables, motion and editor-specific operations were already reachable through `figma_run`; missing guidance made those capabilities hard to find and use correctly. A shared feature index now connects task discovery, native symbols, recipes and maintenance checks. The official native types and update notes are pinned with provenance and checked for drift. Neither type counts nor successful reference downloads establish runtime feature coverage.

| Official workflow | Local execution and guidance | Boundary |
| --- | --- | --- |
| `figma-use` | `figma_api`, `figma_run`, native execution and topic recipes | Different lifecycle, helpers and page behavior |
| `figma-generate-design` | create-design skill; editable native hierarchy, assets and existing components | No bundled hosted HTML capture/import service |
| `figma-generate-library` | design-system skill; variables, aliases, scopes, styles, properties and variants | No arbitrary account-wide component-library search/publication |
| `figma-use-motion` | motion skill; manual tracks, presets, local custom styles, native text motion when available | Actual editor/account gating applies |
| `figma-implement-motion` | motion + design-to-code skills; tracks joined to exact node IDs | No hosted generated-code service; implement in the real target stack |
| `figma-use-figjam` | FigJam skill; native semantic nodes, endpoints, text and tables | Editor-specific constructors and setters |
| `figma-generate-diagram` | FigJam skill; construct the actual graph with editable nodes/edges | No claim that arbitrary Mermaid is automatically parsed |
| `figma-use-slides` | Slides skill; native grid, rows, slides, assets and transitions | Remote notes/theme helpers are not declared native APIs |
| `figma-design-to-code` | native context/CSS, original assets, component/variable identity and implementation skill | A context read is not generated or validated production code |
| `figma-swiftui` | handoff reference; both directions, source semantics and named symbols | Remote SF-symbol lookup utility is not a native method |
| `figma-code-connect` | code-connect skill; local mapping files in the repository's actual format | Hosted suggestions, plan eligibility and publication need their own service |
| `figma-create-new-file` | files skill covers existing files, pages, connection and exact identity | Native Plugin API does not create a cloud file |
| `figma-code-workflows` | editable recreation from actual source through create-design | Hosted Code/Make, Code Layers and HTML import are not bundled |
| `figma-spec` | Recognize a native spec request; probe advertised support rather than editing unrelated canvas text | `figma.spec`/SPEC_BLOCK are not in the pinned public API; hosted service is not implemented locally |
| `figma-shaders` | discover/import/apply an available native shader and advertised controls | Cloud shader scaffolding, WGSL compiler and version library are separate |
| `figma-generative-plugins` | Ordinary local Plugin API scripts are executable | Account-library generative-plugin author/version lifecycle is a separate service |

## Existing file: normal zero-GUI path

Identify → inspect → API/topic discovery → native edit → native property readback/export → targeted correction. Page selection and viewport changes use `figma_navigate`; static inspection uses native exports. Account Community research also has a read-only MCP route. Figma Desktop and its plugin remain the native execution environment; no mouse/keyboard automation is required for this path.

## Explicit remaining boundaries

- First login, plugin import/start or a genuinely required native reload can need an actual Figma entry point. Reuse saved authorization; do not restart a working editor for ordinary design work.
- Cloud-file creation, explicit offline `.fig` local save and cloud-save completion do not have a public native route in this package. For important edits, prefer the existing native version-checkpoint workflow in the files skill; it needs no file export or extra backup service. JSON/SVG/images remain handoff artifacts, not substitutes labelled `.fig`.
- A local edit receipt confirms native execution, not cloud synchronization. `saveVersionHistoryAsync` has its own API contract and is not a general flush/save primitive.
- Real focus, dragging, presentation input and other interactive behavior need an actual interactive test when requested. Static native exports and persisted reactions establish different evidence.

When a request reaches a boundary, name the missing capability, preserve current work and choose an authorized alternative. Do not silently call a different service, copy credentials, bypass plan gates, invent an undeclared property or fake a successful cloud workflow.
