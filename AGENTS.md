# Orca UI integration baseline

- This checkout is the integration target. Keep all existing search, Markdown editing, revision/conflict protection, hierarchy, export, tables and synchronization features.
- The approved Notion-inspired UI is implemented in frontend/Frontend_UI/src/features/stella/WorkspaceScreen.js, theme.js, GraphCanvas.web.js and src/navigation/TabBar.js. Keep the expanding top tabs, restrained dark surfaces, collapsible home sections, compact cards and bottom editor tools. Do not restore the old bottom navigation or old mint/card styling.
- src/integration/documentWorkspace.mjs reads the existing parentMemoId and Markdown links. Diagram positions and manual links are device preferences. Do not add a competing parent hierarchy or claim diagram preferences synchronize to the cloud.
- Before finishing UI work: run node --test backend/local/tests/*.test.mjs tests/integration/*.test.mjs and export web/Android from frontend/Frontend_UI with npx expo export --platform web --platform android. Check 320px and 390px layouts and real save/navigation paths. A bundle is not real-device or hosted collaboration acceptance.
- Preserve user changes. Use minimal correct changes, existing components and dependencies. Honor accessible labels, workspace permissions and data preservation. Do not publish, deploy, push or merge without a user request. Do not add an in-app reduced-motion integration: the user removed it on 2026-11-24 (see 디자인/Stella_모바일_UI_직접_지시_정리.md).

## Mandatory UI authority (2026-11-20)

The user explicitly rejected a hybrid UI. All primary routes must use the approved Stella UI: Home, Documents, Relations, Review and Favorites use features/stella/WorkspaceScreen; MemoEdit uses features/stella/DocumentEditor with BlockEditor and EditorTools. Do not route the main document editor or list to the old memo screens. Keep those screens only under explicitly named advanced tools. Restore the actual Stella Desktop block features, including between-block insertion, per-block controls, conversion, split, movement, deletion, tables and confirmation of table changes. A style-only pass is not feature parity. Retain current data and server contracts behind these screens.

## Document hierarchy acceptance

Home and Documents must expose the expandable hierarchy. The editor must show ancestor navigation, direct children, child creation, child deletion with confirmation, and delete undo. Soft deletion preserves document blocks, original and versions. Promote direct children one level within the store transaction, matching the documented desktop behavior. Never hide these operations solely in a tools menu. Verify creation, cancellation, deletion, promotion, restoration, and persistence before reporting hierarchy complete.

## Required Notion reference for every UI addition

Before adding or changing any interface or interaction, inspect the corresponding real Notion mobile flow. Use actual product screens and demonstration video frames when available, plus official behavior documentation. Reading documentation alone is not visual verification; never claim a video was analyzed without inspecting its frames. Reuse the approved Stella interpretation of Notion typography, spacing, page rows, breadcrumbs, toolbars, sheets and motion. Do not invent decorative cards, permanently prominent destructive actions, oversized headings or a new button arrangement. Preserve the previously agreed functional requirements and data safety behavior; reference styling does not authorize changing deletion or synchronization contracts. Compare the implemented screen with its reference at mobile widths and exercise create, edit, delete, cancel and restore before reporting completion. No new dependency or additional approval gate is implied by this instruction.

References: https://www.notion.com/help/create-a-subpage ; https://www.notion.com/en-us/help/workspaces-on-mobile ; https://www.notion.com/help/intro-to-workspaces
