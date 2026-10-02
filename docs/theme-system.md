# Theme system

Notgram separates a theme identity from the native `light` or `dark` color scheme. The persisted preference is a `ThemeId`; each registry entry supplies the native color scheme used by WebView and child windows.

## Contract

- `src/theme/theme.ts` owns theme identifiers, metadata, migration helpers, and the required semantic token list.
- `src/styles/themes.css` is the only source for theme palettes. Every theme must define every token in `THEME_COLOR_TOKENS`.
- Component styles consume semantic roles such as `--color-bg-control` and `--color-border-strong`. They must not choose a light or dark palette value directly.
- Media canvases and high-contrast content use dedicated roles such as `--color-bg-media`, `--color-on-media`, and the QR foreground/background pair.
- Rendering is selected only by `data-theme="<ThemeId>"`. Theme-specific classes and component-level palette overrides are not supported.

## Adding a theme

1. Add the identifier and metadata to `THEME_IDS` and `THEME_DEFINITIONS`.
2. Add a complete `[data-theme="..."]` block to `src/styles/themes.css`.
3. Expose the identifier in the settings UI. Do not add another boolean or a component-level theme class.
4. Run `npm run theme:check`, unit tests, and the Playwright theme regression.

`scripts/verify-theme-contract.mjs` fails when a theme omits a token, a component uses an unknown token, component CSS contains a raw color literal, or the retired `.theme-dark` path is reintroduced.

## Emoji typography

Ordinary Unicode emoji use the bundled Google Noto Color Emoji font in every window, including the editor, messages, picker, reactions, previews, and notifications. It is loaded before the shared window mount so cached message measurements use the final font. Mixed text keeps the existing text-font stack before Noto; emoji-only overrides use `--emoji-font-family`. Emoji remain Unicode text for selection, copying, editing, searching, and sending. Existing single-emoji enlargement and text-size preferences still apply.

The complete COLRv1 font and its SIL OFL 1.1 license are bundled locally by Vite; rendering needs no external font service or expanded WebView permissions. Source revision and conversion details live in `src/assets/fonts/noto-color-emoji/README.md`.

## Delivery plan

### Phase 1: contract and structural surfaces (implemented)

- Persist `ThemeId` and migrate the legacy `colorTheme` preference.
- Apply `data-theme`, native `color-scheme`, and child-window theme metadata from one registry.
- Move structural surfaces, controls, borders, messages, overlays, and status colors to semantic tokens.
- Cover settings, profiles, management forms, invite links, privacy/report controls, shared media, dialogs, composer UI, and search.
- Enforce token completeness in the project check.

### Phase 2: retire legacy overrides (implemented)

- Move the remaining original component overrides into semantic roles.
- Remove `.theme-dark` from document state, child-window cleanup, and stylesheets.
- Reject all raw component color declarations; media and QR contrast are represented by dedicated semantic tokens.

### Phase 3: theme qualification

- Add a theme gallery route that renders every reusable surface and interaction state.
- Capture light, dark, forced-colors, and every added theme at desktop and minimum-window viewports.
- Add contrast checks for text, focus, selection, status, and disabled states before a theme can be registered.
