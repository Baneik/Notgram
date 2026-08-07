# Theme system

Notgram separates a theme identity from the native `light` or `dark` color scheme. The persisted preference is a `ThemeId`; each registry entry supplies the native color scheme used by WebView and child windows.

## Contract

- `src/theme/theme.ts` owns theme identifiers, metadata, migration helpers, and the required semantic token list.
- `src/styles/themes.css` is the source for every new theme palette. Every theme must define every token in `THEME_COLOR_TOKENS`; the original dark theme still has temporary legacy overrides scheduled for Phase 2.
- Component styles consume semantic roles such as `--color-bg-control` and `--color-border-strong`. They must not choose a light or dark palette value directly.
- Media canvases and high-contrast content may use dedicated semantic roles such as `--color-on-media` and the QR foreground/background pair.
- The legacy `.theme-dark` selector remains temporarily as a compatibility alias for native child-window messages and older component overrides.

## Adding a theme

1. Add the identifier and metadata to `THEME_IDS` and `THEME_DEFINITIONS`.
2. Add a complete `[data-theme="..."]` block to `src/styles/themes.css`.
3. Expose the identifier in the settings UI. Do not add another boolean or a component-level theme class.
4. Run `npm run theme:check`, unit tests, and the Playwright theme regression.

`scripts/verify-theme-contract.mjs` fails when a theme omits a token, a component uses an unknown token, or component CSS reintroduces a hard-coded light surface.

## Delivery plan

### Phase 1: contract and structural surfaces (implemented)

- Persist `ThemeId` and migrate the legacy `colorTheme` preference.
- Apply `data-theme`, native `color-scheme`, and child-window theme metadata from one registry.
- Move structural surfaces, controls, borders, messages, overlays, and status colors to semantic tokens.
- Cover settings, profiles, management forms, invite links, privacy/report controls, shared media, dialogs, composer UI, and search.
- Enforce token completeness and reject new hard-coded light surfaces in the project check.

### Phase 2: retire legacy overrides

- Move the remaining original `.theme-dark` component overrides into semantic roles or theme-local component aliases.
- Remove `.theme-dark` after native child-window protocols carry `ThemeId` directly.
- Expand the static rule from structural light surfaces to all theme-dependent color declarations. Media pixels and protocol-required QR contrast remain explicit exceptions.

### Phase 3: theme qualification

- Add a theme gallery route that renders every reusable surface and interaction state.
- Capture light, dark, forced-colors, and every added theme at desktop and minimum-window viewports.
- Add contrast checks for text, focus, selection, status, and disabled states before a theme can be registered.
