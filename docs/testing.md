# Testing

Run `npm test` for the frontend unit suite. Tests under `src/` are the only
Vitest inputs; keep temporary baseline checkouts outside the repository.
`src/telegram/mockTransport.contract.test.ts` groups checks of the deterministic
browser fixture. Native transport behavior is covered separately by the Tauri
transport and Rust tests.

## Browser suites

All browser commands start a fresh Mock server, run headless with muted audio,
and stop the server when finished. They use one Chromium worker so timing and
frame-by-frame geometry checks do not compete with other browser tests.

| Command | Selection |
| --- | --- |
| `npm run test:e2e:smoke` | Existing core user flows tagged `@smoke` |
| `npm run test:e2e:regression` | All functional tests, excluding `@visual` and `@performance` |
| `npm run test:e2e:visual` | Screenshot comparisons tagged `@visual` |
| `npm run test:e2e:performance` | Timing and geometry-read budgets tagged `@performance` |
| `npm run test:e2e` | Every browser test, including visual and performance checks |

Smoke is a subset of functional regression. Functional, visual, and performance
suites together cover the complete suite. Use smoke for quick feedback, run
the affected feature files during development, and run the complete suite for
release-candidate validation. `npm run check` includes E2E type checking but
does not run the browser suite.

Tests are grouped by feature under `tests/e2e/`. Examples:

```powershell
npm run test:e2e -- media-albums.e2e.ts
npm run test:e2e -- conversation-navigation.e2e.ts --grep "reply"
npm run test:e2e:smoke -- --list
```

Tag existing core flows for smoke instead of copying them into a second suite.
Keep geometry, asynchronous ownership, and failure-recovery assertions in
functional regression even when they take longer to observe. Share helpers
when their behavior is the same; preserve intentional differences in readiness
and frame sampling. Negative assertions should follow a positive readiness
check so a blank page cannot satisfy them. Wait for initial history to settle
before injecting message fixtures or sending global shortcuts; trace recording
must not be used as an implicit wait for startup.

Editor and modal focus ownership follows [the focus contract](focus-management.md).
Its dedicated regression cases live in `focus.e2e.ts`; integration assertions also
cover composer actions, nested dialogs, and media preview returns.

## Failure evidence and diagnostics

Local runs keep screenshots on failure and do not record traces by default.
CI records traces on the first retry. Performance tests disable tracing and
retries in their own file so recorded timings remain comparable.

Opt into traces and end-of-test screenshots when investigating a functional
or visual failure:

```powershell
npm run test:e2e -- -Diagnostics media-albums.e2e.ts
npm run test:e2e:smoke -- -Diagnostics
```

The default output directory is ignored `test-results/`; `--output` overrides
it. Diagnostic traces include intermediate DOM snapshots, so tests do not need
unconditional screenshot calls. Keep ad hoc evidence out of `artifacts/` and
other hard-coded locations inside test bodies. Server logs are in `logs/`.

## Visual baselines

`visual.e2e.ts` checks full and reduced motion independently at each supported
viewport. Both preferences share the same settled-layout image in
`tests/e2e/snapshots/`; motion behavior is also covered by accessibility and
functional tests. Keep screenshot thresholds and behavioral assertions intact
when reorganizing tests.

For an intentional UI change, inspect the expected, actual, and diff images,
then update only the affected baselines. Shared images should be generated
from the full-motion cases and then verified with both preferences:

```powershell
npm run test:e2e:visual -- --grep "full motion" --update-snapshots
npm run test:e2e:visual
```

Do not refresh snapshots merely to make an unrelated test refactor pass.
Mock browser results do not replace the native acceptance described in
[`native-smoke.md`](native-smoke.md).
