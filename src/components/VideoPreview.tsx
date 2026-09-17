import { Play } from "lucide-react";
import { useEffect, useRef } from "react";
import { translate } from "../i18n";
import { captureActiveComposerFocus } from "../hooks/useComposerFocus";
import { formatPlaybackTime } from "../media/mediaPlayback";
import { listenForVideoWindowRequest } from "../media/videoWindowBridge";
import { openMediaViewerWindow } from "../media/mediaViewerWindowBridge";
import { currentColorTheme } from "../theme/theme";
import type { ViewerMessage } from "../utils/mediaViewerModel";
import { StableImage } from "./StableImage";

interface Props {
  source?: string;
  poster?: string;
  playbackId: string;
  label: string;
  fileId?: number;
  size?: number;
  mimeType?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  duration?: number;
  round?: boolean;
  canDownload?: boolean;
  onOpen?: (windowed?: boolean) => void;
  onDownload?: () => void | Promise<void>;
  onRequestStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendStream: (fileId: number, source?: string) => Promise<void>;
  onRecoverFile?: (fileId: number, priority?: number) => Promise<boolean>;
}

export function VideoPreview(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const open = (windowed = false) => {
    const value = latest.current;
    if (value.onOpen) { value.onOpen(windowed); return; }
    const message: ViewerMessage = {
      id: value.playbackId, chatId: "video-preview", senderId: "self", sentAt: "", outgoing: false, delivery: "read",
      content: { kind: "media", mediaType: value.round ? "videoNote" : "video", fileName: value.label,
        sizeLabel: "", size: value.size, fileId: value.fileId, mimeType: value.mimeType,
        width: value.mediaWidth, height: value.mediaHeight, duration: value.duration,
        previewDataUrl: value.poster, canDownload: value.canDownload },
    };
    void openMediaViewerWindow({ messages: [message], activeMessageId: message.id, colorTheme: currentColorTheme(), allowSave: false, mode: windowed ? "window" : "fullscreen" },
      async () => { await value.onDownload?.(); }, async () => undefined, captureActiveComposerFocus(true), undefined,
      { getSource: () => latest.current.playbackId === value.playbackId ? latest.current.source : value.source,
        stream: value.onRequestStream, suspend: value.onSuspendStream, recover: value.onRecoverFile });
  };
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => listenForVideoWindowRequest(props.playbackId, () => openRef.current(true)), [props.playbackId]);
  return <button type="button" className={`video-preview ${props.round ? "is-round" : ""}`} onClick={() => open()}
    aria-label={translate("播放 {{value0}}", { value0: props.label })}>
    {props.poster && <StableImage src={props.poster} alt="" loading="lazy" decoding="async" />}
    <span className="video-preview-play"><Play size={25} fill="currentColor" /></span>
    <span className="video-preview-duration">{formatPlaybackTime(props.duration ?? 0)}</span>
  </button>;
}
