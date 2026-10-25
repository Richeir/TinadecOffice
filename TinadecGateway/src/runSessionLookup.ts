import { proxyJson } from './coreClient.js';

/**
 * Core 按会话存 task node / context version，没有 run 级记录，所以 run 级路由
 * 必须先查出 run 所属的会话。同一个界面会一起读 task-nodes 和 context-versions，
 * 两个请求各自去问一次编排快照就是重复的往返；这里让第二个调用者加入第一个
 * 请求，并在 2 秒内复用结果——足够覆盖同一次面板刷新，又不至于让用户切换 run
 * 之后看到旧的会话归属。
 */
const TTL_MS = 2000;
const MAX_ENTRIES = 256;

interface LookupEntry {
  at: number;
  value: Promise<string | null>;
}

const entries = new Map<string, LookupEntry>();

function readSessionId(data: unknown): string | null {
  const run = (data as { run?: Record<string, unknown> } | null)?.run;
  const sessionId = run?.session_id ?? run?.sessionId;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
}

export function resolveRunSessionId(runId: string, headers: Record<string, string>): Promise<string | null> {
  const hit = entries.get(runId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  // 失败一律归一为 null：调用方已经拿着 404 在走回退链，这里再抛一次只会
  // 变成一个没人 await 的拒绝。
  const value = proxyJson(`/api/v1/runs/${runId}/orchestration`, { headers })
    .then((result) => (result.status >= 200 && result.status < 300 ? readSessionId(result.data) : null))
    .catch(() => null);

  // 先删后插：Map 的 set 对已存在的 key 不改变插入位置，直接覆盖会让刚被读到的
  // run 仍然留在淘汰队列的头部，先于真正闲置的条目被丢掉。
  entries.delete(runId);
  entries.set(runId, { at: Date.now(), value });
  // 有界淘汰：按插入顺序丢掉最旧的一条，避免活跃 run 的集合无限撑大这张表。
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
  return value;
}

/** 仅测试使用：让用例之间不共享 2 秒窗口。 */
export function resetRunSessionLookup(): void {
  entries.clear();
}
