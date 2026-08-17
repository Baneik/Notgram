import { Headphones, LoaderCircle } from "lucide-react";
import { useMemo } from "react";
import { localMediaSource } from "../media/localMediaSource";
import type { ProfileAudio } from "../telegram/types";
import { AudioPlayer } from "./AudioPlayer";

interface ProfilePlaylistProps {
  profileId: string;
  title: string;
  audios: ProfileAudio[];
  totalCount: number;
  loading?: boolean;
  onDownload: (fileId: number, fileName: string) => Promise<void>;
  onCancelDownload: (fileId: number) => Promise<void>;
  onRecoverFile: (fileId: number, priority?: number) => Promise<boolean>;
  onRequestStream: (fileId: number, size: number, mimeType?: string) => Promise<string | undefined>;
  onSuspendStream: (fileId: number) => Promise<void>;
}

export function ProfilePlaylist({
  profileId,
  title,
  audios,
  totalCount,
  loading,
  onDownload,
  onCancelDownload,
  onRecoverFile,
  onRequestStream,
  onSuspendStream,
}: ProfilePlaylistProps) {
  const playbackIds = useMemo(
    () => audios.map((audio) => `profile:${profileId}:audio:${audio.id}`),
    [audios, profileId],
  );

  if (loading && audios.length === 0) {
    return <div className="profile-detail-empty" role="status"><LoaderCircle className="spin" size={20} />正在读取音乐</div>;
  }

  if (audios.length === 0) {
    return (
      <div className="profile-detail-empty" role="status">
        <Headphones size={24} />
        <span>{title}还没有公开资料音乐</span>
      </div>
    );
  }

  return (
    <div className="profile-playlist" aria-label={`${title}的音乐`}>
      {audios.map((audio, index) => {
        const content = audio.content;
        const label = audio.title || content.fileName;
        const subtitle = audio.performer || content.sizeLabel;
        const fileId = content.fileId;
        return (
          <article className="profile-playlist-track" key={audio.id}>
            <span className="profile-track-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <AudioPlayer
              source={localMediaSource(content.localPath)}
              playbackId={playbackIds[index]!}
              label={label}
              subtitle={subtitle}
              fileId={fileId}
              size={content.size}
              mimeType={content.mimeType}
              durationHint={content.duration}
              previousPlaybackId={playbackIds[index - 1]}
              nextPlaybackId={playbackIds[index + 1]}
              downloadProgress={content.progress}
              onRequestStream={onRequestStream}
              onRecoverFile={fileId !== undefined ? () => onRecoverFile(fileId, 32) : undefined}
              onSuspendStream={fileId !== undefined ? () => { void onSuspendStream(fileId); } : undefined}
              onDownload={
                fileId !== undefined && content.canDownload !== false && !content.isDownloaded
                  ? () => void onDownload(fileId, content.fileName)
                  : undefined
              }
              onCancelDownload={
                fileId !== undefined && content.isDownloading
                  ? () => void onCancelDownload(fileId)
                  : undefined
              }
            />
          </article>
        );
      })}
      <p className="profile-playlist-count">{totalCount} 首资料音乐</p>
    </div>
  );
}
