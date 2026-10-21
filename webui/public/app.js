// 前端：无构建、无框架。与 server.mjs 的 /api/* 对话。

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 等级色不写在这里：统一走 style.css 的 --lv0..--lv4 变量，
// 切主题时自动跟着变，JS 不需要知道具体色值。

const state = {
  members: [],
  stats: null,
  levels: [],
  rules: null,
  selected: null,
  sort: 'affinity',
};

// ---------- 工具 ----------

async function api(path, opts) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function relTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

/** 头像：优先用 public/avatars/<qq>.png，加载失败就露出底下的首字 */
function avatar(m, cls = '') {
  const ch = (m.nick || '?').trim().charAt(0);
  return `<div class="avatar ${cls}">
    <span class="initial">${esc(ch)}</span>
    <img src="/avatars/${encodeURIComponent(m.qq)}.png" alt="" loading="lazy"
         onerror="this.remove()">
  </div>`;
}

// ---------- 渲染 ----------

function renderStatus(s) {
  const el = $('#status');
  if (s.bridgeConnected) {
    el.className = 'status ok';
    el.textContent = '已连上 qq-bridge';
  } else {
    el.className = 'status warn';
    el.textContent = '未找到 qq-bridge · 演示模式';
  }
  $('#env').textContent = `Node ${s.node} · ${s.platform}`;
  state.levels = s.levels;
  state.rules = s.rules;
}

function renderOverview(st) {
  const max = state.rules?.maxScore ?? 100;
  const totalLv = (st.levels || []).reduce((s, l) => s + l.count, 0) || 1;

  const metrics = `
    <div class="metrics">
      <div class="metric"><div class="k">群友档案</div><div class="v">${st.members}<small>人</small></div></div>
      <div class="metric"><div class="k">今天说过话</div><div class="v">${st.aliveToday}<small>人</small></div></div>
      <div class="metric"><div class="k">累计消息</div><div class="v">${st.totalMessages.toLocaleString()}</div></div>
      <div class="metric"><div class="k">平均亲密度</div><div class="v">${st.avgAffinity}<small>/ ${max}</small></div></div>
    </div>`;

  const bars = (st.levels || [])
    .filter((l) => l.count > 0)
    .map((l) => `<i style="width:${(l.count / totalLv) * 100}%;background:var(--${l.key})"></i>`)
    .join('');

  const legend = (st.levels || [])
    .filter((l) => l.count > 0)
    .map(
      (l) =>
        `<span><b style="background:var(--${l.key})"></b>${esc(l.name)} <em>${l.count}</em></span>`
    )
    .join('');

  const dist = `
    <div class="dist">
      <div class="k">等级分布</div>
      <div class="dist-bar">${bars || ''}</div>
      <div class="dist-legend">${legend || '<span>还没有数据</span>'}</div>
    </div>`;

  $('#overview').innerHTML = metrics + dist;
}

function sortedMembers() {
  const arr = [...state.members];
  if (state.sort === 'affinity') arr.sort((a, b) => b.affinity - a.affinity);
  if (state.sort === 'recent') arr.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  if (state.sort === 'messages') arr.sort((a, b) => b.stats.messages - a.stats.messages);
  return arr;
}

function renderList() {
  const list = $('#memberList');
  const max = state.rules?.maxScore ?? 100;
  $('#memberCount').textContent = state.members.length;

  if (!state.members.length) {
    list.innerHTML = `<li class="empty" style="min-height:200px">
      还没有成员数据<br><span class="hint">node scripts/seed.mjs</span></li>`;
    return;
  }

  list.innerHTML = sortedMembers()
    .map((m) => {
      const pct = Math.round((m.affinity / max) * 100);
      return `<li class="member ${state.selected === m.qq ? 'active' : ''}" data-qq="${esc(m.qq)}">
        ${avatar(m)}
        <div class="name">
          <span class="txt">${esc(m.nick)}</span>
          ${m.muted ? '<span class="tag">静音</span>' : ''}
        </div>
        <div class="score ${esc(m.level.key)}">${m.affinity}<span class="lv">${esc(m.level.name)}</span></div>
        <div class="sub">${esc(relTime(m.lastSeenAt))} · ${m.stats.messages} 条</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </li>`;
    })
    .join('');

  list.querySelectorAll('.member').forEach((el) => {
    el.addEventListener('click', () => select(el.dataset.qq));
  });
}

function renderDetail(m) {
  const r = state.rules ?? {};
  const max = r.maxScore ?? 100;
  const pct = Math.round((m.affinity / max) * 100);
  const nextTxt = m.next
    ? `再 <b style="color:var(--dim)">${m.next.gap}</b> 分到「${esc(m.next.name)}」`
    : '已是最高等级';

  $('#detail').innerHTML = `
    <div class="detail-top">
      ${avatar(m, 'avatar-lg')}
      <div class="who">
        <h3>${esc(m.nick)}</h3>
        <div class="meta">QQ ${esc(m.qq)} · 首次出现 ${esc(relTime(m.firstSeenAt))}</div>
      </div>
      <div class="big-score">
        <div class="n ${esc(m.level.key)}">${m.affinity}</div>
        <div class="of">/ ${max}</div>
      </div>
    </div>

    <div class="progress"><i style="width:${pct}%"></i></div>
    <div class="progress-label">
      <span class="chip ${esc(m.level.key)}">${esc(m.level.name)}</span>
      <span>${nextTxt}</span>
    </div>

    <div class="facts">
      <div class="fact"><div class="k">发言</div><div class="v">${m.stats.messages}</div></div>
      <div class="fact"><div class="k">被 @</div><div class="v">${m.stats.ats}</div></div>
      <div class="fact"><div class="k">回过它</div><div class="v">${m.stats.replies}</div></div>
      <div class="fact"><div class="k">收到表情包</div><div class="v">${m.stats.stickersSeen}</div></div>
      <div class="fact"><div class="k">主动找过</div><div class="v">${m.stats.proactives}</div></div>
    </div>

    <label class="field">
      <span>备注 · 不会被自动逻辑覆盖</span>
      <textarea id="noteInput" placeholder="这个人是谁、喜欢聊什么、要不要多照顾一点">${esc(m.note)}</textarea>
    </label>

    <div class="row">
      <button class="primary" id="saveNote">保存备注</button>
      <button id="minus5">−5</button>
      <button id="plus5">+5</button>
      <button class="danger" id="resetAffinity">清零亲密度</button>
    </div>

    <label class="toggle">
      <input type="checkbox" id="mutedBox" ${m.muted ? 'checked' : ''}>
      <span>不要主动找这个人说话</span>
    </label>

    <div class="rules">
      <b>亲密度怎么算的</b><br>
      被 @ 一次 <code>+${r.atScore ?? '?'}</code>；普通发言 <code>+${r.messageScore ?? '?'}</code>，
      每天最多计 <code>${r.dailyMessageCap ?? '?'}</code> 分（防刷分）<br>
      超过 <code>${r.idleDaysBeforeDecay ?? '?'}</code> 天没说话，之后每天
      <code>−${r.decayPerDay ?? '?'}</code>，最低 0
    </div>`;

  $('#saveNote').addEventListener('click', () => patch(m.qq, { note: $('#noteInput').value }));
  $('#mutedBox').addEventListener('change', (e) => patch(m.qq, { muted: e.target.checked }));
  $('#plus5').addEventListener('click', () => patch(m.qq, { affinity: m.affinity + 5 }));
  $('#minus5').addEventListener('click', () => patch(m.qq, { affinity: m.affinity - 5 }));
  $('#resetAffinity').addEventListener('click', () => {
    if (confirm(`把 ${m.nick} 的亲密度清零？`)) patch(m.qq, { affinity: 0 });
  });
}

function renderCandidates(list) {
  const ol = $('#candidates');
  if (!list.length) {
    ol.innerHTML = `<li style="grid-template-columns:1fr"><span class="why">没有候选 —— 要么都被静音了，要么还没有数据</span></li>`;
    return;
  }
  ol.innerHTML = list
    .map(
      (c, i) => `<li>
        <span class="rank">${i + 1}</span>
        ${avatar({ qq: c.qq, nick: c.nick }, 'avatar-sm')}
        <span>
          <span class="who">${esc(c.nick)}</span>
          <span class="why">亲密度 ${c.affinity} · ${c.idleDays} 天没说话</span>
        </span>
        <span class="sc">${c.score}</span>
      </li>`
    )
    .join('');
}

// ---------- 数据流 ----------

async function loadMembers() {
  const data = await api('/api/members');
  state.members = data.members;
  state.stats = data.stats;
  renderOverview(data.stats);
  renderList();
  if (state.selected) {
    const m = state.members.find((x) => x.qq === state.selected);
    if (m) renderDetail(m);
  }
}

async function loadCandidates() {
  const data = await api('/api/proactive');
  renderCandidates(data.candidates);
}

function select(qq) {
  state.selected = qq;
  renderList();
  const m = state.members.find((x) => x.qq === qq);
  if (m) renderDetail(m);
}

async function patch(qq, body) {
  try {
    await api(`/api/members/${encodeURIComponent(qq)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    await loadMembers();
    await loadCandidates();
  } catch (e) {
    alert(`保存失败：${e.message}`);
  }
}

// ---------- 启动 ----------

const SORT_LABEL = { affinity: '亲密度 ↓', recent: '最近活跃 ↓', messages: '发言数 ↓' };
$('#sortBtn').addEventListener('click', () => {
  const order = ['affinity', 'recent', 'messages'];
  state.sort = order[(order.indexOf(state.sort) + 1) % order.length];
  $('#sortBtn').textContent = SORT_LABEL[state.sort];
  renderList();
});

// 明暗切换：默认浅色，选择存 localStorage（head 里的内联脚本会先套上，避免闪屏）
const THEME_KEY = 'qqb-theme';
const isDark = () => document.documentElement.dataset.theme === 'dark';

function syncThemeBtn() {
  // 按钮显示的是"切过去之后会变成什么"
  $('#themeBtn').textContent = isDark() ? '浅色' : '深色';
}

$('#themeBtn').addEventListener('click', () => {
  const next = isDark() ? 'light' : 'dark';
  if (next === 'dark') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch { /* 隐私模式下写不了，忽略 */ }
  syncThemeBtn();
});

syncThemeBtn();

(async function main() {
  try {
    renderStatus(await api('/api/status'));
    await loadMembers();
    await loadCandidates();
  } catch (e) {
    $('#status').className = 'status warn';
    $('#status').textContent = `加载失败：${e.message}`;
  }
})();
