'use strict';
// 标签页在后台时不轮询:没人看的状态没必要每 5 秒打一次 /api/state,切回来立刻补一次。
setInterval(() => { if (document.hidden) return; refresh(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('offline', () => { setConnection(false, '网络连接已断开'); renderProviders(); renderSlots(); });
window.addEventListener('online', refresh);


refresh();
