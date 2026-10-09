import './content-style.css';
import {
  abortableDelay, collectParticipants, dynamicIdFromLocation, followsCurrentUser,
  getCurrentUser, getDynamicMeta, getUserStats, getDynamicCount, secureShuffle,
  type Participant, type ParticipationSource, type UserStats,
} from '../lib/bilibili';
import { parseRange, rejectionReason, type DrawRules } from '../lib/lottery';
import { avatar, element, interactions, template, winnerCard, type Winner } from '../lib/lottery-view';

const ROOT_ID = 'bili-lucky-root';
const sourceNames = { comments: '评论参与', forwards: '转发参与', both: '同时评论 + 转发' };

export default defineContentScript({
  matches: ['https://t.bilibili.com/*', 'https://www.bilibili.com/opus/*'],
  runAt: 'document_idle',
  main() {
    try { dynamicIdFromLocation(); } catch { return; }
    if (document.getElementById(ROOT_ID)) return;
    const root = element('div');
    root.id = ROOT_ID;
    root.innerHTML = template;
    document.body.append(root);
    const find = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
    const input = (id: string) => find<HTMLInputElement>(`#bl-${id}`);
    const backdrop = find<HTMLElement>('.bl-backdrop');
    const panel = find<HTMLElement>('.bl-panel');
    const fab = find<HTMLButtonElement>('.bl-fab');
    const tooltip = find<HTMLElement>('.bl-tooltip');
    const collectButton = find<HTMLButtonElement>('.bl-collect');
    const drawButton = find<HTMLButtonElement>('.bl-draw');
    const stopButton = find<HTMLButtonElement>('.bl-stop');
    const steps = [...root.querySelectorAll<HTMLButtonElement>('[data-step]')];
    const views = [...root.querySelectorAll<HTMLElement>('[data-view]')];
    const status = find<HTMLElement>('.bl-status');
    const detail = find<HTMLElement>('.bl-progress-detail');
    const errorBox = find<HTMLElement>('.bl-error');
    const sources = [...root.querySelectorAll<HTMLInputElement>('[name="bl-source"]')];
    const wall = find<HTMLElement>('.bl-wall');
    const search = find<HTMLInputElement>('.bl-search');
    const loadMore = find<HTMLButtonElement>('.bl-load-more');
    let participants: Participant[] = [];
    let filtered: Participant[] = [];
    let wallLimit = 240;
    let currentUser: { mid: string; name: string } | undefined;
    let collectedDynamic = '';
    let collectedSource: ParticipationSource = 'comments';
    let running = false;
    let hasCollection = false;
    let hasResults = false;
    let controller: AbortController | undefined;
    let previousFocus: HTMLElement | null = null;
    let hideTimer: number | undefined;

    const source = () => (sources.find((item) => item.checked)?.value || 'comments') as ParticipationSource;
    const setStatus = (title: string, message: string) => { status.textContent = title; detail.textContent = message; };
    const showError = (error: unknown) => { errorBox.textContent = error instanceof Error ? error.message : String(error); errorBox.hidden = false; };
    const clearError = () => { errorBox.hidden = true; errorBox.textContent = ''; };
    const hideTooltip = () => { tooltip.hidden = true; window.clearTimeout(hideTimer); };
    const syncControls = () => {
      root.querySelectorAll<HTMLInputElement>('.bl-sidebar input').forEach((item) => { item.disabled = running; });
      input('replies').disabled = running || source() === 'forwards';
      find<HTMLElement>('.bl-replies-option').hidden = source() === 'forwards';
      for (const key of ['following', 'fans', 'dynamics']) for (const bound of ['min', 'max']) input(`${key}-${bound}`).disabled = running || !input(key).checked;
      input('count').disabled = running;
      collectButton.disabled = running;
      collectButton.textContent = hasCollection ? '重新收集 ↻' : '开始收集 →';
      drawButton.textContent = hasResults ? '重新抽奖 ✦' : '开始抽奖 ✦';
      drawButton.disabled = running || !participants.length;
      stopButton.hidden = !running;
      steps.forEach((step) => { step.disabled = running || (step.dataset.step === 'wall' && !hasCollection) || (step.dataset.step === 'results' && !hasResults); });
      find<HTMLElement>('.bl-status-dot').classList.toggle('is-running', running);
    };
    const showView = (name: string) => {
      hideTooltip();
      panel.dataset.view = name;
      views.forEach((view) => { view.hidden = view.dataset.view !== name; });
      steps.forEach((step) => {
        if (step.dataset.step === (name === 'drawing' ? 'wall' : name)) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      });
      find<HTMLElement>('.bl-main').scrollTop = 0;
    };
    const open = () => {
      if (!backdrop.hidden) return;
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      backdrop.hidden = false;
      document.documentElement.classList.add('bl-modal-open');
      find<HTMLButtonElement>('.bl-close').focus();
    };
    const hide = () => {
      backdrop.hidden = true;
      hideTooltip();
      document.documentElement.classList.remove('bl-modal-open');
      previousFocus?.focus();
    };
    fab.addEventListener('click', open);
    find('.bl-close').addEventListener('click', hide);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop && !running) hide(); });
    document.addEventListener('keydown', (event) => {
      if (backdrop.hidden) return;
      if (event.key === 'Escape') { if (!tooltip.hidden) hideTooltip(); else hide(); }
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], summary')].filter((item) => item.getClientRects().length);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    });
    browser.runtime.onMessage.addListener((message: unknown) => {
      if ((message as { type?: string })?.type === 'bili-lucky:open') open();
      return undefined;
    });
    stopButton.addEventListener('click', () => { controller?.abort(); setStatus('正在停止', '等待当前请求结束，已确认的中奖者会保留。'); });
    steps.forEach((step) => step.addEventListener('click', () => showView(step.dataset.step!)));
    find('.bl-back-wall').addEventListener('click', () => showView('wall'));
    input('delay').addEventListener('input', () => { find<HTMLOutputElement>('#bl-delay-value').value = `${Number(input('delay').value) / 1000} 秒`; });
    ['following', 'fans', 'dynamics'].forEach((id) => input(id).addEventListener('change', syncControls));
    const invalidateCollection = () => {
      participants = []; hasCollection = false; hasResults = false;
      wall.replaceChildren(); hideTooltip();
      find<HTMLElement>('.bl-pool-count').textContent = '0';
      find<HTMLElement>('.bl-progress-count').textContent = '';
      showView('setup'); syncControls(); clearError();
      setStatus('规则已更新', '参与方式或楼中楼设置已改变，请重新收集。');
    };
    sources.forEach((item) => item.addEventListener('change', invalidateCollection));
    input('replies').addEventListener('change', invalidateCollection);

    function showPerson(person: Participant, anchor: HTMLElement) {
      window.clearTimeout(hideTimer);
      tooltip.replaceChildren();
      const heading = element('div', 'bl-tooltip-head');
      const name = element('strong'); name.textContent = person.name;
      const uid = element('small'); uid.textContent = `UID ${person.mid}`;
      heading.append(avatar(person), name, uid);
      tooltip.append(heading, interactions(person));
      tooltip.hidden = false;
      const rect = anchor.getBoundingClientRect();
      const width = tooltip.offsetWidth;
      const height = tooltip.offsetHeight;
      tooltip.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8))}px`;
      const below = rect.bottom + 8;
      tooltip.style.top = `${Math.max(8, below + height <= window.innerHeight - 8 ? below : rect.top - height - 8)}px`;
    }
    tooltip.id = 'bl-person-tooltip';
    tooltip.addEventListener('mouseenter', () => window.clearTimeout(hideTimer));
    tooltip.addEventListener('mouseleave', hideTooltip);
    const scheduleHide = () => { hideTimer = window.setTimeout(hideTooltip, 180); };
    wall.addEventListener('scroll', hideTooltip);
    find('.bl-main').addEventListener('scroll', hideTooltip);
    find('.bl-workspace').addEventListener('scroll', hideTooltip);
    window.addEventListener('resize', hideTooltip);
    function renderWall() {
      hideTooltip();
      wall.replaceChildren();
      for (const person of filtered.slice(0, wallLimit)) {
        const button = element('button', 'bl-person');
        button.type = 'button'; button.setAttribute('aria-controls', tooltip.id); button.setAttribute('aria-label', `查看 ${person.name} 的互动`);
        const name = element('span'); name.textContent = person.name;
        button.append(avatar(person), name);
        button.addEventListener('mouseenter', () => showPerson(person, button));
        button.addEventListener('focus', () => showPerson(person, button));
        button.addEventListener('click', () => showPerson(person, button));
        button.addEventListener('mouseleave', scheduleHide);
        button.addEventListener('blur', scheduleHide);
        wall.append(button);
      }
      find<HTMLElement>('.bl-wall-empty').hidden = filtered.length !== 0;
      loadMore.hidden = wallLimit >= filtered.length;
      find<HTMLElement>('.bl-wall-count').textContent = `已显示 ${Math.min(wallLimit, filtered.length).toLocaleString()} / ${filtered.length.toLocaleString()} 位候选人 · 每位用户一次机会`;
    }
    search.addEventListener('input', () => {
      const query = search.value.trim().toLocaleLowerCase();
      filtered = participants.filter((person) => person.name.toLocaleLowerCase().includes(query) || person.mid.includes(query));
      wallLimit = 240; renderWall();
    });
    loadMore.addEventListener('click', () => { wallLimit += 240; renderWall(); });

    collectButton.addEventListener('click', async () => {
      clearError(); hideTooltip();
      participants = []; hasCollection = false; hasResults = false;
      find('.bl-winner-grid').replaceChildren(); find('.bl-audit-list').replaceChildren();
      const selectedSource = source();
      controller = new AbortController();
      const signal = controller.signal;
      running = true; syncControls(); showView('setup');
      setStatus('正在连接 B 站', '确认当前登录账号与动态互动区…');
      find<HTMLElement>('.bl-progress-count').textContent = '';
      try {
        const [user, meta] = await Promise.all([getCurrentUser(), getDynamicMeta()]);
        signal.throwIfAborted(); currentUser = user;
        const collected = await collectParticipants({
          meta, source: selectedSource, includeReplies: input('replies').checked,
          delayMs: Number(input('delay').value), signal,
          onProgress(progress) {
            setStatus(progress.phase, `${progress.participants.toLocaleString()} 位已读取用户 · ${progress.requests} 次请求${selectedSource === 'both' ? ' · 收集完成后取交集' : ''}`);
            find<HTMLElement>('.bl-progress-count').textContent = `${progress.comments.toLocaleString()} 条评论 / ${progress.forwards.toLocaleString()} 次转发`;
          },
        });
        signal.throwIfAborted();
        if (dynamicIdFromLocation() !== meta.dynamicId) throw new Error('动态页面已切换，请在当前动态重新收集');
        participants = collected.participants.filter((person) => person.mid !== user.mid);
        collectedDynamic = meta.dynamicId; collectedSource = selectedSource; hasCollection = true;
        search.value = ''; filtered = participants; wallLimit = 240;
        find<HTMLElement>('.bl-pool-count').textContent = participants.length.toLocaleString();
        find<HTMLElement>('.bl-pool-source').textContent = sourceNames[selectedSource];
        find<HTMLElement>('.bl-progress-count').textContent = `${collected.comments.toLocaleString()} 条评论 / ${collected.forwards.toLocaleString()} 次转发`;
        setStatus('收集完成', `${participants.length.toLocaleString()} 位候选人 · 已排除 ${user.name}${collected.warning ? ` · ${collected.warning}` : ''}`);
        renderWall(); showView('wall');
        if (!participants.length) showError('没有符合参与方式的候选人，可以更改规则后重新收集。');
      } catch (error) {
        if (signal.aborted) setStatus('收集已停止', '本次数据未完整收集，请重新开始。');
        else { setStatus('收集失败', '请检查登录状态或稍后重试。'); showError(error); }
      } finally { running = false; syncControls(); }
    });

    function readRules(): DrawRules {
      return {
        requireFollower: input('followers').checked,
        following: input('following').checked ? parseRange(input('following-min').value, input('following-max').value, '关注数量') : undefined,
        followers: input('fans').checked ? parseRange(input('fans-min').value, input('fans-max').value, '粉丝数量') : undefined,
        dynamics: input('dynamics').checked ? parseRange(input('dynamics-min').value, input('dynamics-max').value, '动态数量') : undefined,
      };
    }
    function ruleSummary(rules: DrawRules) {
      const texts = [sourceNames[collectedSource], `动态 ${collectedDynamic}`];
      if (rules.requireFollower) texts.push(`关注 ${currentUser?.name}（UID ${currentUser?.mid}）`);
      if (rules.following) texts.push(`关注数量 ${rules.following.min ?? 0}–${rules.following.max ?? '不限'}`);
      if (rules.followers) texts.push(`粉丝数量 ${rules.followers.min ?? 0}–${rules.followers.max ?? '不限'}`);
      if (rules.dynamics) texts.push(`动态数量 ${rules.dynamics.min ?? 0}–${rules.dynamics.max ?? '不限'}`);
      return texts.join(' · ');
    }
    async function animate(pool: Participant[], signal: AbortSignal) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const frames = reduced ? 1 : 20;
      for (let i = 0; i < frames; i++) {
        signal.throwIfAborted();
        const person = pool[i % pool.length]!;
        find('.bl-rolling-avatar').replaceChildren(avatar(person));
        find<HTMLElement>('.bl-rolling-name').textContent = person.name;
        await abortableDelay(reduced ? 150 : 65 + i * 5, signal);
      }
    }
    drawButton.addEventListener('click', async () => {
      if (running) return;
      clearError();
      let rules: DrawRules;
      let wanted: number;
      try {
        if (dynamicIdFromLocation() !== collectedDynamic) throw new Error('动态页面已切换，请重新收集');
        wanted = Number(input('count').value);
        if (!Number.isInteger(wanted) || wanted < 1 || wanted > 100) throw new Error('中奖人数请输入 1–100 的整数');
        if (wanted > participants.length) throw new Error(`中奖人数不能超过候选人数（${participants.length}）`);
        rules = readRules();
        controller = new AbortController();
        running = true; syncControls();
        setStatus('正在确认账号', '确认当前登录账号与收集时一致…');
        const user = await getCurrentUser();
        controller.signal.throwIfAborted();
        if (user.mid !== currentUser?.mid) throw new Error('登录账号已改变，请重新收集后抽奖');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') setStatus('抽奖已停止', '尚未开始抽取候选人。');
        else showError(error);
        running = false; syncControls(); return;
      }
      controller = new AbortController();
      const signal = controller.signal;
      running = true; hasResults = false; syncControls(); showView('drawing');
      const pool = secureShuffle(participants);
      const winners: Winner[] = [];
      const grid = find<HTMLElement>('.bl-winner-grid'); grid.replaceChildren();
      const audit = find<HTMLElement>('.bl-audit-list'); audit.replaceChildren();
      let checked = 0; let rejected = 0; let completed = false; let requested = false;
      const pause = async () => {
        signal.throwIfAborted();
        if (requested) await abortableDelay(Number(input('delay').value) * (0.8 + Math.random() * 0.4), signal);
        requested = true;
      };
      const tally = () => {
        find<HTMLElement>('.bl-draw-tally').textContent = `已校验 ${checked} 位 · 淘汰 ${rejected} 位 · 中奖 ${winners.length} / ${wanted}`;
      };
      const record = (person: Participant, text: string) => {
        const row = element('li'); row.textContent = `${person.name}（UID ${person.mid}）· ${text}`; audit.append(row);
      };
      find<HTMLElement>('.bl-result-rules').textContent = ruleSummary(rules);
      find<HTMLElement>('.bl-rolling-detail').textContent = '每位候选人拥有相同机会'; tally();
      try {
        setStatus('正在随机抽取', `从 ${participants.length} 位候选人中抽取 ${wanted} 位中奖者`);
        await animate(pool, signal);
        for (const person of pool) {
          signal.throwIfAborted();
          find('.bl-rolling-avatar').replaceChildren(avatar(person));
          find<HTMLElement>('.bl-rolling-name').textContent = person.name;
          find<HTMLElement>('.bl-rolling-detail').textContent = '正在校验本次中奖资格…';
          setStatus(`正在校验 ${person.name}`, `已中奖 ${winners.length} / ${wanted} · 当前候选 UID ${person.mid}`);
          let follows: boolean | undefined;
          if (rules.requireFollower) {
            follows = await followsCurrentUser(person.mid, pause); signal.throwIfAborted();
            if (!follows) { checked++; rejected++; record(person, '未关注当前账号'); tally(); continue; }
          }
          let stats: UserStats = {}; let warning = '';
          try { stats = await getUserStats(person.mid, pause); signal.throwIfAborted(); }
          catch (error) {
            signal.throwIfAborted();
            if (rules.following || rules.followers) throw error;
            warning = '关注和粉丝数量读取失败';
          }
          const countReason = rejectionReason(stats, { ...rules, dynamics: undefined });
          if (countReason) { checked++; rejected++; record(person, countReason); tally(); continue; }
          try { await pause(); stats.dynamics = await getDynamicCount(person.mid); signal.throwIfAborted(); }
          catch (error) {
            signal.throwIfAborted();
            if (rules.dynamics) throw error;
            warning += `${warning ? '；' : ''}动态数量读取失败`;
          }
          const reason = rejectionReason(stats, rules);
          checked++;
          if (reason) { rejected++; record(person, reason); tally(); continue; }
          const winner = { person, stats, follows, warning };
          winners.push(winner); grid.append(winnerCard(winner, winners.length));
          record(person, '符合本次规则，确认中奖'); tally();
          find<HTMLElement>('.bl-rolling-detail').textContent = `✓ ${person.name} 已确认中奖`;
          await abortableDelay(350, signal);
          if (winners.length === wanted) { completed = true; break; }
        }
        if (!completed) showError(`候选池已耗尽：找到 ${winners.length} 位符合条件的用户，目标为 ${wanted} 位。`);
        setStatus(completed ? '抽奖完成' : '候选池已耗尽', `已校验 ${checked} 位 · 淘汰 ${rejected} 位 · 中奖 ${winners.length} 位`);
      } catch (error) {
        setStatus(signal.aborted ? '抽奖已停止' : '抽奖已暂停', `保留 ${winners.length} 位已确认中奖者 · ${checked} 位已完成校验`);
        if (!signal.aborted) showError(error);
      } finally {
        hasResults = true;
        find<HTMLElement>('.bl-result-title').textContent = completed ? '好运揭晓 ✦' : '本次已确认的中奖者';
        find<HTMLElement>('.bl-result-summary').textContent = `${winners.length} / ${wanted} 位中奖者 · 校验 ${checked} 位 · 淘汰 ${rejected} 位${completed ? '' : ' · 本次抽奖未完成；重新抽奖将开始新一轮'} · ${new Date().toLocaleString('zh-CN')}`;
        if (!winners.length) { const empty = element('p', 'bl-muted'); empty.textContent = '本次还没有确认中奖者。'; grid.append(empty); }
        running = false; syncControls(); showView('results');
      }
    });
    showView('setup'); syncControls();
  },
});
