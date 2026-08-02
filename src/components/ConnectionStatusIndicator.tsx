import {
  CheckCircle2,
  CloudOff,
  LoaderCircle,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { connectionPresentation } from "../telegram/connectionState";
import type { ConnectionStatus } from "../telegram/types";

interface ConnectionStatusIndicatorProps {
  status: ConnectionStatus;
  compact?: boolean;
  transportLabel?: string;
  className?: string;
}

export function ConnectionStatusIndicator({
  status,
  compact = false,
  transportLabel,
  className = "",
}: ConnectionStatusIndicatorProps) {
  const presentation = connectionPresentation(status);
  const label = compact ? presentation.compactLabel : presentation.label;
  const title = transportLabel ? `${transportLabel} · ${presentation.label}` : presentation.label;

  return (
    <span
      className={`connection-status is-${presentation.tone} ${className}`.trim()}
      role="status"
      aria-live="polite"
      title={title}
    >
      <StatusIcon status={status} busy={presentation.busy} />
      <span>{transportLabel && !compact ? `${transportLabel} · ` : ""}{label}</span>
    </span>
  );
}

function StatusIcon({ status, busy }: { status: ConnectionStatus; busy: boolean }) {
  const props = { size: 13, strokeWidth: 2 };
  if (status === "online") return <CheckCircle2 {...props} aria-hidden="true" />;
  if (status === "waitingForNetwork") return <WifiOff {...props} aria-hidden="true" />;
  if (status === "proxyError") return <TriangleAlert {...props} aria-hidden="true" />;
  if (busy) return <LoaderCircle {...props} className="spin" aria-hidden="true" />;
  return <CloudOff {...props} aria-hidden="true" />;
}
