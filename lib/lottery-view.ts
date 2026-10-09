import type { Participant, UserStats } from './bilibili';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

export function avatar(person: Participant, className = 'bl-avatar'): HTMLElement {
  const fallback = element('span', `${className} bl-avatar-fallback`);
  fallback.textContent = person.name.slice(0, 1) || '?';
  if (!person.avatar) return fallback;
  const image = element('img', className);
  image.src = person.avatar.replace(/^http:/, 'https:');
  image.alt = '';
  image.loading = 'lazy';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => image.replaceWith(fallback), { once: true });
  return image;
}

export function interactions(person: Participant): HTMLElement {
  const container = element('div', 'bl-interactions');
  for (const [label, messages] of [['评论', person.comments], ['转发', person.forwards]] as const) {
    if (!messages.length) continue;
    const heading = element('h4');
    heading.textContent = `${label} · ${messages.length}`;
    container.append(heading);
    for (const message of messages) {
      const paragraph = element('p');
      paragraph.textContent = message;
      container.append(paragraph);
    }
  }
  return container;
}

export interface Winner { person: Participant; stats: UserStats; follows?: boolean; warning?: string }

export function winnerCard(winner: Winner, rank: number): HTMLElement {
  const { person, stats } = winner;
  const card = element('article', 'bl-winner-card');
  const head = element('div', 'bl-winner-head');
  const identity = element('div');
  const name = element('a');
  name.textContent = person.name;
  name.href = `https://space.bilibili.com/${person.mid}`;
  name.target = '_blank';
  name.rel = 'noopener noreferrer';
  const uid = element('p');
  uid.textContent = `UID ${person.mid}`;
  identity.append(name, uid);
  const badge = element('span', 'bl-rank');
  badge.textContent = `#${String(rank).padStart(2, '0')}`;
  head.append(avatar(person), identity, badge);
  const numbers = element('dl', 'bl-stats');
  for (const [label, value] of [['关注', stats.following], ['粉丝', stats.followers], ['动态', stats.dynamics]] as const) {
    const item = element('div');
    const title = element('dt');
    title.textContent = label;
    const count = element('dd');
    count.textContent = value === undefined ? '暂不可用' : value.toLocaleString();
    item.append(count, title);
    numbers.append(item);
  }
  const relation = element('p', 'bl-verification');
  relation.textContent = winner.follows ? '✓ 已确认关注当前登录账号' : '关注关系未校验';
  card.append(head, numbers, relation, interactions(person));
  if (winner.warning) {
    const warning = element('p', 'bl-muted');
    warning.textContent = winner.warning;
    card.append(warning);
  }
  return card;
}

const range = (id: string, label: string) => `<div class="bl-range-filter"><label class="bl-toggle"><span>${label}</span><input id="bl-${id}" type="checkbox"></label><div class="bl-range-inputs"><input id="bl-${id}-min" type="number" min="0" step="1" placeholder="不限" aria-label="${label}下限" disabled><span>至</span><input id="bl-${id}-max" type="number" min="0" step="1" placeholder="不限" aria-label="${label}上限" disabled></div></div>`;

export const template = `
<button class="bl-fab" type="button"><span>✦</span> 动态抽奖</button>
<div class="bl-backdrop" hidden>
<section class="bl-panel" role="dialog" aria-modal="true" aria-labelledby="bl-title" tabindex="-1">
<header class="bl-header"><div class="bl-brand"><span class="bl-logo">✦</span><div><h2 id="bl-title">Bili Lucky<span>动态抽奖工作台</span></h2></div></div><button class="bl-close" type="button" aria-label="关闭抽奖面板">×</button></header>
<nav class="bl-steps" aria-label="抽奖流程"><button data-step="setup" aria-current="step"><b>01</b> 设置规则</button><span>—</span><button data-step="wall" disabled><b>02</b> 候选人照片墙</button><span>—</span><button data-step="results" disabled><b>03</b> 中奖结果</button></nav>
<div class="bl-workspace">
<aside class="bl-sidebar">
<div class="bl-sidebar-heading"><span class="bl-eyebrow">LOTTERY RULES</span><h3>每一份好运，都有依据。</h3><p>按 UID 去重，每位用户拥有一次机会。自动排除当前登录账号。</p></div>
<fieldset class="bl-source"><legend>参与方式</legend><label><input type="radio" name="bl-source" value="comments" checked><span><b>评论参与</b><small>发表过评论的用户</small></span></label><label><input type="radio" name="bl-source" value="forwards"><span><b>转发参与</b><small>转发过这条动态的用户</small></span></label><label><input type="radio" name="bl-source" value="both"><span><b>同时评论 + 转发</b><small>两种互动都完成才可参与</small></span></label></fieldset>
<label class="bl-toggle bl-replies-option"><span>包含楼中楼回复</span><input id="bl-replies" type="checkbox" checked></label>
<div class="bl-filter-heading"><h4>中奖资格</h4><span>抽中后校验</span></div>
<label class="bl-toggle"><span>必须关注我</span><input id="bl-followers" type="checkbox"></label>
${range('following', '关注数量')}${range('fans', '粉丝数量')}${range('dynamics', '动态数量')}
<p class="bl-rule-hint">不符合条件会继续抽取。关注关系以当前登录账号为准。</p>
<div class="bl-delay"><label for="bl-delay">请求间隔 <output id="bl-delay-value">3 秒</output></label><input id="bl-delay" type="range" min="1500" max="8000" step="500" value="3000"></div>
</aside>
<main class="bl-main">
<section data-view="setup" class="bl-setup"><span class="bl-eyebrow">LET THE LUCK BEGIN</span><h1>让下一份好运<br>找到它的主人<span>✦</span></h1><p>从一条动态开始，把每一次互动<br>变成公平的中奖机会。</p><div class="bl-art" aria-hidden="true"><span>✦</span><span>☺</span><span>✦</span></div><div class="bl-setup-note"><b>先收集，再抽奖</b><p>收集完成后可浏览所有候选人的头像和互动。<br>资格校验只针对随机抽中的用户。</p></div></section>
<section data-view="wall" hidden><div class="bl-view-heading"><div><span class="bl-eyebrow">THE LUCKY CROWD</span><h1>好运候选人 <span class="bl-pool-count">0</span></h1><p>悬浮或点击头像，查看 TA 的评论与转发。</p></div><span class="bl-pool-source"></span></div><label class="bl-search-label"><span>搜索候选人</span><input class="bl-search" type="search" placeholder="昵称 / UID" aria-label="搜索候选人昵称或 UID"></label><div class="bl-wall"></div><p class="bl-wall-empty" hidden>没有匹配的候选人</p><button class="bl-load-more bl-button" type="button" hidden>加载更多头像</button><p class="bl-wall-count bl-muted"></p></section>
<section data-view="drawing" hidden class="bl-drawing"><span class="bl-eyebrow">A LITTLE MOMENT OF MAGIC</span><h1>好运正在靠近…</h1><p>随机抽取 · 逐位校验</p><div class="bl-draw-stage"><div class="bl-rolling-avatar"></div><strong class="bl-rolling-name">准备开始</strong><span class="bl-rolling-detail">每位候选人拥有相同机会</span></div><div class="bl-draw-tally"></div></section>
<section data-view="results" hidden><div class="bl-view-heading"><div><span class="bl-eyebrow">MEET THE LUCKY ONES</span><h1 class="bl-result-title">好运揭晓 ✦</h1><p class="bl-result-summary"></p></div><button class="bl-button bl-back-wall" type="button">返回照片墙</button></div><p class="bl-result-rules"></p><div class="bl-winner-grid"></div><details class="bl-audit"><summary>查看资格校验记录</summary><ol class="bl-audit-list"></ol></details></section>
</main>
</div>
<div class="bl-status-area" role="status" aria-live="polite"><span class="bl-status-dot"></span><div><b class="bl-status">等待开始</b><p class="bl-progress-detail">选择参与方式，开始收集这条动态的互动。</p></div><span class="bl-progress-count"></span></div>
<div class="bl-error" role="alert" hidden></div>
<footer class="bl-footer"><button class="bl-button bl-collect" type="button">开始收集 <span>→</span></button><button class="bl-button bl-stop" type="button" hidden>停止</button><div class="bl-draw-group"><label for="bl-count">中奖人数</label><input id="bl-count" type="number" min="1" max="100" step="1" value="1"><button class="bl-button bl-primary bl-draw" type="button" disabled>开始抽奖 ✦</button></div></footer>
<div class="bl-tooltip" role="dialog" aria-label="候选人互动" hidden></div></section>
</div>`;
