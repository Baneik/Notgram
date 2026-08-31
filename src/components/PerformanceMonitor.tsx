import { currentLanguage, translate } from "../i18n";
import { Activity, Gauge, Pause, Play, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  clearPerformanceRecords,
  clearPersistedPerformanceRecords,
  getDisplayTiming,
  getPerformanceRecords,
  performanceCauseDomains,
  performanceCauseKinds,
  performanceEvidenceKinds,
  refreshPersistedPerformanceRecords,
  subscribeDisplayTiming,
  subscribePerformanceRecords,
  conversationBottleneckStages,
  conversationStageMaskLabels,
  type PerformanceCategory,
  type PerformanceRecord,
} from "../utils/performanceMonitor";

type CategoryFilter = "all" | PerformanceCategory;

const filters: Array<{ id: CategoryFilter; label: string }> = [
  { id: "all", get label() { return translate("全部"); } },
  { id: "interaction", get label() { return translate("交互"); } },
  { id: "render", get label() { return translate("渲染"); } },
  { id: "data", get label() { return translate("数据"); } },
  { id: "media", get label() { return translate("媒体"); } },
  { id: "startup", get label() { return translate("启动"); } },
];

const detailLabels: Record<string, string> = {
  get durationMs() { return translate("总耗时"); },
  get inputDelayMs() { return translate("输入等待"); },
  get processingDurationMs() { return translate("事件处理"); },
  get presentationDelayMs() { return translate("呈现等待"); },
  get blockingDurationMs() { return translate("阻塞时间"); },
  get scriptDurationMs() { return translate("脚本执行"); },
  get renderDurationMs() { return translate("渲染阶段"); },
  get styleLayoutDurationMs() { return translate("样式与布局"); },
  get restoreDurationMs() { return translate("锚点恢复"); },
  get domInteractiveMs() { return translate("DOM 可交互"); },
  get domContentLoadedMs() { return translate("DOM 加载"); },
  get loadEventMs() { return translate("页面加载"); },
  get firstContentfulPaintMs() { return translate("首次内容绘制"); },
  get firstPaintMs() { return translate("首次绘制"); },
  get responseStartMs() { return translate("首字节响应"); },
  get domCompleteMs() { return translate("DOM 完成"); },
  get frameGapMs() { return translate("帧间隔"); },
  get frameBudgetMs() { return translate("当前帧预算"); },
  get refreshRateHz() { return translate("当前刷新率"); },
  get refreshRateSource() { return translate("刷新率来源"); },
  get expectedFrames() { return translate("预期帧数"); },
  get missedFrames() { return translate("预估丢帧"); },
  get averageFrameGapMs() { return translate("平均帧间隔"); },
  get jitterMs() { return translate("帧节奏波动"); },
  get jitterScore() { return translate("抽动分数"); },
  get maxFrameGapMs() { return translate("最大帧间隔"); },
  get unstableFrameCount() { return translate("不稳定帧数"); },
  get sampleCount() { return translate("采样帧数"); },
  get shiftScore() { return translate("偏移分数"); },
  get maxShiftScore() { return translate("单次最大偏移"); },
  get shiftCount() { return translate("合并偏移次数"); },
  get anchorShiftPx() { return translate("锚点偏移"); },
  get addedCount() { return translate("新增消息"); },
  get loadedCount() { return translate("加载消息"); },
  get batchCount() { return translate("合并批量"); },
  get beforeCount() { return translate("处理前数量"); },
  get afterCount() { return translate("处理后数量"); },
  get scrollHeight() { return translate("滚动高度"); },
  get scrollTop() { return translate("滚动位置"); },
  get failed() { return translate("是否失败"); },
  get hasMore() { return translate("仍有历史"); },
  get duringHistoryLoad() { return translate("历史加载期间"); },
  get duringConversationSwitch() { return translate("会话切换期间"); },
  get targetKind() { return translate("目标类型"); },
  get regionKind() { return translate("界面区域"); },
  get interactionKind() { return translate("交互类型"); },
  get causeDomain() { return translate("耗时归属"); },
  get causeKind() { return translate("可能原因"); },
  get evidenceKind() { return translate("判断证据"); },
  get uiStall() { return translate("真实界面卡顿"); },
  get mainThreadBlocked() { return translate("主线程阻塞"); },
  get pageVisible() { return translate("页面可见"); },
  get windowFocused() { return translate("窗口聚焦"); },
  get networkOnline() { return translate("系统网络在线"); },
  get traceId() { return translate("链路编号"); },
  get windowKind() { return translate("窗口类型"); },
  get navigationKind() { return translate("导航类型"); },
  get messageCount() { return translate("消息数量"); },
  get blockCount() { return translate("虚拟块数量"); },
  get cached() { return translate("缓存命中"); },
  get viewTransition() { return translate("视图过渡"); },
  get selectionDurationMs() { return translate("选择提交工作"); },
  get dataDurationMs() { return translate("数据就绪等待"); },
  get projectionDurationMs() { return translate("消息投影"); },
  get reactDurationMs() { return translate("React 提交"); },
  get frontendWorkDurationMs() { return translate("已测前端工作"); },
  get visualResponseDurationMs() { return translate("界面响应"); },
  get asyncWaitDurationMs() { return translate("异步等待"); },
  get asyncWaitCount() { return translate("异步等待次数"); },
  get asyncWaitInFlight() { return translate("异步仍在进行"); },
  get asyncWaitFailed() { return translate("异步等待失败"); },
  get traceWaitDurationMs() { return translate("追踪器等待"); },
  get mainThreadBlockedDurationMs() { return translate("主线程阻塞证据"); },
  get longestMainThreadStallMs() { return translate("最长主线程停顿"); },
  get mainThreadStallCount() { return translate("主线程停顿次数"); },
  get baseDurationMs() { return translate("React 基准耗时"); },
  get virtualListDurationMs() { return translate("虚拟列表首帧"); },
  get positionDurationMs() { return translate("滚动定位"); },
  get transitionDurationMs() { return translate("视觉呈现耗时"); },
  get bottleneckStage() { return translate("最大瓶颈"); },
  get bottleneckDurationMs() { return translate("瓶颈耗时"); },
  get timedOut() { return translate("链路超时"); },
  get cancelled() { return translate("链路被替代"); },
  get completedStageMask() { return translate("已完成阶段"); },
  get missingStageMask() { return translate("缺失阶段"); },
  get phaseKind() { return translate("React 阶段"); },
  get componentKind() { return translate("组件区域"); },
  get sourceCount() { return translate("偏移元素数量"); },
  get movedDistancePx() { return translate("最大移动距离"); },
  get impactedAreaPx() { return translate("最大影响面积"); },
  get scriptCount() { return translate("脚本数量"); },
  get longestScriptDurationMs() { return translate("最长脚本"); },
  get forcedStyleLayoutDurationMs() { return translate("强制样式与布局"); },
  get pauseDurationMs() { return translate("脚本暂停"); },
  get scriptSourceKind() { return translate("脚本来源"); },
  get scriptInvokerKind() { return translate("脚本触发方式"); },
  get sourceCharPosition() { return translate("源码字符位置"); },
  get attributionCount() { return translate("任务归因数量"); },
  get containerKind() { return translate("任务容器"); },
  get droppedCount() { return translate("丢失记录"); },
  get messageUpdateCount() { return translate("消息更新"); },
  get chatUpdateCount() { return translate("会话更新"); },
  get fileUpdateCount() { return translate("文件更新"); },
  get otherUpdateCount() { return translate("其他更新"); },
  get chatCount() { return translate("会话数量"); },
  get forumCount() { return translate("论坛数量"); },
  get mediaKind() { return translate("媒体类型"); },
  get bufferedAheadMs() { return translate("前方缓冲"); },
  get streaming() { return translate("流式播放"); },
};

const targetLabels: Record<number, string> = {
  get 0() { return translate("未知"); },
  get 1() { return translate("按钮"); },
  get 2() { return translate("输入控件"); },
  get 3() { return translate("链接"); },
  get 4() { return translate("媒体"); },
  get 5() { return translate("列表项"); },
  get 6() { return translate("页面区域"); },
};

const interactionLabels: Record<number, string> = {
  get 0() { return translate("其他"); },
  get 1() { return translate("点击"); },
  get 2() { return translate("键盘"); },
  get 3() { return translate("指针"); },
  get 4() { return translate("输入"); },
};

const windowLabels: Record<number, string> = {
  get 0() { return translate("未知"); },
  get 1() { return translate("主窗口"); },
  get 2() { return translate("视频窗口"); },
  get 3() { return translate("设置窗口"); },
  get 4() { return translate("媒体查看器"); },
  get 5() { return translate("右键菜单"); },
  get 6() { return translate("桌面通知"); },
};

const mediaLabels: Record<number, string> = {
  get 1() { return translate("视频"); },
  get 2() { return translate("音频"); },
};

const navigationLabels: Record<number, string> = {
  get 0() { return translate("未知"); },
  get 1() { return translate("打开会话"); },
  get 2() { return translate("跳到最新"); },
  get 3() { return translate("搜索结果"); },
  get 4() { return translate("切换话题"); },
};

const phaseLabels: Record<number, string> = {
  get 1() { return translate("挂载"); },
  get 2() { return translate("更新"); },
};

const componentLabels: Record<number, string> = {
  get 1() { return translate("会话视图"); },
};

const regionLabels: Record<number, string> = {
  get 0() { return translate("未知区域"); },
  get 1() { return translate("会话侧栏"); },
  get 2() { return translate("消息时间线"); },
  get 3() { return translate("消息输入区"); },
  get 4() { return translate("设置"); },
  get 5() { return translate("媒体"); },
  get 6() { return translate("窗口导航"); },
  get 7() { return translate("其他页面区域"); },
};

const refreshRateSourceLabels: Record<number, string> = {
  get 0() { return translate("60 Hz 回退值"); },
  get 1() { return translate("Windows 当前显示器"); },
  get 2() { return translate("动画帧校准"); },
};

const scriptSourceLabels: Record<number, string> = {
  get 0() { return translate("未知"); },
  get 1() { return translate("应用脚本"); },
  get 2() { return translate("外部脚本"); },
  get 3() { return translate("浏览器扩展"); },
};

const scriptInvokerLabels: Record<number, string> = {
  get 0() { return translate("未知"); },
  get 1() { return translate("事件监听器"); },
  get 2() { return translate("Promise 回调"); },
  get 3() { return translate("脚本执行"); },
  get 4() { return translate("用户回调"); },
};

const containerLabels: Record<number, string> = {
  get 0() { return translate("未知"); },
  get 1() { return translate("当前窗口"); },
  get 2() { return translate("内嵌框架"); },
  get 3() { return translate("嵌入内容"); },
};

const formatStageMask = (mask: number) => {
  if (mask === 0) return translate("无");
  return Object.entries(conversationStageMaskLabels)
    .filter(([bit]) => (mask & Number(bit)) !== 0)
    .map(([, label]) => label)
    .join("、");
};

const formatDuration = (durationMs?: number) => {
  if (durationMs === undefined) return "--";
  if (durationMs < 1) return `${durationMs.toFixed(1)} ms`;
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1_000).toFixed(2)} s`;
};

const formatTimestamp = (timestampMs: number) => new Date(timestampMs).toLocaleTimeString(
  currentLanguage(),
  { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" },
);

const formatDetail = (key: string, value: number | boolean) => {
  if (typeof value === "boolean") return value ? translate("是") : translate("否");
  if (key === "targetKind") return targetLabels[value] ?? translate("其他");
  if (key === "interactionKind") return interactionLabels[value] ?? translate("其他");
  if (key === "windowKind") return windowLabels[value] ?? translate("其他");
  if (key === "mediaKind") return mediaLabels[value] ?? translate("其他");
  if (key === "navigationKind") return navigationLabels[value] ?? translate("其他");
  if (key === "phaseKind") return phaseLabels[value] ?? translate("其他");
  if (key === "componentKind") return componentLabels[value] ?? translate("其他");
  if (key === "regionKind") return regionLabels[value] ?? translate("其他");
  if (key === "refreshRateSource") return refreshRateSourceLabels[value] ?? translate("未知");
  if (key === "scriptSourceKind") return scriptSourceLabels[value] ?? translate("未知");
  if (key === "scriptInvokerKind") return scriptInvokerLabels[value] ?? translate("未知");
  if (key === "containerKind") return containerLabels[value] ?? translate("未知");
  if (key === "causeDomain") return performanceCauseDomains[value] ?? translate("未分类");
  if (key === "causeKind") return performanceCauseKinds[value] ?? translate("证据不足");
  if (key === "evidenceKind") return performanceEvidenceKinds[value] ?? translate("应用计时");
  if (key === "bottleneckStage") return conversationBottleneckStages[value] ?? translate("未确定");
  if (key === "completedStageMask" || key === "missingStageMask") return formatStageMask(value);
  if (key === "refreshRateHz") return `${value.toFixed(1)} Hz`;
  if (key.endsWith("Ms")) return formatDuration(value);
  if (key.endsWith("Px")) return `${value.toFixed(1)} px`;
  if (key === "shiftScore") return value.toFixed(3);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

const visibleDetails = (record: PerformanceRecord) => Object.entries(record.details)
  .filter(([key]) => !["startTimeMs", "observedAtMs", "windowId"].includes(key) && key in detailLabels);

const performanceLabel = (record: PerformanceRecord) => {
  const causeDomain = Number(record.details.causeDomain ?? 0);
  const causeKind = Number(record.details.causeKind ?? 0);
  const cause = record.event === "ui_conversation_switch" && causeKind === 9
    ? performanceCauseKinds[causeKind]
    : performanceCauseDomains[causeDomain];
  return cause ? `${record.label} · ${cause}` : record.label;
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
  const [displayTiming, setDisplayTiming] = useState(getDisplayTiming);

  useEffect(() => subscribeDisplayTiming(() => setDisplayTiming(getDisplayTiming())), []);

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
  const uiIssues = records.filter(
    (record) => record.severity !== "normal" && record.details.uiStall === true,
  );
  const asyncIssues = records.filter(
    (record) => record.severity !== "normal" && record.details.causeDomain === 3,
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
            <h4 id="performance-overview-heading">{translate("实时会话")}</h4>
            <span>
              {live ? translate("正在刷新") : translate("已暂停刷新")} · {displayTiming.refreshRateHz.toFixed(1)} Hz
            </span>
          </div>
        </div>
        <div className="performance-summary">
          <div>
            <span>{translate("记录")}</span>
            <strong>{records.length}</strong>
          </div>
          <div>
            <span>{translate("界面卡顿")}</span>
            <strong>{uiIssues.length}</strong>
          </div>
          <div>
            <span>{translate("主线程阻塞")}</span>
            <strong>{formatDuration(blockingMs)}</strong>
          </div>
          <div>
            <span>{translate("异步慢项")}</span>
            <strong>{asyncIssues.length}</strong>
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
            <span>{live ? translate("暂停刷新") : translate("继续刷新")}</span>
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={translate("清空性能记录")}
            title={translate("清空性能记录")}
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
            <h4 id="performance-timeline-heading">{translate("性能时间线")}</h4>
            <span>{translate("{{value0}} 条采样", { value0: filtered.length })}</span>
          </div>
        </div>
        <div className="performance-filters" role="group" aria-label={translate("性能记录分类")}>
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
            <div className="performance-empty">{translate("暂无性能采样")}</div>
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
