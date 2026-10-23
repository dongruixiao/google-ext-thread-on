# Architecture

## Product boundary

TopClip is a read-only layer over an existing page. It does not rewrite article
markup, reserve layout space, or replace native navigation. When page structure
cannot be trusted, the correct behavior is to render nothing.

## Runtime flow

```text
content script
  -> extract article scope and heading tree
  -> apply conservative reading-page gate
  -> mount isolated Shadow DOM UI
  -> derive active heading from geometry
  -> update capsule, outline, and article progress
```

The DOM is observed only for structural invalidation. Scroll processing is
coalesced through `requestAnimationFrame`.

## Modules

| Module | Responsibility |
| --- | --- |
| `content/index.ts` | Lifecycle, settings application, site chrome detection, visibility policy, messaging |
| `content/extractor.ts` | Scope selection, heading extraction, structural metrics, article gate |
| `content/conversation.ts` | Generic chat and agent-workspace detection |
| `content/tracker.ts` | Geometric heading transitions and article progress |
| `content/ui.ts` | Shadow DOM rendering, outline interaction, drag behavior |
| `content/chrome-detect.ts` | Top-edge classification independent of domain names |
| `content/top-chrome.ts` | DOM probes for site chrome, overlays, and layer conflicts |
| `content/floating-position.ts` | Pure capsule coordinate and viewport-clamping math |
| `content/page-toc.ts` | Native table-of-contents detection and compact-mode decision |
| `content/failure-guard.ts` | Repeated-failure circuit breaker |
| `popup/` | The complete settings surface and current-page status |
| `shared/settings.ts` | Persisted schema, validation, migration, and storage adapters |
| `shared/protocol.ts` | Popup/content message names and status shape |
| `shared/i18n.ts` | Chrome locale lookup with deterministic fallback catalogs |

## Core invariants

1. Heading transitions depend on current geometry, not scroll history.
2. A heading becomes active only after crossing the capsule docking line.
3. The article-level `h1` is not treated as a reading section.
4. Native contents and browser find-in-page take precedence over the extension.
5. Capsule coordinates are clamped to the viewport after settings migration.
6. A failed extraction or geometry check produces no extension UI.
7. Repeated runtime failures leave no listeners, timers, markers, or host nodes.

## Localization

Chrome catalogs live in `_locales/en` and `_locales/zh_CN`. User-facing popup and
accessibility strings use message keys; source comments and diagnostics remain
English. The English catalog is the default for unsupported browser languages.

## Verification

- Unit tests cover extraction, conversation detection, geometry gates, tracking,
  settings migration, failure handling, and localization.
- The packaged-extension E2E suite covers the complete popup/content interaction
  flow when run with Chromium or Chrome for Testing.
- The field-check script exercises real public websites without domain-specific
  allowlists.
