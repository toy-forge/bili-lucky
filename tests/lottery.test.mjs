import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// Load pure TypeScript modules without a test-only runtime dependency.
async function load(path) {
  const code = stripTypeScriptTypes(await readFile(new URL(path, import.meta.url), 'utf8'), { mode: 'strip', disableExperimentalWarning: true });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const bili = await load('../lib/bilibili.ts');
const { parseRange, rejectionReason } = await load('../lib/lottery.ts');
globalThis.window = globalThis;
const person = (mid, comments = [], forwards = []) => ({ mid, name: `用户 ${mid}`, avatar: '', comments, forwards });

// API tests intentionally run serially because the extension bridge is shared.
function bridge(respond) {
  const requests = [];
  globalThis.browser = { runtime: { async sendMessage(message) {
    requests.push(message);
    return { ok: true, data: { code: 0, data: respond(message) } };
  } } };
  return requests;
}
const meta = { dynamicId: '1234567890123', oid: '456', type: 17 };
const reply = (mid, text, extra = {}) => ({ rpid: mid, member: { mid: String(mid), uname: `用户 ${mid}` }, content: { message: text }, ...extra });
const forward = (mid) => ({ desc: { dynamic_id_str: `${mid}`, uid: mid }, card: JSON.stringify({ user: { uid: mid }, item: { content: '转发内容' } }) });
const collect = (source, includeReplies = false, signal = new AbortController().signal) => bili.collectParticipants({ meta, source, includeReplies, delayMs: 0, signal, onProgress() {} });

test('participation sources use intersection for both, and keep interactions separate', () => {
  const pool = [person('1', ['评论']), person('2', [], ['转发']), person('3', ['评论'], ['转发'])];
  assert.deepEqual(bili.filterParticipants(pool, 'comments').map(p => p.mid), ['1', '3']);
  assert.deepEqual(bili.filterParticipants(pool, 'forwards').map(p => p.mid), ['2', '3']);
  assert.deepEqual(bili.filterParticipants(pool, 'both').map(p => p.mid), ['3']);
});

test('range validation rejects decimals, negatives, inverted and empty enabled ranges', () => {
  for (const [min, max] of [['-1', ''], ['1.5', ''], ['20', '10'], ['', ''], ['x', ''], ['Infinity', '']]) assert.throws(() => parseRange(min, max, '关注数量'));
  assert.deepEqual(parseRange('0', '0', '关注数量'), { min: 0, max: 0 });
  assert.deepEqual(parseRange('', '50', '粉丝数量'), { min: undefined, max: 50 });
});

test('qualification checks inclusive bounds and never treats missing counts as zero', () => {
  const rules = { requireFollower: false, following: { min: 10, max: 20 }, followers: { max: 0 } };
  assert.equal(rejectionReason({ following: 10, followers: 0 }, rules), undefined);
  assert.equal(rejectionReason({ following: 20, followers: 0 }, rules), undefined);
  assert.match(rejectionReason({ following: 21, followers: 0 }, rules), /关注数量/);
  assert.match(rejectionReason({ following: 10, followers: 1 }, rules), /粉丝数量/);
  assert.throws(() => rejectionReason({ followers: 0 }, rules), /无法获取/);
});

test('forwards-only never calls comment APIs', async () => {
  const requests = bridge(() => ({ items: [forward(2)], has_more: false }));
  const result = await collect('forwards');
  assert.equal(requests.length, 1);
  assert.match(requests[0].path, /repost_detail/);
  assert.equal(result.comments, 0);
  assert.equal(result.forwards, 1);
  assert.deepEqual(result.participants[0].comments, []);
  assert.deepEqual(result.participants[0].forwards, ['转发内容']);
});

test('disabling nested replies excludes inline children and nested API requests', async () => {
  const requests = bridge(() => ({ cursor: { is_end: true }, replies: [reply(1, '主评论', { rcount: 1, replies: [reply(2, '楼中楼')] })] }));
  const result = await collect('comments');
  assert.deepEqual(result.participants.map(p => p.mid), ['1']);
  assert.equal(result.comments, 1);
  assert.equal(requests.length, 1);
});

test('both collects both sources, deduplicates users and takes intersection', async () => {
  bridge(message => message.path.includes('repost_detail')
    ? { items: [forward(1), forward(3)], has_more: false }
    : { cursor: { is_end: true }, replies: [reply(1, '一条评论', { rcount: 1, replies: [reply(2, '楼中楼')] }), reply(11, '另一条评论', { member: { mid: '1' } })] });
  const result = await collect('both', true);
  assert.deepEqual(result.participants.map(p => p.mid), ['1']);
  assert.equal(result.participants[0].comments.length, 2);
  assert.equal(result.participants[0].forwards.length, 1);
  assert.equal(result.comments, 3);
  assert.equal(result.forwards, 2);
});

test('stopping during in-flight collection discards late API response', async () => {
  const controller = new AbortController();
  bridge(() => { controller.abort(); return { cursor: { is_end: true }, replies: [reply(1, '评论')] }; });
  await assert.rejects(collect('comments', false, controller.signal), { name: 'AbortError' });
});

test('following verification reads target-to-current-account relation', async () => {
  bridge(() => ({ relation: { attribute: 2 }, be_relation: { attribute: 0 } }));
  assert.equal(await bili.followsCurrentUser('1'), false);
  bridge(() => ({ relation: { attribute: 0 }, be_relation: { attribute: 6 } }));
  assert.equal(await bili.followsCurrentUser('1'), true);
  bridge(() => ({ relation: { attribute: 2 } }));
  await assert.rejects(bili.followsCurrentUser('1'), /未返回有效数据/);
});

test('secure shuffle keeps every participant once and leaves input intact', () => {
  const pool = Array.from({ length: 100 }, (_, i) => i);
  const result = bili.secureShuffle(pool);
  assert.notEqual(result, pool);
  assert.deepEqual([...result].sort((a, b) => a - b), pool);
  assert.deepEqual(pool, Array.from({ length: 100 }, (_, i) => i));
});


test('closed comment sections still allow forward collection', async () => {
  bridge(() => ({ items: [forward(2)], has_more: false }));
  const options = { meta: { dynamicId: meta.dynamicId }, includeReplies: false, delayMs: 0, signal: new AbortController().signal, onProgress() {} };
  const result = await bili.collectParticipants({ ...options, source: 'forwards' });
  assert.equal(result.participants.length, 1);
  await assert.rejects(bili.collectParticipants({ ...options, source: 'both' }), /评论区已关闭/);
});


test('dynamic count filter includes boundaries, rejects out-of-range users and pauses on unknown counts', () => {
  const rules = { requireFollower: false, dynamics: { min: 5, max: 10 } };
  assert.equal(rejectionReason({ dynamics: 5 }, rules), undefined);
  assert.equal(rejectionReason({ dynamics: 10 }, rules), undefined);
  assert.match(rejectionReason({ dynamics: 4 }, rules), /动态数量/);
  assert.match(rejectionReason({ dynamics: 11 }, rules), /动态数量/);
  assert.throws(() => rejectionReason({}, rules), /无法获取动态数量/);
  assert.equal(rejectionReason({}, { requireFollower: false }), undefined);
  assert.equal(rejectionReason({ dynamics: 0 }, { requireFollower: false, dynamics: { max: 0 } }), undefined);
});

test('dynamic count API preserves zero and rejects missing or malformed counts', async () => {
  for (const value of [0, 42, undefined, -1, '42', 1.5]) {
    const requests = bridge(() => ({ dynamic: value }));
    assert.equal(await bili.getDynamicCount('123'), typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined);
    assert.equal(requests[0].path, '/x/space/navnum');
    assert.equal(requests[0].params.mid, '123');
  }
});
