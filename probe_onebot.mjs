// OneBot 连通性检查：连 NapCat 的 WebSocket 服务端，问几个基础接口
// 用法：node probe_onebot.mjs [ws地址，默认 ws://127.0.0.1:3001]
import { wsConnect } from './src/ws.mjs';

const url = process.argv[2] || 'ws://127.0.0.1:3001';
console.log('连接 ' + url);

let conn;
try {
  conn = await wsConnect(url, {}, { timeoutMs: 8000 });
} catch (e) {
  console.log('连接失败：' + e.message);
  console.log('→ 若为 ECONNREFUSED，说明 NapCat 的 QQ 还没登录成功，3001 不会启动');
  process.exit(1);
}
console.log('WebSocket 已连接\n');

let seq = 0;
const pending = new Map();

conn.on('message', (raw) => {
  let p;
  try {
    p = JSON.parse(raw);
  } catch {
    return;
  }
  if (p.echo && pending.has(p.echo)) {
    const r = pending.get(p.echo);
    pending.delete(p.echo);
    r(p);
  }
});
conn.on('error', (e) => console.log('错误：' + e.message));

function call(action, params = {}) {
  return new Promise((res) => {
    const echo = 'e' + ++seq;
    pending.set(echo, res);
    conn.send(JSON.stringify({ action, params, echo }));
    setTimeout(() => {
      if (pending.has(echo)) {
        pending.delete(echo);
        res({ status: 'timeout', msg: '8 秒无响应' });
      }
    }, 8000);
  });
}

const info = await call('get_login_info');
console.log('get_login_info   :', JSON.stringify(info.data ?? info));

const ver = await call('get_version_info');
console.log('get_version_info :', JSON.stringify(ver.data ?? ver));

const friends = await call('get_friend_list');
if (Array.isArray(friends.data)) {
  console.log('好友数           :', friends.data.length);
} else {
  console.log('get_friend_list  :', JSON.stringify(friends).slice(0, 160));
}

const groups = await call('get_group_list');
if (Array.isArray(groups.data)) {
  console.log('群数             :', groups.data.length);
  for (const g of groups.data.slice(0, 20)) {
    console.log('   群 %s  %s', g.group_id, g.group_name);
  }
} else {
  console.log('get_group_list   :', JSON.stringify(groups).slice(0, 160));
}

console.log('\n--- 等待 10 秒，观察是否有实时事件（可让群里 @ 一下）---');
setTimeout(() => {
  console.log('检查结束');
  process.exit(0);
}, 10000);
