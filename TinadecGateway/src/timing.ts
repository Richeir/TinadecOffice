/**
 * 网关自身的请求耗时观测。
 *
 * Elysia 的每个生命周期钩子都是一次独立调用，没有可以挂 AsyncLocalStorage 的
 * 同一条续延，所以分段只在路由主动测量的地方记录。`total` 始终可用：请求钩子
 * 已经框住了整个生命周期。
 */

export interface TimingSegment {
  name: string;
  durMs: number;
}

export interface RequestTiming {
  startedAt: number;
  segments: TimingSegment[];
  /** 头与日志只允许终结一次：onError 与 onAfterHandle 不在同一条路径上，也要防重入。 */
  finalized: boolean;
}

export interface TimingSnapshot {
  header: string;
  totalMs: number;
  segments: TimingSegment[];
}

const timings = new WeakMap<object, RequestTiming>();

export function startRequestTiming(request: object): RequestTiming {
  const timing: RequestTiming = { startedAt: performance.now(), segments: [], finalized: false };
  timings.set(request, timing);
  return timing;
}

export function requestTimingFor(request: object): RequestTiming | undefined {
  return timings.get(request);
}

/**
 * 测量一次上游分段。没有被计时的请求直接透传，不引入任何额外对象分配。
 */
export async function measureSegment<T>(
  timing: RequestTiming | undefined,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  if (!timing) return run();
  const startedAt = performance.now();
  try {
    return await run();
  } finally {
    timing.segments.push({ name, durMs: performance.now() - startedAt });
  }
}

/**
 * Server-Timing 的 metric 名走 RFC 7230 的 token（tchar），`.` 本身合法，所以
 * `task-nodes.direct` 原样保留——改写名字会让两个不同分段撞成同一个 metric。
 * 只收敛 tchar 之外、Core 路径里可能出现的字符。
 */
function metricName(name: string): string {
  const token = name.replace(/[^a-zA-Z0-9!#$%&'*+.^_`|~-]/g, '_');
  // 空名会生成 `Server-Timing: ;dur=…` 这种没有成员名的非法条目。
  return token.length > 0 ? token : 'segment';
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export function snapshotRequestTiming(timing: RequestTiming): TimingSnapshot {
  const totalMs = performance.now() - timing.startedAt;
  const parts = timing.segments.map((segment) => `${metricName(segment.name)};dur=${round(segment.durMs)}`);
  parts.push(`total;dur=${round(totalMs)}`);
  return { header: parts.join(', '), totalMs, segments: timing.segments };
}

/** 同一个请求只能有一份 Server-Timing 与一条采样日志；后到者拿到 null。 */
export function finalizeRequestTiming(timing: RequestTiming): TimingSnapshot | null {
  if (timing.finalized) return null;
  timing.finalized = true;
  return snapshotRequestTiming(timing);
}

/**
 * 采样是硬开关：默认 0 表示只出响应头、不写日志。埋点不能靠日志 IO 反噬
 * 它要观测的那条路径。
 */
export function shouldSample(sampleRate: number): boolean {
  if (!(sampleRate > 0)) return false;
  if (sampleRate >= 1) return true;
  return Math.random() < sampleRate;
}

/**
 * 只记归属与耗时，不记 body、查询串或任何凭证字段。分段名由网关自己产生，
 * 但路径仍做长度收敛，避免异常 URL 把一行日志撑到无界。
 */
export function logRequestTiming(
  method: string,
  pathname: string,
  status: number,
  snapshot: TimingSnapshot,
): void {
  const segments = snapshot.segments
    .map((segment) => `${metricName(segment.name)}=${round(segment.durMs)}`)
    .join(' ');
  console.log(
    `[gateway-timing] ${method} ${pathname.slice(0, 200)} ${status} total=${round(snapshot.totalMs)}ms${segments ? ` ${segments}` : ''}`,
  );
}
