# Shared media viewer and video ownership

## Ownership

Conversation photo preparation uses the message scroller as its visibility root.
Virtual mounting, automatic downloads, and display preview generation share the
same bounded region (1600 CSS pixels before and 1000 after the viewport). A
window-root margin cannot extend beyond the nested scroller's clipping edge.
Prepared photo pixels additionally distinguish the actual viewport from overscan:
visible leases take priority, while overscan alone may occupy only one of the two
preparation slots. Visibility changes update the shared lease without restarting
its load; releasing a virtual row still cancels unused work. `ui_photo_preview`
phase 1 records queue, service and total preparation duration separately.
Downloads keep their mounted owner through progress updates; completion,
policy changes, or virtual unmount release that owner. Preserve download queue
limits and the bounded preview caches instead of warming an entire history.
Small conversation thumbnails use priority 19 and can use the queue's remaining
capacity while three full-file prefetches are active. They remain automatic
requests: virtual unmount can reclaim them, explicit downloads have higher
priority, and the total limit stays at twelve. A video's thumbnail completes
before its full-file automatic download is enqueued.
Photo/sticker preservation from loaded history and persisted deletion archives
uses background priority 16 and shares the three full-file prefetch slots. These
requests must not occupy all twelve slots ahead of the active conversation's posters. Live
message preservation retains its existing urgent priority so a new remote
deletion can still keep the media that is being received.

The sticker picker reuses available local static stickers for pack covers instead
of requesting an uncached thumbnail. When the frontend lacks a path, query
TDLib's local file state before entering the download queue; a completed file
must remain available even while all twelve network slots are occupied. Keep
an available thumbnail painted until the full image or animated frame is ready.
Preparing or decoding a preview must never be a prerequisite for sending its
Telegram file ID. Stable remote identities enter the existing durable outbox:
paint a sending sticker immediately and close the picker after local acceptance.
Persist the local queue before submitting to TDLib, using the small unsent-state
write rather than rebuilding history. Failed or interrupted sends stay visible
for review/retry; an ambiguous result must never replay automatically. Runtime-only
numeric files retain direct sending because their identity cannot survive restart.
Those pending sends only disable the matching button. Guard duplicate clicks
synchronously and ignore acknowledgements after the account/conversation changes.

Picker catalogs, installed pack contents and small raster previews are part of
the account-scoped encrypted UI snapshot. Restore them before connecting; keep
them visible and sendable during catalog refresh, reconnection, or a stalled
pack read. Persist TDLib remote file IDs and unique IDs: restored sends use
`inputFileRemote`, and media recovery resolves the current numeric ID with
`getRemoteFile`. Original files and the shared Blob/decoded/player caches are
replaceable; their eviction must not erase a saved picker preview.

Main-window authorization and reconnection prepare the first two installed packs
while visible. Settings-only and hidden windows do not start this work. Pack reads, preview
loads and raster preparation are bounded separately to two workers each; local
pixels can prepare while both network loads wait. Thumbnails and static stickers
use the existing small-preview priority 19, independent of the three full-file
prefetch slots. Full animation fallbacks retain priority 16 and may occupy only
one preview load, leaving room for small assets. Failed preparation retries with
exponential backoff capped at one minute; reset cancels retries and queued frames.
Pixel publications are coalesced over 16ms. Sticker metadata becomes usable before
the saved-GIF request finishes, preserving previous GIFs during that refresh.
Animated stickers prefer their thumbnail; otherwise capture a nonempty frame
without autoplay or audio. Previews are 96px, at most 32 KiB of serialized data
each and 8 MiB total in foreground memory (2 MiB in the background). Keep all
installed pack summaries without their sticker arrays; full contents use a 16-pack
LRU, reduced to four packs in the background, including after snapshot hydration.
Preview queues and retry metadata each retain at most 256 jobs; at most four
local raster jobs can be running or waiting. Hiding aborts preview preparation
and retries; returning resumes from the catalog and retained packs.
Account switch and explicit cache cleanup
clear previews and cancel their owners so late work cannot refill another account.
New or uncached stickers still require an initial background preparation; sending
an already known asset never waits for it.

Picker grids paint saved pixels without fetching the original file or mounting
an animation player. Hover or keyboard focus opts the selected sticker into its
full preview, respecting motion preferences; pack stages retain their full preview.

Opening a pack from a message carries that sticker's file identity into the
preview. Prefer its stable remote identity over runtime file handles and select
it from cached or asynchronously loaded pack contents. Keep manual selection
during refresh and reset it for a new opening target. Pack links without a
target, or targets absent from the pack, fall back to the first sticker.

Sticker export is shared by the pack preview's footer, picker pack context menus,
and individual sticker context menus in both surfaces (including the enlarged
preview). Right-clicking exports its own target without sending it or changing
the selected preview. Reuse the native context-menu bridge and browser menu
surface; Escape dismisses the menu first and restores its originating control.

The native folder picker starts in the Windows Downloads known folder, then
remembers the last confirmed directory across restarts in a local protected
record separate from synced preferences. A missing directory falls back to
Downloads. Cancelling the picker performs no export downloads or filesystem
writes. Only one export may own the dialog/download pipeline at a time.

Export full pack contents rather than covers. Rebind persisted remote identities
and download originals through the shared queue, with at most four active export
reads. Preserve WEBP, TGS and WebM bytes; one sticker produces a media file and
multiple stickers produce one ZIP, streamed from disk. Pack filenames use the
pack name and ordered, zero-padded positions; standalone stickers use their file
identity when pack metadata is unavailable. Sanitize Windows filenames and
reserve collision-safe destinations without overwriting existing files. Native
storage validates every source against the active account's TDLib files directory
or the `stickers` subdirectory of its database directory (TDLib's default sticker
location). The database itself, sibling directories and other accounts remain
excluded. Each source still undergoes account and export-restriction checks;
incomplete outputs are removed on failure. Failures never report a partially
exported pack as success.

`src/telegram/stickerExport.test.ts`, the emoji controller tests and native
`storage::sticker_export` tests cover original formats, cancellation, directory
persistence, ZIP bytes, collisions, separate database/files storage,
restricted/untrusted sources and account invalidation.
`tests/e2e/sticker-export.e2e.ts` covers both surfaces at desktop
and narrow widths. Native Windows dialog appearance and real TDLib downloads
still require desktop acceptance; mock browser tests cannot validate those.

`VideoPreview` is a lightweight entry point. It renders a poster, duration and
play action; transfer feedback stays with the existing message transfer overlay.
It must not create a media element or own a playback lease. Removing a message
from a virtual list or changing conversations does not end an open viewer.

Rich-message photos, videos and animations reserve their visual frame before
previews arrive. Reuse `fitMediaLayout` with declared dimensions and the existing
photo/video fallback ratios when dimensions are unavailable. Placeholder controls,
images, decoded replacements and spoiler content fill that frame without taking
part in its height calculation. A thumbnail's intrinsic size or a source upgrade
must never resize an established virtual row or trigger another bottom correction.
Captions remain outside the frame; audio keeps its content-driven layout.

New incoming photo/video album members are coalesced by `(chatId, mediaAlbumId)`
before entering the timeline. TDLib supplies each member separately with no album
completion marker, so publish after 500 ms without a new member, or at most two
seconds after the first member. File progress, caption edits and hydration replace
buffered values without restarting the wait. Publish the batch with all original
live identities so entrance, attention, notifications and read scheduling retain
their existing semantics. Ordinary messages, outgoing albums and loaded history
remain immediate. Deletion and account changes retire pending identities/timers;
a member arriving after the bounded wait can still require a later layout update.

The main window owns `VideoPlaybackController` and the shared viewer session.
The controller acquires sources, serializes acquisition/release for each file,
remembers progress, coordinates audio ownership, and handles retries. The viewer
alone owns the `HTMLVideoElement` through `VideoPlaybackView`. Playback events
from that element are the only source of time, volume, rate and buffering state.

Every window has an ephemeral identifier; every source attempt has a revision.
State and actions must match both the active media key and source revision.
Closing, replacing or switching accounts invalidates the session immediately.
Late acquisition results are released before another acquisition of the same
file. Browser window polling and native destruction events cover exits without
a reliable `beforeunload` notification. Account transitions also clear resume
positions. No second media element is mounted in the main window.

Profile-avatar downloads may outlive the originating drawer. Both explicit and
automatic download callbacks may refresh only the same account, target and
drawer session while it remains open. Closing, changing profiles or reopening
the same profile revokes the old refresh owner; a late completion must never
reopen the drawer or replace a newer profile. Same-account file downloads may
still finish independently of the drawer's lifetime.

Native sessions opened on a photo may retain one hidden child WebView for 60 seconds
after closing. Parking unmounts the viewer and releases its action/session owner;
reopening receives a newer descriptor revision, fresh selection and fresh action
callbacks. Idle children ignore synchronization, and stale/duplicate parking cannot
close a reopened session. Video closure, replacement, account reset and media-cache
cleanup still destroy the child; an expired idle child is destroyed as well.

All WebViews install the shared memory lifecycle. Every 30 seconds, reclaim
unowned cache entries idle for two minutes; after hiding for 15 seconds, use the
smaller background budgets and a 15-second idle threshold. Live Blob URLs, photo
previews and original image owners stay valid until released. Budgets in MiB
(foreground/background) are Blob assets 20/4, photo previews 24/4, still frames
8/2, serialized TGS 8/2, picker previews 8/2 and viewer originals 64/0.
Shared-media search caches retain at most 5,000 messages globally and an estimated
8/2 MiB; the open browser owns its rows and merges subsequent pages even if the
search cache was evicted. A continuation whose prefix was evicted cannot be
reused as a first page. Capped reusable results keep their own oldest-row cursor;
the open browser retains all fetched rows with the actual server-page cursor.
These estimates omit browser internals and are not process working-set limits.
Prepared picker preview strings expire by budget rather than idle age so offline
picker use and snapshot persistence do not depend on keeping original files.
Paused TGS players are destroyed after 15 seconds
out of view and restore through the shared still frame on return.

Windows WebViews request `MemoryUsageTargetLevel` LOW while hidden or minimized,
and NORMAL when shown, where the runtime supports the interface. Do not suspend
the main WebView: its JavaScript handles message delivery and notifications.
When performance monitoring is enabled, `ui_memory_usage` samples estimated
cache bytes, active bytes, entries, pending jobs and optional Chromium JS heap.
The sample contains only numeric diagnostics and never file paths or messages.

The photo viewer retains decoded image elements, rather than URL readiness flags,
in a separate LRU cache of three entries and 64 MiB estimated RGBA pixels. Live
elements cannot be evicted; an oversized live original is released when it becomes
idle. Source upgrades keep the previous painted node until the replacement is ready.
Adjacent local photos warm sequentially at low priority after the current original
decodes, only when their declared dimensions fit alongside live pixels. Reattaching
a cached node does not request or explicitly decode the original again. The browser
can still discard internal decoded pixels under memory pressure.

An available uncropped conversation preview is transferred as a Blob to the child
for its first frame, without another native generation. Cropped album tiles cannot
stand in for an uncropped original. The original starts in parallel with the preview.
Native windows stay hidden until the ready DOM requests reveal; a 120 ms fallback
after initialization keeps missing, failed or slow sources actionable. Reveal waits
for an animation frame, with a 32 ms fallback for hidden WebViews. Entrance and
preview opacity animations are disabled in the standalone viewer.

The controller claims playback ownership while preparing. Starting audio sends
a pause to the viewer and cancels pending autoplay. A viewer requests permission
to play from the coordinator; delayed state reports never reclaim ownership.

## Inline audio messages

Music inline and floating players share `AudioTrackInfo` for their CD, title,
performer, and estimated bitrate. Queue descriptors retain the same title and
subtitle so floating playback keeps the metadata after message views unmount.
The compact floating player retains the CD and both text rows. Width and drag
coordinates use the conversation bounds in pre-zoom CSS pixels; when mobile
navigation hides the conversation, the app bounds keep playback controls visible.
The player presents the audio title and performer separately from the original
download filename. Missing tags fall back to the filename and an
unknown artist. Music uses dedicated lavender audio tokens in both themes so
its background cannot be mistaken for an outgoing message. TDLib supplies no codec
bitrate, so the compact K badge is explicitly an estimated average from file
size and duration and is omitted when those values are unavailable.

The decorative CD rotates only while its track is playing, pauses in background
windows, and stops for either app or system reduced motion. Message and rich
audio captions use a divider inset from both edges. Transport, seek, volume,
download, and queue ownership remain with the existing audio controller and host.

Voice notes are selected by `mediaType`, never the filename or MIME type. They
retain incoming/outgoing bubble colors and render a compact play button, static
waveform seek control, remaining time, rate and download actions. Message and
rich voice players align the waveform above a duration footer, keep download
actions separate, and show the rate pill only for the active track. Plain voice
bubbles share that footer with the existing message metadata; captions, reactions
and channel posts retain their own metadata placement. Outgoing controls use
the theme's success color, including a contrasting play icon in dark mode.
Message and rich page-block mappers preserve TDLib's base64-encoded, low-bit-first 5-bit
waveform. Decode work is bounded to 1 KiB; missing or unusable waveforms render
flat bars rather than invented amplitudes. The native range input handles pointer
and keyboard seeking; played bars track the shared controller and forced colors
show the native slider. Volume remains available in the floating player, where
voice tracks use a microphone instead of a rotating CD or bitrate badge. Queue
registration preserves this media type after the inline message unmounts.

## Sources, recovery and native leases

A source is retained for its entire attempt. Completing a download does not
replace a playing stream with a local URL. Both streaming and already local
files acquire a native cache lease. Release uses the exact `(session, lease)`
from registration, so an old viewer cannot release a newer owner of the file.
File identity, recovery and export checks remain in the existing transport and
native storage services.

Acquisition has a 15-second UI timeout. A late acquisition is still released;
retry cannot bypass outstanding ownership work for that file. A media load or
buffer stall has a 20-second timeout. Network, source, decode, unsupported format
and rejected play requests have distinct feedback. Retry preserves observed
time, volume, mute and rate. A failed local source goes through existing file
recovery and then uses the fresh stream, even if descriptor synchronization still
contains the old local path. `supportsStreaming` is preserved as TDLib metadata;
it is not a browser codec-support guarantee or a reason to forbid tail metadata
requests. Actual decoding failures determine format feedback.

## Range and download scheduling

TDLib has one offset/limit cursor per file. The native registry coordinates both
playback ranges and explicit full downloads. Full-download/cancel commands wait
until the active range releases that cursor, and full-download intent is restored
after a range. Releasing playback does not cancel an explicit full download.
Opportunistic frontend caching remains suppressed while playback owns the file.

Native file updates carry `notgram_download_requested` for registered streams and
full downloads. Message mapping uses that intent for download controls and progress
rings; TDLib's raw `is_downloading_active` also covers playback ranges and must not
be presented as a user download. A full download waiting for the range cursor keeps
its progress visible. Completion, cancellation and failed requests clear it.

The scheduler has four workers, at most 64 pending jobs overall and eight per
file. It schedules one range per `(account generation, file)` at a time, retaining
the original same-file lock. Head and tail probes within a source lifetime retain
their order. Replaced sources retire queued older requests; waiting reads wake when
their lease or lifetime changes. Limits reject excess requests rather than creating
an unbounded number of threads.

Seeking validates native ownership before changing `currentTime`, but never revokes
byte requests belonging to the same source. The demuxer may keep an in-flight range
across a seek, including when the target is already buffered; failing that response
would turn ordinary seeking into a media network error. Rapid seeks only grant the latest
acknowledged position, and state from the old position cannot move the cursor
back while that seek is pending. Responses follow the demuxer's requested byte
offsets, capped at 1 MiB; they no longer estimate byte positions from a time/file
size ratio. `stalled` does not enter buffering while playable data remains;
`seeked`/`canplay` clear the stall timeout after recovery, including paused seeks.
Range validation, downloaded-interval checks, content expiry,
account invalidation and restricted file access remain enforced.

## Viewer interaction

Conversation albums render reactions once in a shared footer below the entire
mosaic, including ordinary chats and forwarded channel media. Each reaction group
keeps its own source message ID for toggles and sender queries; caption and metadata
ownership must not replace that identity. When reactions exist, the footer also
owns the shared timestamp and delivery state, so individual tiles do not duplicate
metadata or place reactions over photos. Removing all reactions restores the
existing caption metadata or tile hover metadata presentation.

Photos and ordinary videos open with one click in the same viewer. A chat's
mixed media list shares captions, metadata, thumbnails, download feedback and
background-close behavior. Photo zoom stays in `useImageViewport`; video controls
stay in `VideoPlaybackView`. Arrow keys seek video, Ctrl+Arrow navigates mixed
media, Space toggles playback, and Escape closes. Clicking timeline labels or
control-panel space never counts as clicking the background.
Plain wheel input navigates the mixed media list in either direction, including
while video is preparing, playing, paused or failed. Ctrl+wheel zooms photos only
and does not navigate or apply photo zoom to video.

The default layout fits media with its context visible. Immersive playback and
the small native window keep the same element and source; mode changes preserve
time, volume and playback state. The poster uses the video's declared dimensions
before metadata loads; buffering displays only an accessible ring, without text
or a background panel. The small window's entire media surface starts native
dragging and does not toggle playback. Its controls have one translucent black
panel, with no footer gradient, and hide after two seconds without interaction
even when paused. Pointer movement restores them; an active timeline drag or
keyboard focus keeps them visible. Immersive controls hide only while playing.
Native creation enters fullscreen before show,
uses the main monitor placement helper, and grants only the window operations
used by the viewer. Multi-monitor/DPI behavior still needs native acceptance.

## Verification and performance acceptance

Unit regressions cover stale acquisition/revision rejection, late release,
preparation ownership, local recovery, exact leases and seek ordering. Rust tests
cover bounds, downloaded intervals, stale owners, account reset, range survival
across seeks and wakeup on source release,
cache protection, queue bounds and full-download arbitration. Browser regressions
in `tests/e2e/media-playback.e2e.ts` and `media-windows.e2e.ts` cover the actual
bridge, mixed navigation, audio ownership, errors, mode continuity and closure.
They run headless and muted against deterministic media, not a real TDLib account.

`media_first_frame` uses `requestVideoFrameCallback` and includes opening/source
preparation time. `media_seek_completed` measures seeking to playback recovery
(or `seeked` while paused). Buffering start/recovery events measure episodes;
`media_frame_quality` samples cumulative decoded and dropped frames every five
seconds during visible playback. Payloads contain bounded numeric metrics rather
than paths, captions or source URLs. The first-frame metric means compositor
submission, not a guarantee about physical display presentation.

`ui_media_viewer_image` reports ready-node mounting (phase 1, including a cache-hit
flag) and cold browser decoding (phase 2, including natural dimensions). It contains
no paths or URLs. Cached mounting skips a second explicit decode, but neither metric
proves a native compositor frame or eliminates the first decode of a large original.

Before claiming native performance improvements, compare the same build/settings,
machine and fixtures against a baseline using the following matrix. Record sample
counts and p50/p95 values; do not replace measurements with a `playing` event.

| Fixtures / conditions | Required observations |
| --- | --- |
| Cold cache and warm cache; small and large files | Open-to-first-frame, source attempts, memory before/after |
| Variable bitrate and metadata at the tail | Successful head/tail probing, seek recovery and download cursor behavior |
| Slow network, offline then reconnect | Buffer counts/duration, actionable failure, retry progress |
| Repeated rapid seeks and simultaneous full download | Latest seek wins, bounded work queue, full download resumes |
| Long playback in default, immersive and small modes | Dropped/decoded frames, CPU, GPU and memory |
| Close while loading/playing, navigate, switch account | Media element cleanup, exact lease release, cache protection removed |
| Multiple monitors and DPI scales | Initial fullscreen, placement, sizing, focus and close behavior |

Mock browser success does not validate WebView2 codec support, TDLib network
performance, GPU decode or native resource reclamation. Keep those results
separate in release acceptance records.
