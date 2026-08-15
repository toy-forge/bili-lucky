export interface Participant {
  mid: string;
  name: string;
  avatar: string;
  comments: string[];
}

export interface DynamicMeta {
  dynamicId: string;
  oid: string;
  type: number;
  authorMid?: string;
}

export interface CollectProgress {
  requests: number;
  comments: number;
  forwards: number;
  participants: number;
  totalHint?: number;
  phase: string;
}

type Params = Record<string, string | number | boolean | undefined>;
type ApiHost = 'main' | 'vc';

interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data: T;
}

interface BackgroundResponse<T> {
  ok: boolean;
  data?: ApiEnvelope<T>;
  error?: string;
}

interface RawReply {
  rpid?: number | string;
  rpid_str?: string;
  mid?: number | string;
  member?: { mid?: string; uname?: string; avatar?: string };
  content?: { message?: string };
  rcount?: number;
  replies?: RawReply[] | null;
}

interface ReplyPage {
  cursor?: {
    is_end?: boolean;
    all_count?: number;
    pagination_reply?: { next_offset?: string };
  };
  replies?: RawReply[] | null;
}

interface RawForward {
  desc?: {
    dynamic_id?: number | string;
    dynamic_id_str?: string;
    uid?: number | string;
    user_profile?: { info?: { uid?: number | string; uname?: string; face?: string } };
  };
  card?: string;
}

interface ForwardPage {
  has_more?: boolean | number;
  items?: RawForward[] | null;
}

export async function api<T>(
  path: string,
  params: Params = {},
  signed = false,
  apiHost: ApiHost = 'main',
): Promise<T> {
  const response = await browser.runtime.sendMessage({
    type: 'bili-lucky:api',
    path,
    params,
    signed,
    apiHost,
  }) as BackgroundResponse<T>;
  if (!response?.ok || !response.data) throw new Error(response?.error || '扩展后台无响应');
  if (response.data.code !== 0) {
    const loginHint = response.data.code === -101 ? '，请先登录 B 站' : '';
    throw new Error(`${response.data.message || 'B 站接口错误'}（${response.data.code}）${loginHint}`);
  }
  return response.data.data;
}

export async function getCurrentUser(): Promise<{ mid: string; name: string }> {
  const data = await api<{ isLogin?: boolean; mid?: number; uname?: string }>('/x/web-interface/nav');
  if (!data.isLogin || !data.mid) throw new Error('请先在当前浏览器登录 B 站账号');
  return { mid: String(data.mid), name: data.uname || '当前账号' };
}

export function dynamicIdFromLocation(): string {
  const match = location.pathname.match(/\/(?:opus\/)?(\d{10,})/);
  if (!match) throw new Error('当前不是 B 站动态详情页，请先打开一条动态');
  return match[1]!;
}

export async function getDynamicMeta(): Promise<DynamicMeta> {
  const dynamicId = dynamicIdFromLocation();
  const data = await api<{
    item?: {
      basic?: { comment_id_str?: string; comment_type?: number };
      modules?: { module_author?: { mid?: number } };
  }}>('/x/polymer/web-dynamic/v1/detail', { id: dynamicId });
  const basic = data.item?.basic;
  if (!basic?.comment_id_str || basic.comment_type === undefined) {
    throw new Error('没有找到这条动态对应的评论区，可能评论区已关闭');
  }
  return {
    dynamicId,
    oid: basic.comment_id_str,
    type: basic.comment_type,
    authorMid: data.item?.modules?.module_author?.mid
      ? String(data.item.modules.module_author.mid)
      : undefined,
  };
}

class RequestPacer {
  private first = true;
  requests = 0;

  constructor(private readonly baseDelayMs: number) {}

  async before(signal: AbortSignal): Promise<void> {
    if (this.first) {
      this.first = false;
    } else {
      const jitter = 0.8 + Math.random() * 0.4;
      await abortableDelay(Math.round(this.baseDelayMs * jitter), signal);
    }
    this.requests += 1;
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('已停止', 'AbortError'));
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(new DOMException('已停止', 'AbortError'));
    }, { once: true });
  });
}

function addReply(
  raw: RawReply,
  participants: Map<string, Participant>,
  seenReplies: Set<string>,
): number {
  const replyId = String(raw.rpid_str || raw.rpid || '');
  if (replyId && seenReplies.has(replyId)) return 0;
  if (replyId) seenReplies.add(replyId);
  const mid = String(raw.member?.mid || raw.mid || '');
  if (!mid || mid === '0') return 0;
  const message = raw.content?.message?.trim() || '（无文字评论）';
  const existing = participants.get(mid);
  if (existing) {
    if (!existing.comments.includes(message)) existing.comments.push(message);
  } else {
    participants.set(mid, {
      mid,
      name: raw.member?.uname || `用户 ${mid}`,
      avatar: raw.member?.avatar || '',
      comments: [message],
    });
  }
  return 1;
}

function addForward(raw: RawForward, participants: Map<string, Participant>): number {
  let card: { user?: { uid?: number | string; uname?: string; face?: string }; item?: { content?: string } } | undefined;
  try {
    card = raw.card ? JSON.parse(raw.card) : undefined;
  } catch {
    // Legacy card data can be malformed; desc.user_profile remains a usable fallback.
  }
  const info = raw.desc?.user_profile?.info;
  const mid = String(card?.user?.uid || info?.uid || raw.desc?.uid || '');
  if (!mid || mid === '0') return 0;
  const forwardText = `转发：${card?.item?.content?.trim() || '（无转发文案）'}`;
  const existing = participants.get(mid);
  if (existing) {
    if (!existing.comments.includes(forwardText)) existing.comments.push(forwardText);
  } else {
    participants.set(mid, {
      mid,
      name: card?.user?.uname || info?.uname || `用户 ${mid}`,
      avatar: card?.user?.face || info?.face || '',
      comments: [forwardText],
    });
  }
  return 1;
}

export async function collectParticipants(options: {
  meta: DynamicMeta;
  includeReplies: boolean;
  includeForwards: boolean;
  delayMs: number;
  signal: AbortSignal;
  onProgress: (progress: CollectProgress) => void;
}): Promise<{ participants: Participant[]; comments: number; requests: number; warning?: string }> {
  const { meta, includeReplies, includeForwards, signal, onProgress } = options;
  const pacer = new RequestPacer(options.delayMs);
  const participants = new Map<string, Participant>();
  const seenReplies = new Set<string>();
  let comments = 0;
  let forwards = 0;
  let offset = '';
  let totalHint: number | undefined;
  let warning: string | undefined;

  for (let page = 1; page <= 50_000; page += 1) {
    await pacer.before(signal);
    onProgress({ requests: pacer.requests, comments, forwards, participants: participants.size, totalHint, phase: `读取主评论第 ${page} 页` });
    const data = await api<ReplyPage>('/x/v2/reply/wbi/main', {
      oid: meta.oid,
      type: meta.type,
      mode: 2,
      pagination_str: JSON.stringify({ offset }),
      plat: 1,
      seek_rpid: '',
      web_location: 1315875,
    }, true);
    totalHint = data.cursor?.all_count ?? totalHint;
    const roots = data.replies ?? [];

    for (const root of roots) {
      comments += addReply(root, participants, seenReplies);
      const inline = root.replies ?? [];
      for (const child of inline) comments += addReply(child, participants, seenReplies);

      const rootId = String(root.rpid_str || root.rpid || '');
      const remaining = (root.rcount ?? 0) - inline.length;
      if (!includeReplies || !rootId || remaining <= 0) continue;

      try {
        for (let subPage = 1; subPage <= Math.ceil((root.rcount ?? 0) / 20); subPage += 1) {
          await pacer.before(signal);
          onProgress({ requests: pacer.requests, comments, forwards, participants: participants.size, totalHint, phase: `读取楼中楼第 ${subPage} 页` });
          const sub = await api<{ replies?: RawReply[] | null }>('/x/v2/reply/reply', {
            oid: meta.oid,
            type: meta.type,
            root: rootId,
            pn: subPage,
            ps: 20,
          });
          const replies = sub.replies ?? [];
          for (const child of replies) comments += addReply(child, participants, seenReplies);
          if (replies.length < 20) break;
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        warning = '部分楼中楼读取失败，已保留成功收集的数据';
      }
    }

    onProgress({ requests: pacer.requests, comments, forwards, participants: participants.size, totalHint, phase: '整理并去重' });
    if (data.cursor?.is_end || roots.length === 0) break;
    const nextOffset = data.cursor?.pagination_reply?.next_offset;
    if (!nextOffset || nextOffset === offset) {
      warning = warning || '分页游标没有继续更新，已在当前页安全停止';
      break;
    }
    offset = nextOffset;
  }

  if (includeForwards) {
    let forwardOffset = '';
    for (let page = 1; page <= 50_000; page += 1) {
      await pacer.before(signal);
      onProgress({ requests: pacer.requests, comments, forwards, participants: participants.size, totalHint, phase: `读取转发第 ${page} 页` });
      const data = await api<ForwardPage>(
        '/dynamic_repost/v1/dynamic_repost/repost_detail',
        { dynamic_id: meta.dynamicId, offset: forwardOffset || undefined },
        false,
        'vc',
      );
      const items = data.items ?? [];
      for (const item of items) forwards += addForward(item, participants);
      onProgress({ requests: pacer.requests, comments, forwards, participants: participants.size, totalHint, phase: '整理转发并去重' });
      if (!data.has_more || items.length === 0) break;
      const last = items.at(-1);
      const nextOffset = String(last?.desc?.dynamic_id_str || last?.desc?.dynamic_id || '');
      if (!nextOffset || nextOffset === forwardOffset) {
        warning = warning || '转发分页游标没有继续更新，已在当前页安全停止';
        break;
      }
      forwardOffset = nextOffset;
    }
  }

  return { participants: [...participants.values()], comments: comments + forwards, requests: pacer.requests, warning };
}

export async function followsCurrentUser(mid: string): Promise<boolean> {
  let data: { relation?: { attribute?: number } };
  try {
    data = await api('/x/space/wbi/acc/relation', { mid }, true);
  } catch {
    data = await api('/x/web-interface/relation', { mid });
  }
  const attribute = Number(data.relation?.attribute ?? 0);
  return (attribute & 2) === 2;
}

export function secureShuffle<T>(values: readonly T[]): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const limit = Math.floor(0x100000000 / (i + 1)) * (i + 1);
    const buffer = new Uint32Array(1);
    do crypto.getRandomValues(buffer); while (buffer[0]! >= limit);
    const j = buffer[0]! % (i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}
