import './popup.css';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header><span class="mark">✦</span><div><h1>Bili Lucky</h1><p>动态评论 · 关注者抽奖</p></div></header>
  <main>
    <div class="step"><b>1</b><span>打开任意 B 站动态详情页</span></div>
    <div class="step"><b>2</b><span>低频收集、去重并开始抽奖</span></div>
    <button id="open" type="button">在当前动态中打开 <span>→</span></button>
    <p id="hint">需要先登录 B 站账号</p>
  </main>
`;

const button = document.querySelector<HTMLButtonElement>('#open')!;
const hint = document.querySelector<HTMLParagraphElement>('#hint')!;
button.addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const isDynamicDetail = Boolean(tab?.url && (
    /^https:\/\/t\.bilibili\.com\/\d+/.test(tab.url)
    || /^https:\/\/www\.bilibili\.com\/opus\/\d+/.test(tab.url)
  ));
  if (!tab?.id || !isDynamicDetail) {
    hint.textContent = '请先打开一条 B 站动态详情页';
    hint.classList.add('error');
    return;
  }
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'bili-lucky:open' });
    window.close();
  } catch {
    hint.textContent = '请刷新动态页面后再试';
    hint.classList.add('error');
  }
});
