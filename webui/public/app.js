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
  bonds: [],
  control: {},
  effective: null,
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
  state.bonds = s.bonds || [];
}

// 功能开关：改动立刻写 data/control.json，bridge 3 秒内读到
// 运行时设置：分组 → 字段 → 【中文标签, 单位】
const GROUP_META = {
  chat: { title: '对话方式', desc: '群里什么时候需要 @ 她' },
  output: { title: '输出长度', desc: '她一次最多分几条消息发出去（默认一条）' },
  sticker: { title: 'A · 群友发表情包时回应', desc: '认出情绪、回一张不同情绪的图' },
  interject: { title: 'C · 听到就插话', desc: '有人提到她的名字、或有人发图时，顺口接一句' },
  initiative: { title: 'B · 主动发起（总开关与额度）', desc: '没人说话时也会自己开口' },
  chime: { title: 'B · 冷场接话', desc: '群里刚才还热闹，安静一阵后接一句' },
  callout: { title: 'D · 按人点名', desc: '主动 @ 某个"该联系的人"（社交压力最大）' },
};

const FIELD_META = {
  chat: {
    followUp: ['连续对话：引用她或答她的问话时不用 @', 'bool'],
    followUpWindowSec: ['她问完问题后等回答的时间', '秒'],
  },
  output: {
    maxParts: ['一次最多分几条', '条'],
    replyDelaySec: ['每条消息发出前停顿', '秒'],
    noActionHints: ['不写括号里的动作/神态，直接说话', 'bool'],
  },
  sticker: {
    enabled: ['启用', 'bool'],
    cooldownSec: ['同一个群两次的最小间隔', '秒'],
    dailyLimit: ['每天最多回几张', '张'],
    onlyAfterBotSpoke: ['只在她刚说过话之后接', 'bool'],
    withinSec: ['"刚说过话"的判定窗口', '秒'],
    replyWithText: ['回图时顺带说一句话', 'bool'],
    atUser: ['群里回应时 @ 对方', 'bool'],
  },
  interject: {
    enabled: ['启用', 'bool'],
    onImage: ['有人发图就触发', 'bool'],
    onQuestion: ['有人征求意见就触发', 'bool'],
    cooldownSec: ['同一个群两次的最小间隔', '秒'],
    dailyLimit: ['每天最多插几次', '次'],
  },
  initiative: {
    enabled: ['总开关', 'bool'],
    dailyLimit: ['每天最多主动说几次（冷场+点名合计）', '次'],
    quietStart: ['免打扰开始（整点）', '点'],
    quietEnd: ['免打扰结束（整点）', '点'],
  },
  chime: {
    enabled: ['启用', 'bool'],
    quietAfterMin: ['群安静多久后才考虑接话', '分钟'],
    staleAfterMin: ['超过多久就不接了（话题凉了）', '分钟'],
    cooldownMin: ['同一个群两次的最小间隔', '分钟'],
    minActivity: ['接话前该群至少有几条消息', '条'],
  },
  callout: {
    enabled: ['启用', 'bool'],
    minAffinity: ['亲密度门槛', '分'],
    minMessages: ['至少说过几句话', '句'],
    perUserCooldownDays: ['同一个人多少天内最多被点一次', '天'],
    cooldownMin: ['同一个群两次的最小间隔', '分钟'],
  },
};

function renderSwitches() {
  const box = $('#switches');
  const groups = state.effective?.groups;
  if (!groups) {
    box.innerHTML = '<p class="hint" style="padding:14px">读不到设置（bridge 没连上？）</p>';
    return;
  }

  const groupsHtml = Object.entries(GROUP_META)
    .map(([gkey, meta]) => {
      const fields = FIELD_META[gkey] || {};
      const rows = Object.entries(fields)
        .map(([fkey, [label, kind]]) => {
          const cell = groups[gkey]?.[fkey];
          if (!cell) return '';
          const changed = cell.overridden ? ' changed' : '';
          const badge = cell.overridden
            ? `<button class="reset-btn" data-g="${gkey}" data-f="${fkey}" title="恢复 config.json 的值">↺ 默认 ${esc(String(cell.base ?? '—'))}</button>`
            : '';
          if (kind === 'bool') {
            return `<label class="set-row${changed}">
              <input type="checkbox" data-g="${gkey}" data-f="${fkey}" ${cell.value ? 'checked' : ''}>
              <span class="set-label">${esc(label)}</span>${badge}
            </label>`;
          }
          return `<label class="set-row${changed}">
            <span class="set-label">${esc(label)}</span>
            <input type="number" data-g="${gkey}" data-f="${fkey}" value="${esc(String(cell.value ?? ''))}">
            <span class="unit">${esc(kind)}</span>${badge}
          </label>`;
        })
        .join('');
      if (!rows) return '';
      return `<div class="set-group">
        <div class="set-head"><b>${esc(meta.title)}</b><em>${esc(meta.desc)}</em></div>
        ${rows}
      </div>`;
    })
    .join('');

  const allowCell = groups.global?.allowedGroups;
  const allowVal = Array.isArray(allowCell?.value) ? allowCell.value : (allowCell?.base || []);
  const allowHtml = `<div class="set-group">
    <div class="set-head"><b>群白名单</b><em>只在这些群工作；留空 = 所有群。填群号，逗号或换行分隔</em></div>
    <textarea id="allowBox" rows="3" placeholder="123456789, 987654321">${esc((allowVal || []).join('\n'))}</textarea>
    <div class="row"><button class="sm primary" id="saveAllow">保存白名单</button><span class="hint">${allowCell?.overridden ? '已被面板改过' : '当前来自 config.json'}</span></div>
  </div>`;
  box.innerHTML = groupsHtml + allowHtml;

  box.querySelectorAll('input[data-f]').forEach((el) => {
    el.addEventListener('change', () => saveField(el.dataset.g, el.dataset.f, el));
  });
  box.querySelectorAll('.reset-btn').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      saveField(el.dataset.g, el.dataset.f, null);
    });
  });
  const saveAllow = box.querySelector('#saveAllow');
  if (saveAllow) {
    saveAllow.addEventListener('click', async () => {
      const list = ($('#allowBox').value || '')
        .split(/[\s,，]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      try {
        const r = await api('/api/control', { method: 'PATCH', body: JSON.stringify({ control: { global: { allowedGroups: list } } }) });
        state.effective = { groups: r.groups };
        renderSwitches();
        await loadRuntime();
      } catch (e) {
        alert(`保存失败：${e.message}`);
      }
    });
  }
}

async function saveField(group, field, el) {
  const patch = { [group]: {} };
  if (el === null) {
    patch[group][field] = null; // 恢复默认
  } else if (el.type === 'checkbox') {
    patch[group][field] = el.checked;
  } else {
    const n = Number(el.value);
    if (!Number.isFinite(n)) return renderSwitches();
    patch[group][field] = n;
  }
  try {
    const r = await api('/api/control', { method: 'PATCH', body: JSON.stringify({ control: patch }) });
    state.effective = { groups: r.groups };
    renderSwitches();
  } catch (e) {
    alert(`保存失败：${e.message}`);
    renderSwitches();
  }
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

  const bondOpts = state.bonds
    .map((b) => `<option value="${esc(b)}" ${m.bond === b ? 'selected' : ''}>${esc(b)}</option>`)
    .join('');
  // 换角色卡会换掉整套称号：旧称号不在新卡里时要提示，否则会以为"又坏了"
  const bondOrphan =
    m.bond && state.bonds.length && !state.bonds.includes(m.bond)
      ? `<span class="hint" style="color:var(--rose)">「${esc(m.bond)}」在当前角色卡里不存在，会被忽略</span>`
      : '';

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

    <label class="field" style="margin-top:16px">
      <span>关系称号 · 满级之后你们具体是什么关系（会直接影响她说话的方式）</span>
      <select id="bondSelect">
        <option value="">未指定（只说"挚友"）</option>
        ${bondOpts}
        ${m.bond && state.bonds.length && !state.bonds.includes(m.bond) ? `<option value="${esc(m.bond)}" selected>${esc(m.bond)}（当前卡里没有）</option>` : ''}
      </select>
      ${bondOrphan}
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
  $('#bondSelect').addEventListener('change', (e) => patch(m.qq, { bond: e.target.value }));
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

// ---------- 运行状态 ----------
function fmtMs(ms) {
  if (!ms || ms < 0) return '—';
  if (ms < 60000) return `${Math.round(ms / 1000)} 秒前`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} 分钟前`;
  return `${Math.round(ms / 3600000)} 小时前`;
}

function renderRuntime(data) {
  const r = data?.runtime;
  const age = data?.ageMs;
  $('#runtimeAge').textContent = age == null ? 'bridge 还没上报过' : `上报于 ${fmtMs(age)}`;
  if (!r) {
    $('#runtime').innerHTML = '<p class="hint" style="padding:14px">还没有运行数据 —— bridge 起来后每 30 秒写一次。</p>';
    return;
  }
  const t = r.stats?.tokens || {};
  const st = r.stats || {};
  const cacheRate = t.prompt ? Math.round(((t.cacheHit || 0) / t.prompt) * 100) : 0;
  const ini = r.initiative || {};

  const cell = (k, v, sub = '') =>
    `<div class="rt-cell"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>`;

  $('#runtime').innerHTML = `
    <div class="rt-grid">
      ${cell('模型', r.model || '—')}
      ${cell('群友档案', r.members?.size ?? 0, ' 人')}
      ${cell('今日主动', ini.today ?? 0, ` / ${ini.dailyLimit ?? '—'}`)}
      ${cell('累计回答', st.answered ?? 0, ' 次')}
      ${cell('回图', st.stickerReplies ?? 0, ' 次')}
      ${cell('插话', st.chime ?? 0, ' 次')}
      ${cell('限流拦截', st.limited ?? 0, ' 次')}
      ${cell('出错', st.errors ?? 0, ' 次')}
      ${cell('输入 token', t.prompt ?? 0)}
      ${cell('前缀缓存命中', `${cacheRate}%`)}
      ${cell('人设', (r.persona?.source || '—').split(/[\\/]/).pop())}
      ${cell('示范', r.persona?.fewshot || '未启用')}
    </div>
    <div class="rt-foot">
      <span>暂停：<b class="${r.paused ? 'on' : ''}">${r.paused ? '已暂停' : '运行中'}</b></span>
      <span>白名单：<b>${r.allowedGroups?.length ? r.allowedGroups.join('、') : '所有群'}</b></span>
      <span>表情套装：<b>${esc(r.stickerSet || '—')}</b></span>
      ${r.lastInitiative ? `<span>上次主动：<b>${esc(r.lastInitiative.kind)}</b>（${esc(r.lastInitiative.reason || '')}）</span>` : ''}
    </div>`;
}

async function loadRuntime() {
  try {
    renderRuntime(await api('/api/runtime'));
  } catch { /* 忽略，下次再试 */ }
}

// ---------- 人设 ----------
function renderPersona(d) {
  $('#personaFile').textContent = d.file ? d.file.replace(/^.*[\\/]/, '') : '—';
  const opts = ['<option value="">不启用示范</option>']
    .concat(d.fewshot.map((f) => `<option value="${esc(f)}" ${d.activeFewshot === f ? 'selected' : ''}>${esc(f)}</option>`))
    .join('');
  const personaOpts = (d.personas || ['默认'])
    .map((n) => {
      const val = n === '默认' ? '' : n;
      const cur = (d.activePersona || '默认') === n ? 'selected' : '';
      return `<option value="${esc(val)}" ${cur}>${esc(n)}</option>`;
    })
    .join('');

  const fewshotField = d.hasOwnFewshot
    ? `<label class="field">
         <span>示范问答（fewshot/）</span>
         <div class="hint" style="padding:8px 0">这张卡自带示范：<code>personas/${esc(d.activePersona)}/fewshot.txt</code>，跟着卡走，不用选</div>
       </label>`
    : `<label class="field">
         <span>示范问答（fewshot/）</span>
         <select id="fewshotSelect">${opts}</select>
       </label>`;

  $('#persona').innerHTML = `
    <div class="persona-grid">
      <label class="field">
        <span>人设正文（保存后下一条消息生效，不用重启）</span>
        <textarea id="personaText" class="persona-text" placeholder="她是怎样的一个人……">${esc(d.text)}</textarea>
      </label>
      <div class="persona-side">
        <label class="field">
          <span>角色卡</span>
          <select id="personaSelect">${personaOpts}</select>
        </label>
        ${fewshotField}
        <div class="row">
          <button class="primary" id="savePersona">保存人设</button>
          <span class="hint" id="personaHint">${d.error ? esc(d.error) : ''}</span>
        </div>
      </div>
    </div>`;

  $('#personaSelect')?.addEventListener('change', async (e) => {
    try {
      await api('/api/control', { method: 'PATCH', body: JSON.stringify({ control: { persona: { file: e.target.value } } }) });
      await loadControl();
      await loadPersona();
      await loadMembers(); // 关系称号会跟着角色卡换
      await loadRuntime();
    } catch (err) {
      alert(`切换失败：${err.message}`);
    }
  });

  $('#savePersona').addEventListener('click', async () => {
    const hint = $('#personaHint');
    hint.textContent = '保存中…';
    try {
      const r = await api('/api/persona', { method: 'POST', body: JSON.stringify({ text: $('#personaText').value }) });
      hint.textContent = `已保存 ${r.bytes} 字节（备份 ${r.backup}）`;
    } catch (e) {
      hint.textContent = `失败：${e.message}`;
    }
  });

  $('#fewshotSelect')?.addEventListener('change', async (e) => {
    try {
      await api('/api/control', { method: 'PATCH', body: JSON.stringify({ control: { persona: { fewshot: e.target.value } } }) });
      await loadControl();
      await loadRuntime();
    } catch (err) {
      alert(`保存失败：${err.message}`);
    }
  });
}

async function loadPersona() {
  try {
    const d = await api('/api/persona');
    // 关系称号是跟着角色卡走的：换卡之后这里不更新，
    // 成员详情里就会还挂着上一个角色的称号（比如黑眼卡上却显示"闺蜜"）
    const bonds = d.relations?.bonds;
    if (Array.isArray(bonds) && bonds.length) state.bonds = bonds;
    else if (!bonds && state.bonds?.length) state.bonds = []; // 卡里没写就回退到默认列表
    renderPersona(d);

    // 重画当前选中的成员，让称号下拉立刻换成新的一套
    if (!bonds && !state.bonds.length) {
      try {
        state.bonds = (await api('/api/status')).bonds || [];
      } catch { /* 忽略 */ }
    }
    if (state.selected) {
      const m = state.members.find((x) => x.qq === state.selected);
      if (m) renderDetail(m);
    }
  } catch (e) {
    $('#persona').innerHTML = `<p class="hint" style="padding:14px">读不到人设：${esc(e.message)}</p>`;
  }
}

// ---------- 表情套装 ----------
function renderSets(d) {
  $('#setStatus').textContent = d.sets?.length ? `当前：${d.active}` : '没有可用套装';
  if (!d.sets?.length) {
    $('#sets').innerHTML = `<p class="hint" style="padding:14px">stickers/ 下没有找到任何套装目录。</p>`;
    return;
  }
  $('#sets').innerHTML = d.sets
    .map((s) => {
      const on = s.name === d.active;
      return `<div class="set-card ${on ? 'on' : ''}">
        <div class="set-title">
          <b>${esc(s.name)}</b>
          <span class="hint">${s.count} 张</span>
          ${on ? '<span class="tag">使用中</span>' : `<button class="sm" data-set="${esc(s.name)}">切换</button>`}
        </div>
        <div class="thumbs">
          ${s.preview
            .map(
              (p) =>
                `<figure title="${esc(p.mood)}"><img loading="lazy" src="/api/sticker?set=${encodeURIComponent(s.name)}&file=${encodeURIComponent(p.file)}" alt=""><figcaption>${esc(p.mood)}</figcaption></figure>`
            )
            .join('')}
        </div>
      </div>`;
    })
    .join('');

  $('#sets').querySelectorAll('button[data-set]').forEach((el) => {
    el.addEventListener('click', async () => {
      try {
        await api('/api/control', { method: 'PATCH', body: JSON.stringify({ control: { sticker: { activeSet: el.dataset.set } } }) });
        await loadSets();
        await loadRuntime();
      } catch (e) {
        alert(`切换失败：${e.message}`);
      }
    });
  });
}

async function loadSets() {
  try {
    renderSets(await api('/api/sets'));
  } catch (e) {
    $('#sets').innerHTML = `<p class="hint" style="padding:14px">读不到套装：${esc(e.message)}</p>`;
  }
}

// ---------- 日志 ----------
async function loadLogs() {
  const lines = $('#logLines').value;
  const q = $('#logFilter').value.trim();
  try {
    const d = await api(`/api/logs?lines=${encodeURIComponent(lines)}&q=${encodeURIComponent(q)}`);
    const box = $('#logBox');
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    box.textContent = (d.lines || []).join('\n') || '（没有匹配的日志）';
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch (e) {
    $('#logBox').textContent = `读取日志失败：${e.message}`;
  }
}

// ---------- 暂停 ----------
async function togglePause() {
  const paused = !(state.effective?.groups?.global?.paused?.value === true);
  try {
    const r = await api('/api/control', { method: 'PATCH', body: JSON.stringify({ control: { global: { paused } } }) });
    state.effective = { groups: r.groups };
    syncPauseBtn();
    await loadRuntime();
  } catch (e) {
    alert(`操作失败：${e.message}`);
  }
}

function syncPauseBtn() {
  const paused = state.effective?.groups?.global?.paused?.value === true;
  const btn = $('#pauseBtn');
  btn.textContent = paused ? '已暂停 · 点此恢复' : '暂停';
  btn.classList.toggle('paused', paused);
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

// 能力开关：工具与上下文。折叠在一块里，免得把主界面撑乱。
const CAP_LABELS = {
  search: '联网搜索',
  calc: '计算器',
  datetime: '日期计算',
  random: '随机骰子',
  fetchUrl: '读网页',
  vision: '看图',
  stickers: '表情包',
  ambient: '群聊背景',
  smartInject: '背景按需注入',
  adaptive: '难度自适应',
};

function renderCaps() {
  const g = state.effective?.groups?.features;
  const box = $('#caps');
  if (!box) return;
  if (!g) {
    box.innerHTML = '<p class="hint" style="padding:10px">读不到设置</p>';
    return;
  }
  const onCount = Object.keys(CAP_LABELS).filter((k) => g[k]?.value === true).length;
  const sum = $('#capsSummary');
  if (sum) sum.textContent = `工具与上下文 · ${onCount} 项开启 · 点开调整`;

  box.innerHTML = Object.entries(CAP_LABELS)
    .map(([k, label]) => {
      const cell = g[k];
      if (!cell) return '';
      const on = cell.value === true;
      const changed = cell.overridden ? ' changed' : '';
      return `<button class="cap${on ? ' on' : ''}${changed}" data-cap="${k}"
        title="${cell.overridden ? `已改过；默认是「${cell.base ? '开' : '关'}」` : '点击切换'}">${esc(label)}</button>`;
    })
    .join('');

  box.querySelectorAll('button[data-cap]').forEach((el) => {
    el.addEventListener('click', async () => {
      const key = el.dataset.cap;
      const next = !(g[key]?.value === true);
      try {
        const r = await api('/api/control', { method: 'PATCH', body: JSON.stringify({ control: { features: { [key]: next } } }) });
        state.effective = { groups: r.groups };
        renderCaps();
        await loadRuntime();
      } catch (e) {
        alert(`切换失败：${e.message}`);
      }
    });
  });
}

async function loadControl() {
  try {
    const r = await api('/api/control');
    state.effective = { groups: r.groups };
  } catch {
    state.effective = null;
  }
  renderSwitches();
  renderCaps();
}

(async function main() {
  try {
    renderStatus(await api('/api/status'));
    await loadControl();
    syncPauseBtn();
    await loadMembers();
    await loadCandidates();
    await loadRuntime();
    await loadPersona();
    await loadSets();
    await loadLogs();
  } catch (e) {
    $('#status').className = 'status warn';
    $('#status').textContent = `加载失败：${e.message}`;
  }

  // 定时刷新：运行状态和日志
  let autoLog = true;
  setInterval(() => {
    loadRuntime();
    if (autoLog && $('#logAuto').checked) loadLogs();
  }, 5000);

  $('#pauseBtn').addEventListener('click', togglePause);
  $('#logReload').addEventListener('click', loadLogs);
  $('#logFilter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadLogs();
  });
  $('#logLines').addEventListener('change', loadLogs);
  $('#logAuto').addEventListener('change', (e) => {
    autoLog = e.target.checked;
  });
})();
