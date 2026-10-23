# Focus ownership

The visible message editor is the default typing destination. Explicit search,
text selection, menus, dialogs, and keyboard navigation retain their own focus.
An OS window becoming active does not itself identify a message editor.

## Tab behavior

Every app window cancels the native Tab default in the shared WebView key guard,
including Shift+Tab and modified Tab keys delivered to the page. The event still
reaches application handlers: plain Tab explicitly accepts the active mention or
bot-command suggestion. With no available suggestion, it leaves text, selection,
and focus unchanged. Completion must not depend on `defaultPrevented` being false;
the guard has already canceled browser traversal. Existing IME checks still prevent
completion during composition.

Tab does not traverse settings, forms, dialogs, menus, or media controls. Dialogs
do not cycle focus with Tab, and menus do not dismiss on Tab. Pointer interactions,
explicit focus requests, menu arrow navigation, and Escape retain their behavior.

## Configurable shortcuts

`shortcuts/shortcuts.ts` declares action IDs, labels, defaults and key normalization.
Preferences persist bindings and synchronize them with the standalone settings
window. Navigation dispatch lives in `useAppShortcuts`; it only consumes a matching
combination, and preserves composition, active dialogs and menus. A usable cached
workspace accepts navigation while the transport reconnects. Tab remains reserved
for explicit completion and cannot be assigned to a navigation action. The local
"Toggle media send mode" action defaults to bare Tab. It operates only within an
active composer's staged attachments when the whole batch supports media. It yields
to IME, text completion, foreground choosers, menus and modals, ignores key repeat,
and leaves modified Tab and the existing WebView Tab behavior intact. Entering file
mode clears spoiler and mute-video options, matching the radio controls.

The recorder consumes keys before editor/search commands and the WebView guard.
Escape, blur, switching controls and unmount invalidate pending checks. Saving
checks application duplicates and reserved keys, then probes Windows RegisterHotKey
on a dedicated thread and immediately unregisters it. These are foreground app
shortcuts; the probe never installs a persistent global binding. The probe detects
registered global hotkeys at that instant, not arbitrary keyboard hooks or later
registrations. Unsupported environments and native errors must not report success.
Bare Tab is checked locally and never probed or registered as a global hotkey.

Folder buttons and shortcuts change only the sidebar folder and close search;
the open conversation, draft, reading position and forum topic remain in place,
including for empty folders and late list data. No per-folder chat selection is
remembered. After a folder change, the first previous/next chat shortcut selects
the current first row, even when the retained chat belongs to that folder. Later
shortcuts move from the selected chat; an explicit sidebar chat click also resumes
navigation from that row. Selecting the same folder does not reset navigation.
Actual chat changes share the sidebar conversation entry path. The folder order
matches the rail; chat order uses the sidebar sorter, with no wrap at either
boundary. The shortcut cursor is transient and resets across account switches.

Previous/next topic shortcuts default to Ctrl+Left/Right and run only in forum
groups. They cycle through the visible topic strip in its local account/chat order,
including All and excluding hidden or missing topics. Both ends wrap. Topic changes
share the strip's conversation entry path, preserving per-topic drafts, reading
positions and focus ownership. Outside forums these shortcuts retain native editing.
Existing customized actions take precedence over newly added topic defaults.

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
  is unclaimed or still on a chat row. Pointer-selected forum tabs in that editor's
  scope also hand focus to the new topic editor, including entry from All. Keyboard
  topic navigation and forced-colors tab focus remain on the tab. Clicking the
  current topic or reordering tabs preserves an already focused editor's caret.
  Entry requests still preserve native selections and yield to newer interactions.
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

Hard breaks declare their plain-text serialization as a newline. Keyboard copy,
cut and text drag serialization must preserve all selected whitespace, including
leading, consecutive and trailing newlines, just like the clipboard menu actions.
Plain-text paste normalizes CRLF/CR to LF and replaces only the selected range,
retaining the surrounding marks. Each paste is an independent undo step, isolated
from adjacent typing and other pastes; an empty clipboard changes nothing.

The main Windows WebView delivers HTML drag/drop events; Tauri's native file-drop
interceptor stays disabled for this window. External text is inserted as plain text
at the drop caret, retaining newlines and its own undo boundary. Editor-local moves
retain ProseMirror's formatting and move/copy behavior. Files are handled once by
the attachment surface and never insert their URL fallback. Displayed application
images can enter staging through existing account-authorized asset, Blob or raster
data URLs; external image URLs require a saved file and do not widen network or
filesystem access. Message media and staged attachments carry their account and
source draft scope through a drag, even when switching unmounts their source.
Releasing them in their original scope is rejected, including editor URL/HTML
fallbacks. Protected message content cannot begin a native drag.

Clipboard menu actions wait for the main document to regain focus after the native
menu closes. WebView2 clipboard reads are permitted only for the main application's
exact origin; other permission kinds retain the existing policy. Paste reads image
items before text and reuses attachment staging, including its edit-mode restriction.
An empty clipboard leaves the selection intact. New input, a new focus destination,
another menu action or a replacement editor invalidates a pending clipboard action.

With an empty composer, the configurable "Edit the previous message" shortcut
(Ctrl+R by default) chooses the latest editable outgoing
message intersecting that editor's current message viewport. Virtual overscan and
offscreen history do not qualify. Permission loading is bounded to those visible
candidates; subsequent input, scrolling, navigation, or unmounting cancels the
pending intent. Replies and attachment drafts retain their input behavior;
ArrowUp keeps its ordinary cursor or suggestion navigation. During editing, the
same shortcut or Escape cancels and restores the previous draft. Enter submits
the edit (Shift+Enter retains newline insertion), comparing the current text and
formatting entities with the original only at submission. Unchanged content,
including edits reverted to the original, exits without an edit/send request.
Composer M/X/U/B/Q/K/F shortcuts are local to this editor and share a configurable
message formatting modifier (Ctrl+Shift by default). Record only modifier keys and
release to save; clearing disables the shortcuts while menu actions remain usable.
Before saving or resetting, expand every letter and check application bindings and
native global hotkey availability; any conflict or unavailable check preserves the
previous setting. Other configurable actions also reserve the active format bindings.
Both format menus show the same inline shortcut letters in square brackets and
expose the current full combination to accessibility tools. File converts the
saved selection to a UTF-8 text attachment through normal staging, then removes
only that range as an isolated undo step. A full tray retains the text; message
editing and pending attachment restoration disable conversion. IME preedit never
triggers it.
Formatting runs in ProseMirror's key handler and maps the visible DOM selection
before applying a mark; `selectionchange` may still be queued. React capture must
not consume these shortcuts against a stale selection. The editor and WebView
guard share physical letter matching, with `key` as a fallback.
Active IME composition owns its keys. Placeholder visibility follows the live
editor document and is suppressed from composition start, including empty preedit;
updating that visibility must never replace the composing document.

Composer surfaces follow the same order in ordinary chats and discussions:
outbox status, reply or edit context, staged attachments, then the editor.
Connection feedback floats above that stack, without consuming pointer input or
changing timeline/editor geometry as the network recovers. Text can wrap within
the conversation width; foreground choosers remain above this passive feedback.
Editing temporarily hides staged attachments and preserves their draft; attachment
sending cannot consume the edit text. Choosers anchor above the actual editor height
and fit below the owning conversation header. Only the foreground chooser handles
selection keys; opening the emoji picker suspends text suggestions until it closes.
Constrained attachment grids scroll without shrinking cards or hiding send controls.
Staging contains only previews, send options and exceptional limit feedback; sending
uses the composer button or its existing Enter shortcut. Escape within this surface
discards all staged attachments, closes their preview session, revokes preview URLs,
clears the durable attachment draft and restores composer focus. Caption text and
reply context remain available. Sending/restoration and active modals retain key ownership.

File drags use the entire nearest `data-composer-scope`, including its timeline,
header and editor. An empty tray stays closed until release; hovering only outlines
the composer and preserves the timeline/editor geometry, text and selection.
An existing tray adds card-sized placeholders at the append positions. Preview
and dropped cards use the same constrained staging/editor layout.
Protected drag data supplies only file counts; file reads and durable attachment
writes begin on drop. Existing attachment limits also bound the placeholder count,
and a constrained grid scrolls to reveal the pending slots. Drop replaces the slots
in place without replaying a staging entrance transform.
Dropping onto the staging tray itself retains its target until the owning scope
has checked availability and captured the files; window capture only clears
previews belonging to other scopes. Leaving the scope, cancelling the drag,
losing window focus or changing account/topic removes only
the preview. Escape during a file drag cancels that preview and preserves staged
files; outside a drag, staging retains its usual discard shortcut. Nested discussion
scopes, inert backgrounds, editing, sending/restoration, menus and active dialogs
cannot redirect file drops to another composer. Text drags retain editor ownership.

Hovering an internal attachment or external file drag over a visible, active
sidebar chat row for 500 ms selects that chat through ordinary navigation. Brief
passes, leaving the row, release, Escape, drag end, window blur, account/folder
changes and modal ownership cancel pending selection. Releasing on the sidebar
does not stage or send files; the user continues into the destination conversation
and releases there. File reads, downloads and durable staging start only on release.
Late reads cannot populate a replacement account/topic/editor. Native drag data
is inspected only inside its event; delayed switching checks the retained drag
identity instead of accessing the browser's expired event data store.

Draft synchronization compares text entities by their content, independent of object
field order and entity order from the editor or native mapper. Matching server echoes
acknowledge local drafts without discarding staged attachments. While newer local text
is pending, rejected stale echoes (including empty drafts) cannot clear attachments;
accepted remote draft replacements retain the existing attachment cleanup behavior.

Mention candidates combine actual authors from the current chat's loaded history,
search results and discussion messages with TDLib's `chatMembersFilterMention`
results. Local authors remain available while the remote request is pending, empty
or fails; membership-list visibility does not decide whether a known author can
be mentioned. Forward origins, mention entities and globally cached users do not
establish chat scope. Preserve the server's mention eligibility and name matching,
including non-member commenters and names matched through aliases or transliteration.
Incoming messages update local matches without restarting the remote query. Query
completion caches and late responses remain scoped to the current chat and account.

Before native text sends, draft writes, edits or attachment captions, resolve mention
IDs through TDLib `getUser` and its `have_access` flag. Frontend cached authors are
display hints, not proof of native access. If needed, restore at most three known
authored message references with `getMessage`, then try the user's known public
username while verifying that it still resolves to the same user ID. Recovery does
not publish history, mark messages read, change focus or remove mention entities.
Concurrent lookups share pending work within the account; completed lookups are
not treated as permanent access. Account changes cancel pending sends, and newer
drafts or clears supersede delayed draft preparation, independently per topic.

`data-composer-scope` marks ordinary conversations and discussion panels. The
shared pointer handler processes only the nearest scope. A discussion isolates
the channel header, timeline, and post editor with `inert`; the covered channel
editor must never receive comment text or Enter.
When the scope's editor already has focus, pointer down on a non-selectable
background preserves that focus and selection, and pointer up skips restoration.
Selectable message text and interactive controls retain their native pointer
behavior. An unfocused editor still receives focus after an eligible blank click.
Horizontal bubble padding beside a rendered text line belongs to that message's
native selection surface. A drag may start before its first character, including
in captions and discussion comments; the origin remains selectable until the
range is cleared. Headers, controls, loading/concealed content and message
multi-selection do not claim this padding. Selection remains confined to the
originating text, and clicks in the surrounding timeline retain blank-click focus
behavior.

## Modal surfaces

`useModalFocus` owns initial focus, programmatic focus containment, and return.
Only the active modal handles Escape. Its sibling branches are made inert,
including newly mounted background content. Nested
dialogs isolate siblings rather than their own ancestors. Portaled context menus
retain their keyboard interaction. Standalone settings retain their window chrome.

Workspace Escape runs after local controls: member/emoji pickers, context menus,
dialogs, attachment staging, reply/edit context and message selection consume their
own dismissal. Cancelling a reply uses the same draft cleanup as its close button,
retaining text and entities. Unclaimed Escape closes visible sidebar search,
including after selecting a member or opening a result; otherwise it returns from
an open channel discussion. Hidden mobile surfaces do not claim the key. Modified,
repeated and composing Escape do not dismiss workspace panels. The editor forwards
unclaimed Escape instead of allowing ProseMirror's built-in capture to suppress it.

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
