---
name: ysun-figma-code-connect
description: Create or update local Figma Code Connect mappings and component-to-code handoff with ysun figma. Use for .figma.ts/.figma.js/.figma.tsx mappings, Swift FigmaConnect and repository code/component links; distinguish local authoring from hosted publication.
---

# Component-to-code mappings

Load [handoff](../ysun-figma/references/handoff.md). Inspect the repository's actual Code Connect configuration and existing mappings before selecting a format. Read the real source component and resolve its native master/property owner through ysun figma; use [design-system](../ysun-figma-design-system/SKILL.md) for component/variable reads.

Respect existing parser-based SDK mappings and parserless templates as different artifacts. The installed official workflow uses `.figma.ts`; its older API reference also shows `.figma.js`. Follow the actual repository include patterns and installed template types rather than renaming existing files by memory. The parserless `figma.selectedInstance`/`figma.code` API belongs to the template runtime, not `figma_run`. Do not overwrite an SDK mapping merely because the official remote skill uses parserless templates.

Map actual Figma properties to actual code props. Keep configurable nested instances and slots dynamic; distinguish SLOT from INSTANCE_SWAP. Preserve source import paths and supported variant values. Resolve missing/ambiguous component identity before inventing a mapping.

Validate with the repository's actual SDK/types and appropriate source checks. Return the mapping files and exact component URLs/IDs. Local file creation or a native Dev Resource link is not hosted Code Connect publication. Publish only when that action is requested and its service, account permission and current plan eligibility are established; do not substitute a custom JSON registry and call it Code Connect.
