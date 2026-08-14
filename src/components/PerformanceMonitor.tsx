import { Activity, Gauge, Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  clearPerformanceRecords,
  clearPersistedPerformanceRecords,
  getPerformanceRecords,
  refreshPersistedPerformanceRecords,
  subscribePerformanceRecords,
  conversationBottleneckStages,
  type PerformanceCategory,
  type PerformanceRecord,
} from "../utils/performanceMonitor";

type CategoryFilter = "all" | PerformanceCategory;

const filters: Array<{ id: CategoryFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "interaction", label: "交互" },
  { id: "render", label: "渲染" },
  { id: "data", label: "数据" },
  { id: "media", label: "媒体" },
  { id: "startup", label: "启动" },
];

const detailLabels: Record<string, string> = {
  durationMs: "总耗时",
  inputDelayMs: "输入等待",
  processingDurationMs: "事件处理",
  presentationDelayMs: "呈现等待",
  blockingDurationMs: "阻塞时间",
  scriptDurationMs: "脚本执行",
  renderDurationMs: "渲染阶段",
  styleLayoutDurationMs: "样式与布局",
  restoreDurationMs: "锚点恢复",
  domInteractiveMs: "DOM 可交互",
  domContentLoadedMs: "DOM 加载",
  loadEventMs: "页面加载",
  firstContentfulPaintMs: "首次内容绘制",
  frameGapMs: "帧间隔",
  missedFrames: "预估丢帧",
  shiftScore: "偏移分数",
  maxShiftScore: "单次最大偏移",
  shiftCount: "合并偏移次数",
  anchorShiftPx: "锚点偏移",
  addedCount: "新增消息",
  loadedCount: "加载消息",
  batchCount: "合并批量",
  beforeCount: "处理前数量",
  afterCount: "处理后数量",
  scrollHeight: "滚动高度",
  scrollTop: "滚动位置",
  failed: "是否失败",
  hasMore: "仍有历史",
  duringHistoryLoad: "历史加载期间",
  duringConversationSwitch: "会话切换期间",
  targetKind: "目标类型",
  interactionKind: "交互类型",
  traceId: "链路编号",
  windowKind: "窗口类型",
  navigationKind: "导航类型",
  messageCount: "消息数量",
  blockCount: "虚拟块数量",
  cached: "缓存命中",
  viewTransition: "视图过渡",
  selectionDurationMs: "选择提交",
  dataDurationMs: "数据等待",
  projectionDurationMs: "消息投影",
  reactDurationMs: "React 提交",
  baseDurationMs: "React 基准耗时",
  virtualListDurationMs: "虚拟列表首帧",
  positionDurationMs: "滚动定位",
  transitionDurationMs: "视觉呈现耗时",
  bottleneckStage: "最大瓶颈",
  bottleneckDurationMs: "瓶颈耗时",
  timedOut: "链路超时",
  cancelled: "链路被替代",
  phaseKind: "React 阶段",
  componentKind: "组件区域",
  sourceCount: "偏移元素数量",
  movedDistancePx: "最大移动距离",
  impactedAreaPx: "最大影响面积",
  droppedCount: "丢失记录",
  messageUpdateCount: "消息更新",
  chatUpdateCount: "会话更新",
  fileUpdateCount: "文件更新",
  otherUpdateCount: "其他更新",
  chatCount: "会话数量",
  forumCount: "论坛数量",
};

const targetLabels: Record<number, string> = {
  0: "未知",
  1: "按钮",
  2: "输入控件",
  3: "链接",
  4: "媒体",
  5: "列表项",
  6: "页面区域",
};

const interactionLabels: Record<number, string> = {
  0: "其他",
  1: "点击",
  2: "键盘",
  3: "指针",
  4: "输入",
};

const windowLabels: Record<number, string> = {
  0: "未知",
  1: "主窗口",
  2: "视频窗口",
};

const navigationLabels: Record<number, string> = {
  0: "未知",
  1: "打开会话",
  2: "跳到最新",
  3: "搜索结果",
  4: "切换话题",
};

const phaseLabels: Record<number, string> = {
  1: "挂载",
  2: "更新",
};

const componentLabels: Record<number, string> = {
  1: "会话视图",
};

const formatDuration = (durationMs?: number) => {
  if (durationMs === undefined) return "--";
  if (durationMs < 1) return `${durationMs.toFixed(1)} ms`;
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1_000).toFixed(2)} s`;
};

const formatTimestamp = (timestampMs: number) => new Date(timestampMs).toLocaleTimeString(
  "zh-CN",
  { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" },
);

const formatDetail = (key: string, value: number | boolean) => {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (key === "targetKind") return targetLabels[value] ?? "其他";
  if (key === "interactionKind") return interactionLabels[value] ?? "其他";
  if (key === "windowKind") return windowLabels[value] ?? "其他";
  if (key === "navigationKind") return navigationLabels[value] ?? "其他";
  if (key === "phaseKind") return phaseLabels[value] ?? "其他";
  if (key === "componentKind") return componentLabels[value] ?? "其他";
  if (key === "bottleneckStage") return conversationBottleneckStages[value] ?? "未确定";
  if (key.endsWith("Ms")) return formatDuration(value);
  if (key.endsWith("Px")) return `${value.toFixed(1)} px`;
  if (key === "shiftScore") return value.toFixed(3);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

const visibleDetails = (record: PerformanceRecord) => Object.entries(record.details)
  .filter(([key]) => !["startTimeMs", "observedAtMs", "windowId"].includes(key) && key in detailLabels);

const performanceLabel = (record: PerformanceRecord) => {
  if (record.event !== "ui_conversation_switch") return record.label;
  const stage = Number(record.details.bottleneckStage ?? 0);
  return `${record.label} · ${conversationBottleneckStages[stage] ?? "未确定"}`;
};

const formatRecordMetric = (record: PerformanceRecord) => record.event === "ui_layout_shift"
  ? Number(record.details.shiftScore ?? 0).toFixed(3)
  : formatDuration(record.durationMs);

export function PerformanceMonitor() {
  const [records, setRecords] = useState(getPerformanceRecords);
  const [live, setLive] = useState(true);
  const [filter, setFilter] = useState<CategoryFilter>("all");
  const [expandedId, setExpandedId] = useState<number>();
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!live || clearing) return;
    let active = true;
    const update = () => {
      if (active) setRecords(getPerformanceRecords());
    };
    const refresh = () => {
      void refreshPersistedPerformanceRecords().then(update).catch(() => undefined);
    };
    update();
    refresh();
    const interval = globalThis.setInterval(refresh, 750);
    const unsubscribe = subscribePerformanceRecords(update);
    return () => {
      active = false;
      globalThis.clearInterval(interval);
      unsubscribe();
    };
  }, [clearing, live]);

  const filtered = useMemo(
    () => records.filter((record) => filter === "all" || record.category === filter).reverse(),
    [filter, records],
  );
  const issues = records.filter((record) => record.severity !== "normal");
  const slowest = records.reduce<PerformanceRecord | undefined>(
    (current, record) => !current || (record.durationMs ?? 0) > (current.durationMs ?? 0)
      ? record
      : current,
    undefined,
  );
  const blockingMs = records
    .filter((record) => record.event === "ui_long_frame" || record.event === "ui_long_task")
    .reduce((total, record) => total + (record.durationMs ?? 0), 0);
  const maxDuration = Math.max(1, ...filtered.map((record) => record.durationMs ?? 0));

  const clear = async () => {
    setClearing(true);
    clearPerformanceRecords();
    setRecords([]);
    setExpandedId(undefined);
    try {
      await clearPersistedPerformanceRecords();
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="settings-detail-scroll performance-monitor">
      <section className="settings-section performance-overview" aria-labelledby="performance-overview-heading">
        <div className="settings-section-heading">
          <Gauge size={18} strokeWidth={1.8} />
          <div>
            <h4 id="performance-overview-heading">实时会话</h4>
            <span>{live ? "正在刷新" : "已暂停刷新"}</span>
          </div>
        </div>
        <div className="performance-summary">
          <div>
            <span>记录</span>
            <strong>{records.length}</strong>
          </div>
          <div>
            <span>慢点</span>
            <strong>{issues.length}</strong>
          </div>
          <div>
            <span>主线程阻塞</span>
            <strong>{formatDuration(blockingMs)}</strong>
          </div>
          <div>
            <span>最慢阶段</span>
            <strong title={slowest ? performanceLabel(slowest) : undefined}>
              {slowest ? performanceLabel(slowest) : "--"}
            </strong>
          </div>
        </div>
        <div className="performance-toolbar">
          <button
            className="dialog-secondary"
            type="button"
            aria-pressed={!live}
            onClick={() => setLive((current) => !current)}
          >
            {live ? <Pause size={16} /> : <Play size={16} />}
            <span>{live ? "暂停刷新" : "继续刷新"}</span>
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="清空性能记录"
            title="清空性能记录"
            disabled={records.length === 0 || clearing}
            onClick={() => void clear()}
          >
            <Trash2 size={17} />
          </button>
        </div>
      </section>

      <section className="settings-section performance-timeline-section" aria-labelledby="performance-timeline-heading">
        <div className="settings-section-heading">
          <Activity size={18} strokeWidth={1.8} />
          <div>
            <h4 id="performance-timeline-heading">性能时间线</h4>
            <span>{filtered.length} 条采样</span>
          </div>
        </div>
        <div className="performance-filters" role="group" aria-label="性能记录分类">
          {filters.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="performance-timeline" aria-live="polite">
          {filtered.length === 0 ? (
            <div className="performance-empty">暂无性能采样</div>
          ) : filtered.map((record) => {
            const expanded = record.id === expandedId;
            const details = visibleDetails(record);
            return (
              <div className={`performance-entry severity-${record.severity}`} key={record.id}>
                <button
                  className="performance-entry-main"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpandedId(expanded ? undefined : record.id)}
                >
                  <span className="performance-entry-time">{formatTimestamp(record.timestampMs)}</span>
                  <span className="performance-entry-label">{performanceLabel(record)}</span>
                  <span className="performance-entry-duration">{formatRecordMetric(record)}</span>
                  <span className="performance-entry-track" aria-hidden="true">
                    <span style={{ width: `${Math.max(2, ((record.durationMs ?? 0) / maxDuration) * 100)}%` }} />
                  </span>
                </button>
                {expanded && (
                  <dl className="performance-entry-details">
                    {details.map(([key, value]) => (
                      <div key={key}>
                        <dt>{detailLabels[key]}</dt>
                        <dd>{formatDetail(key, value)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
