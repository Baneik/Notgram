# Shared media viewer and video ownership

## Ownership

`VideoPreview` is a lightweight entry point. It renders a poster, duration and
play action; transfer feedback stays with the existing message transfer overlay.
It must not create a media element or own a playback lease. Removing a message
from a virtual list or changing conversations does not end an open viewer.

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

The controller claims playback ownership while preparing. Starting audio sends
a pause to the viewer and cancels pending autoplay. A viewer requests permission
to play from the coordinator; delayed state reports never reclaim ownership.

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
