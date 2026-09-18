# Focus ownership

The visible message editor is the default typing destination. Explicit search,
text selection, menus, dialogs, and keyboard navigation retain their own focus.
An OS window becoming active does not itself identify a message editor.

## Conversation editors

`useComposerFocus` gives each editor an owner tied to its account and conversation
identity, including a forum topic or discussion thread. The concrete editor node is
also checked, so an old operation cannot target a replacement through a reused ref.
Disabling or unmounting an owner revokes pending requests and clears its timers.

- `request()` follows an explicit user action such as replying or inserting Emoji.
- Latest/return, pinned-message, reply-preview and attention jumps return typing
  to the current editor, retaining its selection. Silent-send toggles do the same.
  These returns use the existing owner and interaction checks; a subsequent
  search or conversation change takes precedence.
- Explicit multi-select cancellation commits the editor remount before requesting
  focus. Routine selection clearing (including asynchronous forwarding) does not
  make this request. Cancellation does not take focus from another surface.
- Emoji toggle, Escape and hover dismissals return focus only while that picker's
  controls or trigger still own it. Passive hovering and outside clicks preserve
  the user's current input destination.
- `request({ reason: "entry" })` defaults to the editor after navigation when focus
  is unclaimed or still on a chat row. It preserves native selections and the
  existing forced-colors keyboard behavior.
- Window return only restores unclaimed focus or retains the current editor.
  Search fields, buttons, reading controls, and selected text take precedence.
- `capture()` must be called **before** asynchronous work. Invoke its returned
  callback after completion; subsequent pointer, keyboard, composition, or focus
  activity invalidates it. Business callbacks that clear reply/edit state do not
  independently request focus.
- External previews can capture a return that waits for the main window to regain
  focus. Re-activation of the unchanged opener does not revoke that return;
  pointer, keyboard, composition, or focus on another element still does.
  Conversation video windows capture before any stream lookup, just like photo
  and outgoing attachment previews. In-app modals can remember their originating
  editor while allowing interactions inside the modal; return is still restricted
  to that editor.
- Replying from a native message menu waits for the main window to activate
  before focusing its conversation editor. A newer user operation revokes the
  pending return, as it does for media windows.

All editor focus requests use `preventScroll`. A cursor change is applied only
when its corresponding focus request remains valid. Requests do not run in a
hidden/unfocused document, during composition, behind an active modal, or against
an unavailable input.

The shared composer uses a Tiptap/ProseMirror text block with Telegram entities as
marks. Its DOM adapter exposes UTF-16 text offsets to existing mention insertion
and focus callers. Newlines occupy one position, including clipboard input.
Restored drafts start with a collapsed selection at the end; routine focus returns
preserve the current selection. Native and browser format menus retain the range
that opened them and return through the same focus owner.

With an empty composer, unmodified ArrowUp chooses the latest editable outgoing
message intersecting that editor's current message viewport. Virtual overscan and
offscreen history do not qualify. Permission loading is bounded to those visible
candidates; subsequent input, scrolling, navigation, or unmounting cancels the
pending intent. Replies, attachment drafts, and active edits retain their input
behavior. Composer Ctrl+Shift+M/X/U/B/Q/K shortcuts are local to this editor.
Formatting runs in ProseMirror's key handler and maps the visible DOM selection
before applying a mark; `selectionchange` may still be queued. React capture must
not consume these shortcuts against a stale selection. The editor and WebView
guard share physical letter matching, with `key` as a fallback.
Active IME composition owns its keys. Placeholder visibility follows the live
editor document and is suppressed from composition start, including empty preedit;
updating that visibility must never replace the composing document.

Composer surfaces follow the same order in ordinary chats and discussions:
connection/outbox status, reply or edit context, staged attachments, then the editor.
Editing temporarily hides staged attachments and preserves their draft; attachment
sending cannot consume the edit text. Choosers anchor above the actual editor height
and fit below the owning conversation header. Only the foreground chooser handles
selection keys; opening the emoji picker suspends text suggestions until it closes.
Constrained attachment grids scroll without shrinking cards or hiding send controls.

Mention candidates combine actual authors from the current chat's loaded history,
search results and discussion messages with TDLib's `chatMembersFilterMention`
results. Local authors remain available while the remote request is pending, empty
or fails; membership-list visibility does not decide whether a known author can
be mentioned. Forward origins, mention entities and globally cached users do not
establish chat scope. Preserve the server's mention eligibility and name matching,
including non-member commenters and names matched through aliases or transliteration.
Incoming messages update local matches without restarting the remote query. Query
completion caches and late responses remain scoped to the current chat and account.

`data-composer-scope` marks ordinary conversations and discussion panels. The
shared pointer handler processes only the nearest scope. A discussion isolates
the channel header, timeline, and post editor with `inert`; the covered channel
editor must never receive comment text or Enter.
When the scope's editor already has focus, pointer down on a non-selectable
background preserves that focus and selection, and pointer up skips restoration.
Selectable message text and interactive controls retain their native pointer
behavior. An unfocused editor still receives focus after an eligible blank click.

## Modal surfaces

`useModalFocus` owns initial focus, keyboard containment, programmatic focus
containment, and return. Only the active modal handles Tab and Escape. Its sibling
branches are made inert, including newly mounted background content. Nested
dialogs isolate siblings rather than their own ancestors. Portaled context menus
retain their keyboard interaction. Standalone settings retain their window chrome.

Isolation is released when the exit begins. A delayed unmount cannot move focus
over a newer user operation. Temporarily suspending/hiding a parent for a nested
dialog does not consume that parent's eventual return. Prefer the invoking control;
an editor-related modal can supply a return bound to its originating editor.

## Verification

`tests/e2e/focus.e2e.ts` and `tests/e2e/focus-actions.e2e.ts` cover typing destination,
delayed completion, background isolation, window return, selections, caret position,
and exit races. Existing
composer, message action, discussion, media, report, motion, and account suites
cover their integrations. Browser tests run headless with muted audio and Mock
transport. Real WebView2 activation, Alt+Tab, native previews, and OS IME still
require Windows acceptance against the packaged build.
