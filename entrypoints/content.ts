import './content-style.css';
import {
  collectParticipants,
  dynamicIdFromLocation,
  followsCurrentUser,
  getCurrentUser,
  getDynamicMeta,
  secureShuffle,
  type DynamicMeta,
  type Participant,
} from '../lib/bilibili';

const ROOT_ID = 'bili-lucky-root';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export default defineContentScript({
  matches: ['https://t.bilibili.com/*', 'https://www.bilibili.com/opus/*'],
  runAt: 'document_idle',
  main() {
    try {
      dynamicIdFromLocation();
    } catch {
      return;
    }
    if (document.getElementById(ROOT_ID)) return;
    const root = element('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <button class="bl-fab" type="button" aria-label="打开动态抽奖"><span class="bl-fab-spark">✦</span><span>评论抽奖</span></button>
      <div class="bl-backdrop" hidden>
        <section class="bl-panel" role="dialog" aria-modal="true" aria-labelledby="bl-title">
          <header class="bl-header">
            <div class="bl-brand"><span class="bl-logo">✦</span><div><h2 id="bl-title">Bili Lucky</h2><p>动态互动抽奖</p></div></div>
            <button class="bl-icon-button bl-close" type="button" aria-label="关闭">×</button>
          </header>
          <main class="bl-body">
            <section class="bl-hero">
              <div><span class="bl-eyebrow">CURRENT DYNAMIC</span><h3>动态互动抽奖</h3><p>自动去重 · 可验证关注</p></div>
              <div class="bl-orb"><span class="bl-orb-number">0</span><span>候选用户</span></div>
            </section>
            <section class="bl-controls">
              <div class="bl-setting bl-source-setting"><span class="bl-setting-label">参与</span><div class="bl-mode-switch" role="radiogroup"><label class="bl-mode-choice"><input type="radio" name="bl-source" value="comments" checked><span>评论</span></label><label class="bl-mode-choice"><input type="radio" name="bl-source" value="forwards"><span>转发</span></label></div></div>
              <i class="bl-setting-divider bl-replies-divider" aria-hidden="true"></i>
              <label class="bl-setting bl-toggle-setting bl-replies-option"><span class="bl-setting-label">楼中楼</span><span class="bl-check-control"><input id="bl-replies" type="checkbox" checked><span class="bl-check-ui"></span></span></label>
              <i class="bl-setting-divider" aria-hidden="true"></i>
              <label class="bl-setting bl-toggle-setting"><span class="bl-setting-label">只抽关注者</span><span class="bl-check-control"><input id="bl-followers" type="checkbox" checked><span class="bl-check-ui"></span></span></label>
              <i class="bl-setting-divider" aria-hidden="true"></i>
              <div class="bl-setting bl-delay-setting"><label class="bl-setting-label" for="bl-delay">间隔</label><div class="bl-range-row"><input id="bl-delay" type="range" min="1500" max="8000" step="500" value="3000"><output id="bl-delay-value">3 秒</output></div></div>
            </section>
            <section class="bl-progress-card">
              <div class="bl-progress-top"><div><span class="bl-status-dot"></span><b class="bl-status">等待开始</b></div><span class="bl-progress-count">0 条互动</span></div>
              <div class="bl-progress-track"><span></span></div>
              <p class="bl-progress-detail">打开动态后，点击“开始收集”</p>
            </section>
            <section class="bl-actions">
              <button class="bl-button bl-primary bl-collect" type="button"><span>⌁</span> 开始收集</button>
              <button class="bl-button bl-stop" type="button" hidden>停止</button>
              <div class="bl-draw-group"><label for="bl-count">中奖人数</label><input id="bl-count" type="number" min="1" max="100" value="1"><button class="bl-button bl-draw" type="button" disabled>开始抽奖 <span>→</span></button></div>
            </section>
            <section class="bl-results" hidden><div class="bl-results-heading"><div><span class="bl-eyebrow">WINNERS</span><h3>恭喜中奖</h3></div><span class="bl-checked"></span></div><div class="bl-winner-grid"></div></section>
            <div class="bl-error" hidden></div>
          </main>
          <footer class="bl-footer"><span>仅在本机处理</span><span>安全随机 · MID 去重</span></footer>
        </section>
      </div>`;
    document.documentElement.append(root);

    const find = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
    const backdrop = find<HTMLElement>('.bl-backdrop');
    const fab = find<HTMLButtonElement>('.bl-fab');
    const close = find<HTMLButtonElement>('.bl-close');
    const delay = find<HTMLInputElement>('#bl-delay');
    const delayValue = find<HTMLOutputElement>('#bl-delay-value');
    const includeReplies = find<HTMLInputElement>('#bl-replies');
    const followersOnly = find<HTMLInputElement>('#bl-followers');
    const sourceInputs = [...root.querySelectorAll<HTMLInputElement>('input[name="bl-source"]')];
    const repliesOption = find<HTMLElement>('.bl-replies-option');
    const repliesDivider = find<HTMLElement>('.bl-replies-divider');
    const collectButton = find<HTMLButtonElement>('.bl-collect');
    const stopButton = find<HTMLButtonElement>('.bl-stop');
    const drawButton = find<HTMLButtonElement>('.bl-draw');
    const countInput = find<HTMLInputElement>('#bl-count');
    const status = find<HTMLElement>('.bl-status');
    const statusDot = find<HTMLElement>('.bl-status-dot');
    const progressCount = find<HTMLElement>('.bl-progress-count');
    const progressDetail = find<HTMLElement>('.bl-progress-detail');
    const progressBar = find<HTMLElement>('.bl-progress-track span');
    const orbNumber = find<HTMLElement>('.bl-orb-number');
    const results = find<HTMLElement>('.bl-results');
    const winnerGrid = find<HTMLElement>('.bl-winner-grid');
    const checked = find<HTMLElement>('.bl-checked');
    const errorBox = find<HTMLElement>('.bl-error');

    let participants: Participant[] = [];
    let currentUser: { mid: string; name: string } | undefined;
    let meta: DynamicMeta | undefined;
    let controller: AbortController | undefined;
    let running = false;

    const open = () => { backdrop.hidden = false; document.documentElement.classList.add('bl-modal-open'); };
    const hide = () => { backdrop.hidden = true; document.documentElement.classList.remove('bl-modal-open'); };
    const showError = (message: string) => { errorBox.textContent = message; errorBox.hidden = false; };
    const clearError = () => { errorBox.hidden = true; errorBox.textContent = ''; };
    const setRunning = (value: boolean) => {
      running = value;
      collectButton.disabled = value;
      delay.disabled = value;
      const commentsSelected = sourceInputs.some((input) => input.checked && input.value === 'comments');
      includeReplies.disabled = value || !commentsSelected;
      followersOnly.disabled = value;
      sourceInputs.forEach((input) => { input.disabled = value; });
      stopButton.hidden = !value;
      statusDot.classList.toggle('is-running', value);
    };

    delay.addEventListener('input', () => {
      delayValue.value = `${(Number(delay.value) / 1000).toFixed(1).replace('.0', '')} 秒`;
    });
    const syncSourceControls = () => {
      const commentsSelected = sourceInputs.some((input) => input.checked && input.value === 'comments');
      repliesOption.hidden = !commentsSelected;
      repliesDivider.hidden = !commentsSelected;
      includeReplies.disabled = running || !commentsSelected;
    };
    sourceInputs.forEach((input) => input.addEventListener('change', syncSourceControls));
    syncSourceControls();
    fab.addEventListener('click', open);
    close.addEventListener('click', hide);
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop && !running) hide(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !running) hide(); });
    browser.runtime.onMessage.addListener((message: unknown) => {
      if ((message as { type?: string })?.type === 'bili-lucky:open') open();
      return undefined;
    });
    stopButton.addEventListener('click', () => controller?.abort());

    collectButton.addEventListener('click', async () => {
      open();
      clearError();
      results.hidden = true;
      winnerGrid.replaceChildren();
      participants = [];
      orbNumber.textContent = '0';
      drawButton.disabled = true;
      controller = new AbortController();
      setRunning(true);
      statusDot.classList.remove('is-done');
      status.textContent = '正在连接 B 站';
      progressDetail.textContent = '确认登录账号与动态互动区…';
      progressBar.style.width = '4%';
      try {
        [currentUser, meta] = await Promise.all([getCurrentUser(), getDynamicMeta()]);
        const collected = await collectParticipants({
          meta,
          includeReplies: sourceInputs.some((input) => input.checked && input.value === 'comments') && includeReplies.checked,
          includeForwards: sourceInputs.some((input) => input.checked && input.value === 'forwards'),
          delayMs: Number(delay.value),
          signal: controller.signal,
          onProgress: (progress) => {
            status.textContent = progress.phase;
            progressCount.textContent = `${progress.comments.toLocaleString()} 条评论 · ${progress.forwards.toLocaleString()} 次转发`;
            progressDetail.textContent = `${progress.participants.toLocaleString()} 位去重用户 · ${progress.requests} 次请求`;
            orbNumber.textContent = progress.participants.toLocaleString();
            const ratio = progress.totalHint ? Math.min(progress.comments / progress.totalHint, 0.96) : Math.min(0.12 + progress.requests * 0.015, 0.9);
            progressBar.style.width = `${Math.round(ratio * 100)}%`;
          },
        });
        participants = collected.participants.filter((item) => item.mid !== currentUser!.mid);
        orbNumber.textContent = participants.length.toLocaleString();
        status.textContent = '收集完成';
        statusDot.classList.add('is-done');
        progressCount.textContent = `${collected.comments.toLocaleString()} 条互动`;
        progressDetail.textContent = `${participants.length.toLocaleString()} 位候选用户 · ${collected.requests} 次请求${collected.warning ? ` · ${collected.warning}` : ''}`;
        progressBar.style.width = '100%';
        drawButton.disabled = participants.length === 0;
      } catch (error) {
        if (isAbort(error)) {
          status.textContent = '已停止';
          progressDetail.textContent = '本次未完成，点击“开始收集”可重新开始';
        } else {
          status.textContent = '收集失败';
          showError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setRunning(false);
      }
    });

    drawButton.addEventListener('click', async () => {
      clearError();
      const wanted = Math.max(1, Math.min(100, Number.parseInt(countInput.value, 10) || 1));
      countInput.value = String(wanted);
      if (wanted > participants.length) {
        showError(`中奖人数不能超过候选用户数（${participants.length}）`);
        return;
      }
      controller = new AbortController();
      setRunning(true);
      statusDot.classList.remove('is-done');
      drawButton.disabled = true;
      results.hidden = true;
      winnerGrid.replaceChildren();
      const requireFollower = followersOnly.checked;
      status.textContent = requireFollower ? '正在抽取并验证关注' : '正在随机抽取';
      progressBar.style.width = '12%';
      const pool = secureShuffle(participants);
      const winners: Participant[] = [];
      let rejected = 0;
      let checkedCount = 0;
      try {
        if (requireFollower) {
          for (const candidate of pool) {
            if (controller.signal.aborted) throw new DOMException('已停止', 'AbortError');
            status.textContent = `验证候选：${candidate.name}`;
            progressDetail.textContent = `已验证 ${checkedCount} 人 · ${rejected} 人未关注 · 已中奖 ${winners.length}/${wanted}`;
            const follows = await followsCurrentUser(candidate.mid);
            checkedCount += 1;
            if (follows) winners.push(candidate); else rejected += 1;
            progressBar.style.width = `${Math.min(95, 12 + Math.round((winners.length / wanted) * 83))}%`;
            if (winners.length >= wanted) break;
            await abortablePause(Number(delay.value) * (0.8 + Math.random() * 0.4), controller.signal);
          }
        } else {
          winners.push(...pool.slice(0, wanted));
        }
        if (winners.length < wanted) throw new Error(`候选池已全部验证，只找到 ${winners.length} 位关注者，未达到 ${wanted} 人`);
        winners.forEach((winner, index) => winnerGrid.append(createWinnerCard(winner, index + 1, requireFollower)));
        checked.textContent = requireFollower ? `验证 ${checkedCount} 人 · 淘汰 ${rejected} 人` : '随机抽取 · 未验证关注关系';
        results.hidden = false;
        status.textContent = '抽奖完成';
        statusDot.classList.add('is-done');
        progressDetail.textContent = requireFollower
          ? `${wanted} 位中奖者均已确认关注当前账号（${currentUser?.name || ''}）`
          : `${wanted} 位中奖者已从去重候选池中随机选出（已自动排除当前账号）`;
        progressBar.style.width = '100%';
        results.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } catch (error) {
        if (isAbort(error)) status.textContent = '已停止';
        else {
          status.textContent = '抽奖未完成';
          showError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        setRunning(false);
        drawButton.disabled = participants.length === 0;
      }
    });

    function abortablePause(ms: number, signal: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException('已停止', 'AbortError'));
          return;
        }
        const timer = window.setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
          window.clearTimeout(timer);
          reject(new DOMException('已停止', 'AbortError'));
        }, { once: true });
      });
    }

    function createWinnerCard(winner: Participant, rank: number, verifiedFollower: boolean): HTMLElement {
      const card = element('article', 'bl-winner-card');
      const badge = element('span', 'bl-rank');
      badge.textContent = String(rank).padStart(2, '0');
      const avatar = element('img', 'bl-avatar');
      avatar.src = winner.avatar.replace(/^http:/, 'https:');
      avatar.alt = winner.name;
      avatar.referrerPolicy = 'no-referrer';
      const body = element('div', 'bl-winner-body');
      const name = element('a', 'bl-winner-name');
      name.textContent = winner.name;
      name.href = `https://space.bilibili.com/${winner.mid}`;
      name.target = '_blank';
      name.rel = 'noopener noreferrer';
      const relation = element('span', 'bl-follow-badge');
      relation.textContent = verifiedFollower ? '✓ 已关注你' : '✓ 已参与抽奖';
      const comment = element('p', 'bl-comment');
      comment.textContent = `“${winner.comments[0]}”`;
      const more = element('small', 'bl-comment-count');
      more.textContent = winner.comments.length > 1 ? `该用户共 ${winner.comments.length} 条不同互动` : `UID ${winner.mid}`;
      body.append(name, relation, comment, more);
      card.append(badge, avatar, body);
      return card;
    }
  },
});
