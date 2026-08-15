import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: 'dist',
  manifest: {
    name: 'Bili Lucky · 动态评论抽奖',
    description: '低频收集 B 站动态评论，去重并从关注者中公平抽奖。',
    version: '1.0.0',
    permissions: ['activeTab'],
    host_permissions: ['https://*.bilibili.com/*'],
  },
});
