// 登录等待器：等 NapCat 登录成功，然后自动把 bridge 拉起来
//
// 为什么需要它：NapCat 是注入本机 QQ 进程的，没法"连上就算登录好"——
// 官方日志与实测都表明，**QQ 登录成功前 OneBot 的 3001 端口不会监听**。
// 所以判据很干脆：3001 能连上 = 登录成功。
//
// 二维码：NapCat 会把登录二维码写到 NapCat.Shell/cache/qrcode.png。
// 需要扫码时本脚本会自动用系统默认看图程序把它弹出来（每刷新一版弹一次）。
//
// 用法（由 一键启动.bat 调用）：
//   node watch-login.mjs
// 可用环境变量：
//   QQ_BRIDGE_WS_PORT     OneBot 端口，默认 3001
//   QQ_BRIDGE_WAIT_MIN    等待登录的最长分钟数，默认 10
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAPCAT_DIR = path.resolve(HERE, '..', 'napcat', 'NapCat.Shell');
const QR_FILE = path.join(NAPCAT_DIR, 'cache', 'qrcode.png');
const LOCK_FILE = path.join(HERE, '.bridge.lock');

const WS_HOST = '127.0.0.1';
const WS_PORT = Number(process.env.QQ_BRIDGE_WS_PORT || 3001);
const WAIT_MINUTES = Number(process.env.QQ_BRIDGE_WAIT_MIN || 10);
// NapCat 的 WebUI 端口：注入成功后**立刻**就会监听（早于 QQ 登录）。
// 所以「WebUI 端口没有」= NapCat 根本没注入 —— 这个故障能提前发现，且原因很具体。
const WEBUI_PORT = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(NAPCAT_DIR, 'config', 'webui.json'), 'utf8'));
    const p = Number(j.port);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    /* 读不到就用默认值 */
  }
  return Number(process.env.QQ_BRIDGE_WEBUI_PORT || 6099);
})();
const LOAD_JS = path.join(NAPCAT_DIR, 'loadNapCat.js');
// 只有这个时间之后写出的二维码才弹（避免把上一次运行留下的旧码弹出来）
const FRESH_AFTER = Date.now() - 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 能否连上某个 TCP 端口 */
function canConnect(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* 忽略 */
      }
      resolve(v);
    };
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
    sock.setTimeout(timeoutMs, () => fin(false));
  });
}

/** 用系统默认程序打开文件（不经过 cmd，避免各种引号转义问题） */
function openWithDefaultApp(file) {
  try {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', file], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return true;
  } catch {
    return false;
  }
}

/** 进程是否还活着（用于防止开出第二个 bridge） */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockPid() {
  try {
    const n = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function main() {
  console.log('[watch] 等待 NapCat 登录 ...');
  console.log(`[watch] 判据：${WS_HOST}:${WS_PORT} 能连上 = OneBot 已就绪`);
  console.log(`[watch] 二维码文件：${QR_FILE}`);

  const startedAt = Date.now();
  const deadline = startedAt + WAIT_MINUTES * 60000;
  let lastQrMtime = 0;
  let qrCount = 0;
  let hintPrinted = false;
  let injectChecked = false;

  for (;;) {
    if (await canConnect(WS_HOST, WS_PORT)) {
      console.log('[watch] ✔ OneBot 端口已监听 —— 登录成功');
      break;
    }

    try {
      const st = fs.statSync(QR_FILE);
      if (st.mtimeMs !== lastQrMtime) {
        const isNew = st.mtimeMs > FRESH_AFTER;
        lastQrMtime = st.mtimeMs;
        if (isNew && openWithDefaultApp(QR_FILE)) {
          qrCount += 1;
          hintPrinted = true;
          console.log(`[watch] → 已弹出登录二维码（第 ${qrCount} 版），请用手机 QQ 扫码`);
        }
      }
    } catch {
      /* 二维码还没生成，继续等 */
    }

    if (!hintPrinted && Date.now() - startedAt > 20000) {
      hintPrinted = true;
      console.log('[watch] 暂时没出现二维码 —— 若快速登录成功会自动跳过扫码，请留意 NapCat 窗口的提示');
    }

    // NapCat 注入失败是**完全静默**的：QQ 照常启动、窗口照常出现，只是没有 NapCat，
    // 于是 3001 永远不监听。傻等 10 分钟再报“登录超时”会把方向带偏（以为是账号问题）。
    // 这里用 WebUI 端口提前把它揪出来，给出可直接执行的自查动作。
    if (!injectChecked && Date.now() - startedAt > 25000) {
      injectChecked = true;
      if (await canConnect(WS_HOST, WEBUI_PORT)) {
        console.log(`[watch] ✔ NapCat 已注入（WebUI ${WEBUI_PORT} 在监听），现在只等 QQ 登录。`);
      } else {
        console.log(`[watch] ⚠ 没检测到 NapCat 的 WebUI 端口 ${WEBUI_PORT} —— NapCat 很可能没注入成功。`);
        console.log('[watch]   最常见原因：NapCat.Shell 的绝对路径含中文（或其它非 ASCII 字符），');
        console.log('[watch]   导致 start-napcat.bat 生成的 loadNapCat.js 变成乱码，import 静默失败。');
        console.log(`[watch]   自查：用记事本打开 ${LOAD_JS}`);
        console.log('[watch]        正常只有一行、全是英文数字；若看到方块/问号就是中招了。');
        console.log(`[watch]   其次：WebUI ${WEBUI_PORT} 被占用，或 webui.json 的 port 被改过。`);
      }
    }

    if (Date.now() > deadline) {
      console.log(`[watch] ✘ 等待登录超时（${WAIT_MINUTES} 分钟）。`);
      console.log('[watch]   请检查 NapCat 窗口：常见原因是该号已在别处（日常 QQ）登录，需先退出。');
      process.exit(2);
    }
    await sleep(1500);
  }

  // 端口刚监听时，OneBot 适配器可能还在初始化，给它一点时间
  await sleep(1200);

  // 防止开出第二个 bridge：一条消息两条回复
  const lockedPid = readLockPid();
  if (lockedPid && isAlive(lockedPid)) {
    console.log(`[watch] ✘ 已经有一个 bridge 在运行（PID ${lockedPid}），不再重复启动。`);
    console.log('[watch]   要重启就先关掉那个窗口（或结束该进程）再运行本脚本。');
    process.exit(3);
  }

  console.log('[watch] 正在启动 qq-bridge ...\n');
  const child = spawn(process.execPath, [path.join(HERE, 'bridge.mjs')], {
    cwd: HERE,
    stdio: 'inherit',
  });
  try {
    fs.writeFileSync(LOCK_FILE, String(child.pid));
  } catch {
    /* 锁写不了不影响运行 */
  }

  const cleanup = () => {
    try {
      fs.rmSync(LOCK_FILE, { force: true });
    } catch {
      /* 忽略 */
    }
  };
  child.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      cleanup();
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
    });
  }
}

main().catch((e) => {
  console.error('[watch] 异常：', e?.message || e);
  process.exit(1);
});
