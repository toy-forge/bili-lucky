import { md5 } from '../lib/md5';

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

interface ApiMessage {
  type: 'bili-lucky:api';
  path: string;
  params?: Record<string, string | number | boolean | undefined>;
  signed?: boolean;
  apiHost?: 'main' | 'vc';
}

interface NavResponse {
  code: number;
  message: string;
  data?: { wbi_img?: { img_url: string; sub_url: string } };
}

let cachedMixinKey: { value: string; expiresAt: number } | undefined;

function fileStem(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1, url.lastIndexOf('.'));
}

async function getMixinKey(): Promise<string> {
  if (cachedMixinKey && cachedMixinKey.expiresAt > Date.now()) return cachedMixinKey.value;
  const response = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    credentials: 'include',
  });
  const body = (await response.json()) as NavResponse;
  if (body.code !== 0 || !body.data?.wbi_img) {
    throw new Error(body.message || '无法取得 B 站 WBI 签名密钥');
  }
  const rawKey = fileStem(body.data.wbi_img.img_url) + fileStem(body.data.wbi_img.sub_url);
  const value = MIXIN_KEY_ENC_TAB.map((index) => rawKey[index] ?? '').join('').slice(0, 32);
  cachedMixinKey = { value, expiresAt: Date.now() + 30 * 60 * 1000 };
  return value;
}

function encodeWbi(value: unknown): string {
  return encodeURIComponent(String(value).replace(/[!'()*]/g, ''));
}

async function signParams(
  params: Record<string, string | number | boolean | undefined>,
): Promise<string> {
  const mixinKey = await getMixinKey();
  const values: Record<string, string | number | boolean | undefined> = {
    ...params,
    wts: Math.floor(Date.now() / 1000),
  };
  const entries = Object.entries(values)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  const query = entries.map(([key, value]) => `${encodeWbi(key)}=${encodeWbi(value)}`).join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

function plainParams(params: ApiMessage['params']): string {
  return Object.entries(params ?? {})
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

async function requestApi(message: ApiMessage): Promise<unknown> {
  if (!message.path.startsWith('/') || message.path.includes('://')) {
    throw new Error('拒绝访问非 B 站 API 路径');
  }
  const query = message.signed ? await signParams(message.params ?? {}) : plainParams(message.params);
  const apiOrigin = message.apiHost === 'vc'
    ? 'https://api.vc.bilibili.com'
    : 'https://api.bilibili.com';
  const url = `${apiOrigin}${message.path}${query ? `?${query}` : ''}`;
  const response = await fetch(url, {
    credentials: 'include',
    headers: { Accept: 'application/json, text/plain, */*' },
  });
  if (!response.ok) throw new Error(`B 站接口请求失败（HTTP ${response.status}）`);
  return response.json();
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown) => {
    if (!message || (message as ApiMessage).type !== 'bili-lucky:api') return undefined;
    return requestApi(message as ApiMessage).then(
      (data) => ({ ok: true, data }),
      (error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    );
  });
});
