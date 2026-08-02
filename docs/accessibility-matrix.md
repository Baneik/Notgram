# Accessibility acceptance matrix

This matrix is the release gate for Notgram's Windows accessibility baseline.
Browser checks use the deterministic Mock transport and never connect to
Telegram. The signed Windows candidate still requires the native checks below
because Chromium cannot prove WebView2, Windows contrast themes, or Narrator
behavior.

## Automated gate

Run the complete gate with:

```powershell
npm run test:e2e
```

The release workflow runs the same command after `npm run check`.

| Scenario | Automated evidence | Pass condition |
| --- | --- | --- |
| 125%, 150%, and 200% DPI | `minimum window remains operable at Windows 125, 150, and 200 percent scaling` | The `680 x 560` logical minimum window is rendered at DPR 1.25, 1.5, and 2; the conversation, narrow-screen back control, and composer remain available with no horizontal overflow. |
| High contrast | `forced colors preserve selection, focus, and custom switches` | Chromium reports `forced-colors: active`; focus, current selections, outgoing messages, custom switches, and dialog boundaries remain visually distinct. |
| Long text | `long unbroken content remains contained on a narrow viewport` | A long unbroken token in the conversation title, message, connection status, and settings category neither clips an operation nor creates viewport overflow at `360 x 720`. |
| Narrow screen | `mobile chat switching has no horizontal overflow` and the long-text check | Chat selection and return navigation remain operable at `390 x 844` and `360 x 720`. |
| Keyboard | `keyboard navigation closes modals and completes message workflows` | Keyboard-only use opens and closes dialogs and menus, traps and restores focus, and completes edit, reply, forward, reaction, search, and narrow-screen return workflows. |
| Screen reader semantics | `primary workflows expose named controls in the accessibility tree` | The accessibility tree exposes named navigation, chat-list, conversation, message-log, composer, dialog, and interactive controls; exactly one chat is announced as current. |

Tauri window sizes are logical pixels. The DPI check therefore keeps the
configured `680 x 560` minimum viewport and changes `devicePixelRatio`; dividing
the viewport by the Windows scale would test a smaller window than the native
configuration permits.

## Native Windows gate

Run this checklist on the signed candidate in both installer and portable form.
Use Mock or offline state for layout checks. If an authorized Telegram profile
is needed, follow `docs/native-smoke.md` and never include account data in the
evidence.

| Scenario | Native procedure | Required result |
| --- | --- | --- |
| DPI | Set Windows display scale to 125%, 150%, and 200%. Restart Notgram at each scale and test both the default and minimum window sizes. | No clipped text, overlapping controls, lost focus ring, unexpected horizontal scrollbar, or inaccessible composer action. |
| Contrast theme | Enable a Windows contrast theme, restart Notgram, and visit the chat list, conversation, menus, settings, update, and diagnostics views. | Current items, incoming/outgoing messages, disabled controls, switches, focus, and dialog boundaries remain distinguishable without relying on the original palette. |
| Long text | Use a long chat title, attachment name, message, and update note with the window at minimum size. | Text wraps or truncates deliberately; controls keep stable dimensions and remain operable. |
| Keyboard | Disconnect the pointer and repeat search, chat selection, reply, edit, forward, reaction, settings, and dialog close flows. | Focus order is predictable, focus never escapes a modal, `Escape` closes transient UI, and focus returns to the opener. |
| Narrator | Start Narrator, navigate the main landmarks and current chat, then operate the composer, menus, settings, update, and diagnostics controls. | Names, roles, checked/current/disabled states, connection status, errors, and progress are announced without reading hidden background UI. |

Record only the candidate version, commit, Windows build, scale/theme, and
pass/fail result. Do not record chat titles, message text, account identifiers,
phone numbers, file paths, or screenshots containing user data.
