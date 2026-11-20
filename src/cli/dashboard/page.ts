/**
 * The dashboard page: one HTML document with inline CSS and JS (no build, no
 * dependencies). It polls /api/state every 5 seconds and pauses re-rendering
 * while you type an answer or have a dialog open.
 *
 * The client script avoids backticks and "${" so it can live in this template.
 */

export function dashboardPage(token: string): string {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ORCH Dashboard</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1d2330; --dim: #6b7383; --line: #e3e6eb;
  --accent: #3b6fd8; --ok: #2e8b57; --warn: #c27c0e; --bad: #c4423a; --chip: #eef1f6;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #14161b; --panel: #1c1f26; --text: #e4e7ee; --dim: #8b93a3; --line: #2c313b;
    --accent: #6c9cff; --ok: #4fbf7f; --warn: #e0a33a; --bad: #ef6b62; --chip: #262b35; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft JhengHei", "PingFang TC", sans-serif; }
header { position: sticky; top: 0; z-index: 5; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
header h1 { font-size: 16px; margin: 0; }
main { max-width: 1280px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
section > h2 { font-size: 15px; margin: 0 0 10px; display: flex; gap: 8px; align-items: center; }
.count { background: var(--chip); border-radius: 10px; padding: 0 8px; font-size: 12px; color: var(--dim); }
.count.hot { background: var(--warn); color: #fff; }
.pill { border-radius: 12px; padding: 2px 10px; font-size: 12px; background: var(--chip); }
.pill.ok { background: var(--ok); color: #fff; } .pill.bad { background: var(--bad); color: #fff; } .pill.warn { background: var(--warn); color: #fff; }
.dim { color: var(--dim); } .small { font-size: 12px; }
.cards { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); align-items: start; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: grid; gap: 8px; min-width: 0; align-content: start; }
.card.wide { grid-column: 1 / -1; }
.card table td:nth-child(3) { min-width: 160px; }
.card h3 { margin: 0; font-size: 14px; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
textarea, input[type=text] { width: 100%; font: inherit; color: var(--text); background: var(--bg);
  border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }
textarea { min-height: 54px; resize: vertical; }
button { font: inherit; border: 1px solid var(--line); background: var(--chip); color: var(--text);
  border-radius: 6px; padding: 4px 12px; cursor: pointer; }
button:hover { border-color: var(--accent); }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.danger { color: var(--bad); }
button:disabled { opacity: .5; cursor: wait; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--dim); font-size: 12px; }
tr.click { cursor: pointer; } tr.click:hover td { background: var(--chip); }
pre { white-space: pre-wrap; word-break: break-word; background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; padding: 8px; margin: 0; max-height: 360px; overflow: auto; font: 12px/1.45 ui-monospace, Consolas, monospace; }
details summary { cursor: pointer; color: var(--dim); }
.st { display: inline-block; min-width: 72px; border-radius: 4px; padding: 0 6px; font-size: 12px; text-align: center; background: var(--chip); }
.st.done { color: var(--ok); } .st.failed, .st.cancelled { color: var(--dim); }
.st.in_progress { background: var(--accent); color: #fff; } .st.review { color: var(--accent); }
.st.waiting_decision, .st.retrying { background: var(--warn); color: #fff; }
.tag { font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; color: var(--dim); }
.diff-add { color: var(--ok); } .diff-del { color: var(--bad); } .diff-hunk { color: var(--accent); }
#modal { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: none; align-items: flex-start; justify-content: center; z-index: 20; overflow: auto; padding: 40px 16px; }
#modal.open { display: flex; }
#modal .box { background: var(--panel); border-radius: 10px; max-width: 900px; width: 100%; padding: 16px; display: grid; gap: 10px; }
#toast { position: fixed; right: 16px; bottom: 16px; display: grid; gap: 6px; z-index: 30; }
#toast div { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--ok); border-radius: 6px; padding: 8px 12px; max-width: 420px; box-shadow: 0 2px 10px rgba(0,0,0,.15); }
#toast div.err { border-left-color: var(--bad); }
.empty { color: var(--dim); padding: 4px 0; }
.agents { display: grid; gap: 2px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--dim); margin-right: 6px; }
.dot.running { background: var(--accent); } .dot.idle { background: var(--ok); } .dot.error { background: var(--bad); }
</style>
</head>
<body>
<header>
  <h1 id="project">ORCH</h1>
  <span id="orch" class="pill">…</span>
  <span id="updated" class="dim small"></span>
  <span id="paused" class="dim small"></span>
</header>
<main id="main"><section>載入中…</section></main>
<div id="modal"><div class="box" id="modal-box"></div></div>
<div id="toast"></div>
<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var state = null;
  var lastKey = '';
  var showFinished = false;
  try { showFinished = localStorage.getItem('orch-show-finished') === '1'; } catch (e) {}

  var STATUS = { todo: '待辦', in_progress: '進行中', review: '審查中', done: '完成', failed: '失敗', cancelled: '已取消', retrying: '重試中', waiting_decision: '等決策' };
  var SOURCE = { escalation: '迴圈上限', agent: 'agent 提問', gate: '關卡', plan: '計畫', delivery: '交付回報', review: '審查', bug: 'bug' };
  var DELIVERY = { done: '已交付', partial: '部分完成', blocked: '卡住' };
  var KIND = { plan: '規劃', prd: 'PRD 起草', 'pm-answer': 'PM 回答', review: '審查', bug: 'bug', verify: '複測' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function time(iso) { if (!iso) return ''; var d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(); }
  function $(id) { return document.getElementById(id); }

  function api(path, body) {
    var init = { headers: { 'X-Orch-Token': TOKEN } };
    if (body !== undefined) { init.method = 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.hint = j.hint; throw e; }
        return j;
      });
    });
  }

  function toast(msg, err) {
    var d = document.createElement('div'); if (err) d.className = 'err'; d.textContent = msg;
    $('toast').appendChild(d); setTimeout(function () { d.remove(); }, err ? 9000 : 5000);
  }

  function act(body, btn, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    if (btn) btn.disabled = true;
    api('/api/action', body).then(function (r) {
      toast(r.message || '完成');
      closeModal(); refresh(true);
    }).catch(function (e) {
      toast(e.message + (e.hint ? '\\n' + e.hint : ''), true);
    }).then(function () { if (btn) btn.disabled = false; });
  }

  // ── rendering ────────────────────────────────────────────────
  function statusBadge(s) { return '<span class="st ' + esc(s) + '">' + esc(STATUS[s] || s) + '</span>'; }

  function decisionCard(d, held) {
    var id = esc(d.id);
    var opts = (d.options || []).map(function (o, i) {
      return '<label class="row"><input type="radio" name="ch-' + id + '" value="' + esc(o) + '"> ' + (i + 1) + '. ' + esc(o) + '</label>';
    }).join('');
    var from = esc(SOURCE[d.source] || d.source) + (d.requested_by ? ' · ' + esc(d.requested_by) : '');
    return '<div class="card" data-decision="' + id + '">' +
      '<div class="row small dim"><span class="tag">' + from + '</span>' +
        (d.task_id ? '<a href="#" data-task="' + esc(d.task_id) + '">' + esc(d.task_title || d.task_id) + '</a>' : '') +
        '<span>' + esc(time(d.created_at)) + '</span>' +
        (held ? '<span class="pill warn">' + esc(d.assignee) + ' 處理中</span>' : '') + '</div>' +
      '<h3>' + esc(d.question) + '</h3>' +
      (d.context ? '<details><summary>背景</summary><pre>' + esc(d.context) + '</pre></details>' : '') +
      opts +
      '<textarea placeholder="你的回答或指示（選了選項可以不填）"></textarea>' +
      '<div class="row">' +
        '<button class="primary" data-answer="continue">回答並繼續</button>' +
        (d.task_id ? '<button data-answer="approve">核准</button><button class="danger" data-answer="cancel">取消 task</button>' : '') +
        '<label class="row small dim"><input type="checkbox" data-project> 全專案規則</label>' +
      '</div></div>';
  }

  function planCard(p) {
    var rows = p.tasks.map(function (t) {
      var contract = (t.produces || []).map(function (x) { return '→ ' + x; }).concat((t.uses || []).map(function (x) { return '← ' + x; })).join('<br>');
      return '<tr><td>' + esc(t.key) + '</td><td>' + esc(t.role) + '</td><td>' + esc(t.title) + '</td><td>' + esc(t.depends_on.join(', ') || '—') +
        '</td><td class="small">' + (contract ? esc(contract).replace(/&lt;br&gt;/g, '<br>') : '—') + '</td><td>' + (t.needs_decision ? '<span class="pill warn">先問你</span>' : '') + '</td></tr>';
    }).join('');
    return '<div class="card wide" data-plan="' + esc(p.id) + '">' +
      '<div class="row small dim"><span class="tag">計畫 ' + esc(p.id) + '</span><span>第 ' + p.revision + ' 版</span>' +
        (p.prd ? '<a href="#" data-prd="' + esc(p.prd.name) + '" data-version="' + p.prd.version + '">PRD ' + esc(p.prd.name) + ' v' + p.prd.version + '（一起核准）</a>' : '') + '</div>' +
      '<h3>' + esc(p.goal || p.title) + '</h3>' +
      (p.summary ? '<div class="dim">' + esc(p.summary) + '</div>' : '') +
      '<table><tr><th>KEY</th><th>角色</th><th>Task</th><th>在…之後</th><th>契約</th><th></th></tr>' + rows + '</table>' +
      '<textarea placeholder="退回時必填：要 planner 改什麼"></textarea>' +
      '<div class="row"><button class="primary" data-plan-act="approve">核准（建立 ' + p.tasks.length + ' 個 task）</button>' +
      '<button data-plan-act="reject">退回修改</button><button class="danger" data-plan-act="cancel">取消計畫</button></div></div>';
  }

  function prdCard(p) {
    var from = Math.min.apply(null, p.unseen) - 1;
    return '<div class="card"><div class="row small dim"><span class="tag">PRD 改版</span><span>' + esc(time(p.latest_at)) + '</span></div>' +
      '<h3>' + esc(p.name) + ' v' + p.unseen.join(', v') + '</h3>' +
      '<div class="dim">' + esc(p.latest_by) + (p.note ? '：' + esc(p.note) : '') + '</div>' +
      '<div class="row"><button class="primary" data-prd-diff="' + esc(p.name) + '" data-from="' + from + '" data-to="' + p.latest + '">看差異</button></div></div>';
  }

  function roleCard(r) {
    var agents = r.agents.map(function (a) {
      return '<div><span class="dot ' + esc(a.status) + '"></span>' + esc(a.name) + ' <span class="dim small">' + esc(a.status) +
        (a.current_task ? ' · <a href="#" data-task="' + esc(a.current_task) + '">' + esc(a.current_task_title || a.current_task) + '</a>' : '') + '</span></div>';
    }).join('') || '<div class="dim small">還沒有 agent（orchestrator 啟動時會建立）</div>';
    return '<div class="card"><div class="row"><h3>' + esc(r.name) + '</h3>' +
      (r.paused ? '<span class="pill bad" title="' + esc(r.paused.reason) + '">額度暫停到 ' + esc(time(r.paused.until)) + '</span>' : '') + '</div>' +
      '<div class="dim small">' + esc([r.adapter, r.model, r.effort].filter(Boolean).join(' · ')) + ' · ' + r.replicas + ' 個 agent' + (r.description ? ' — ' + esc(r.description) : '') + '</div>' +
      (r.paused ? '<div class="small dim">' + esc(r.paused.reason) + '</div>' : '') +
      '<div class="agents">' + agents + '</div></div>';
  }

  function reviewPill(r) {
    var rv = { pending: '審查中', passed: '審查通過', changes: '審查退回', escalated: '審查待你決定' }[r.status] || r.status;
    return '<span class="pill ' + (r.status === 'passed' ? 'ok' : r.status === 'pending' ? '' : 'warn') + '">' + esc(rv) + ' · 第 ' + r.round + ' 輪' + (r.open ? ' · ' + r.open + ' 個 must-fix' : '') + '</span>';
  }

  /** Approve / send back a task in review (inbox card and task detail). */
  function taskActions(id, note) {
    return '<div data-task-box="' + esc(id) + '">' +
      (note ? '<div class="small" style="color:var(--warn)">' + esc(note) + '</div>' : '') +
      '<textarea placeholder="退回時必填：要 agent 改什麼"></textarea>' +
      '<div class="row"><button class="primary" data-task-act="approve">核准並合併</button><button data-task-act="reject">退回重做</button></div></div>';
  }

  function approveCard(t) {
    return '<div class="card"><div class="row small dim"><span class="tag">等你核准</span><span>' + esc([t.role, t.agent].filter(Boolean).join(' · ')) + '</span><span>' + esc(time(t.updated_at)) + '</span></div>' +
      '<h3><a href="#" data-task="' + esc(t.id) + '">' + esc(t.title) + '</a></h3>' +
      '<div class="row small">' +
        (t.delivery ? '<span class="pill ' + (t.delivery.status === 'done' ? 'ok' : 'warn') + '">交付：' + esc(DELIVERY[t.delivery.status] || t.delivery.status) + '</span>' : '') +
        (t.review ? reviewPill(t.review) : '') +
        '<a href="#" data-task="' + esc(t.id) + '">看交付報告與變更</a></div>' +
      taskActions(t.id) + '</div>';
  }

  function taskTable(tasks) {
    var groups = {};
    tasks.forEach(function (t) { var k = t.role || '（未指定角色）'; (groups[k] = groups[k] || []).push(t); });
    var keys = Object.keys(groups).sort();
    if (!keys.length) return '<div class="empty">沒有 task</div>';
    return keys.map(function (k) {
      var rows = groups[k].map(function (t) {
        var extra = [];
        if (KIND[t.kind]) extra.push('<span class="tag">' + KIND[t.kind] + '</span>');
        if (t.waiting_for.length) extra.push('<span class="small dim">等待：' + esc(t.waiting_for.join('、')) + '</span>');
        if (t.send_backs) extra.push('<span class="small" style="color:var(--warn)">退回 ' + t.send_backs + ' 次</span>');
        if (t.uses) extra.push('<span class="small dim">契約：' + esc(t.uses.join(', ')) + '</span>');
        if (t.review) extra.push(reviewPill(t.review));
        return '<tr class="click" data-task="' + esc(t.id) + '"><td>' + statusBadge(t.status) + '</td><td>' + esc(t.title) + ' ' + extra.join(' ') +
          '</td><td class="small">' + esc(t.agent || '') + '</td><td class="small">' +
          (t.delivery ? '<span class="pill ' + (t.delivery.status === 'done' ? 'ok' : 'warn') + '">' + esc(DELIVERY[t.delivery.status] || t.delivery.status) + '</span>' : '') +
          '</td><td class="small dim">' + esc(time(t.updated_at)) + '</td></tr>';
      }).join('');
      return '<h3 style="margin:10px 0 4px">' + esc(k) + '</h3><table><tr><th style="width:90px">狀態</th><th>Task</th><th style="width:110px">Agent</th><th style="width:90px">交付</th><th style="width:170px">更新</th></tr>' + rows + '</table>';
    }).join('');
  }

  function render() {
    var s = state; if (!s) return;
    $('project').textContent = s.project + ' · ORCH';
    var o = s.orchestrator;
    $('orch').className = 'pill ' + (o.running ? 'ok' : 'bad');
    $('orch').textContent = o.running ? 'orchestrator 執行中' + (o.in_process ? '（本視窗）' : ' · pid ' + o.pid) + ' · ' + o.running_tasks + ' 個 task 進行中' : 'orchestrator 沒有在跑（orch dashboard --run 或 orch run --watch）';
    var mine = s.decisions.mine.filter(function (d) { return d.source !== 'plan'; });
    var plans = s.plans.filter(function (p) { return p.status === 'awaiting_approval'; });
    var prds = s.prds.filter(function (p) { return p.unseen.length; });
    var toApprove = (s.to_approve || []).map(function (id) { return s.tasks.find(function (t) { return t.id === id; }); }).filter(Boolean);
    var inbox = mine.length + plans.length + prds.length + toApprove.length;
    var visible = s.tasks.filter(function (t) { return showFinished || (t.status !== 'done' && t.status !== 'cancelled'); });
    var others = s.plans.filter(function (p) { return p.status !== 'awaiting_approval'; });

    var html = '';
    html += '<section><h2>需要你處理 <span class="count' + (inbox ? ' hot' : '') + '">' + inbox + '</span></h2>' +
      (inbox ? '<div class="cards">' + plans.map(planCard).join('') + mine.map(function (d) { return decisionCard(d, false); }).join('') + toApprove.map(approveCard).join('') + prds.map(prdCard).join('') + '</div>' : '<div class="empty">目前沒有要你處理的事</div>') + '</section>';
    if (s.decisions.with_roles.length) {
      html += '<section><h2>PM 處理中 <span class="count">' + s.decisions.with_roles.length + '</span> <span class="dim small">PM 會回答或轉給你；你也可以直接回答</span></h2><div class="cards">' +
        s.decisions.with_roles.map(function (d) { return decisionCard(d, true); }).join('') + '</div></section>';
    }
    html += '<section><h2>角色 <span class="count">' + s.roles.length + '</span></h2><div class="cards">' + s.roles.map(roleCard).join('') +
      (s.other_agents.length ? roleCard({ name: '（不屬於角色的 agent）', adapter: '', replicas: s.other_agents.length, agents: s.other_agents }) : '') + '</div></section>';
    html += '<section><h2>Tasks <span class="count">' + visible.length + ' / ' + s.tasks.length + '</span>' +
      '<label class="row small dim" style="margin-left:auto"><input type="checkbox" id="show-finished"' + (showFinished ? ' checked' : '') + '> 顯示已完成 / 已取消</label></h2>' + taskTable(visible) + '</section>';
    if (others.length) {
      html += '<section><h2>計畫</h2><table><tr><th>計畫</th><th>狀態</th><th>版本</th><th>Task</th><th>更新</th></tr>' + others.map(function (p) {
        return '<tr><td>' + esc(p.goal || p.title) + ' <span class="dim small">' + esc(p.id) + '</span></td><td>' + esc({ planning: '規劃中', approved: '已核准', cancelled: '已取消' }[p.status] || p.status) +
          '</td><td>' + p.revision + '</td><td>' + (p.created_tasks || p.tasks.length) + '</td><td class="small dim">' + esc(time(p.updated_at)) + '</td></tr>';
      }).join('') + '</table></section>';
    }
    if (s.prds.length) {
      html += '<section><h2>PRD</h2><table><tr><th>名稱</th><th>最新</th><th>寫的人</th><th>說明</th><th></th></tr>' + s.prds.map(function (p) {
        return '<tr><td>' + esc(p.name) + '</td><td>v' + p.latest + '</td><td>' + esc(p.latest_by) + '</td><td class="small">' + esc(p.note || '') + '</td><td><a href="#" data-prd="' + esc(p.name) + '" data-version="' + p.latest + '">看內容</a></td></tr>';
      }).join('') + '</table></section>';
    }
    if (s.decisions.recent.length) {
      html += '<section><h2>最近的決定</h2><table>' + s.decisions.recent.map(function (d) {
        var a = d.answer || {};
        return '<tr><td class="small dim" style="width:170px">' + esc(time(a.answered_at)) + '</td><td>' + esc(d.question) + '</td><td>→ ' + esc([a.choice, a.message].filter(Boolean).join(' — ') || a.action) +
          (a.answered_by && a.answered_by !== 'human' ? ' <span class="tag">' + esc(a.answered_by) + '</span>' : '') + '</td></tr>';
      }).join('') + '</table></section>';
    }
    $('main').innerHTML = html;
  }

  // ── modal views ──────────────────────────────────────────────
  function openModal(html) { $('modal-box').innerHTML = html + '<div class="row"><button data-close>關閉</button></div>'; $('modal').classList.add('open'); }
  function closeModal() { $('modal').classList.remove('open'); }

  /** Task detail: approve / send back a work task in review. Paperwork (plans, PRDs, reviews...) finishes by itself. */
  function reviewBlock(t) {
    if (t.status !== 'review') return '';
    if (t.plan_id || t.prd_draft || t.triage_decision_id || t.review_of || (t.verify_bugs && t.verify_bugs.length)) return '';
    if (t.approved) return '<div class="small dim">已核准，等待同步與合併</div>';
    return taskActions(t.id, t.review && t.review.status === 'pending' ? 'reviewer 還在審，現在核准會略過審查' : '');
  }

  function showTask(id) {
    api('/api/task?id=' + encodeURIComponent(id)).then(function (r) {
      var t = r.task, d = r.delivery;
      var html = '<div class="row">' + statusBadge(t.status) + '<h3 style="margin:0">' + esc(t.title) + '</h3><span class="dim small">' + esc(t.id) + '</span></div>' +
        '<div class="small dim">' + esc(['角色 ' + (t.role || '—'), '嘗試 ' + t.attempts + '/' + t.max_attempts, t.prd ? 'PRD ' + t.prd : '', t.uses ? '契約 ' + t.uses.join(', ') : '', t.produces ? '產出 ' + t.produces.join(', ') : ''].filter(Boolean).join(' · ')) + '</div>' +
        '<details open><summary>描述</summary><pre>' + esc(t.description || '（無）') + '</pre></details>' +
        (t.feedback ? '<details open><summary>回饋 / 退回原因</summary><pre>' + esc(t.feedback) + '</pre></details>' : '') +
        (d ? '<details open><summary>交付報告（' + esc(DELIVERY[d.status] || d.status) + ' · ' + esc(d.submitted_by) + ' · ' + esc(time(d.submitted_at)) + '）</summary><pre>' + esc(d.report) + '</pre></details>' : '') +
        (r.decisions.length ? '<details open><summary>決策</summary><pre>' + esc(r.decisions.map(function (x) { return (x.status === 'pending' ? '[等回答] ' : '[已回答] ') + x.question + (x.answer ? '\\n  → ' + [x.answer.choice, x.answer.message].filter(Boolean).join(' — ') : ''); }).join('\\n')) + '</pre></details>' : '') +
        (t.proof && t.proof.files_changed && t.proof.files_changed.length ? '<details><summary>變更的檔案</summary><pre>' + esc(t.proof.files_changed.join('\\n')) + '</pre></details>' : '') +
        (t.proof && t.proof.agent_summary ? '<details><summary>agent 摘要</summary><pre>' + esc(t.proof.agent_summary) + '</pre></details>' : '') +
        reviewBlock(t) +
        (['done', 'failed', 'cancelled'].indexOf(t.status) === -1 ? '<div class="row"><button class="danger" data-cancel-task="' + esc(t.id) + '">取消這個 task</button><span class="small dim">取消後會刪掉它的 worktree 與分支</span></div>' : '');
      openModal(html);
    }).catch(function (e) { toast(e.message, true); });
  }

  function diffHtml(text) {
    return text.split('\\n').map(function (l) {
      var c = l.charAt(0) === '+' ? 'diff-add' : l.charAt(0) === '-' ? 'diff-del' : l.indexOf('@@') === 0 ? 'diff-hunk' : '';
      return '<span class="' + c + '">' + esc(l) + '</span>';
    }).join('\\n');
  }

  function showPrd(name, version, from) {
    var q = '/api/prd?name=' + encodeURIComponent(name) + '&version=' + version + (from > 0 ? '&from=' + from : '');
    api(q).then(function (r) {
      var v = r.version;
      var html = '<h3 style="margin:0">PRD ' + esc(v.name) + ' v' + v.version + '</h3><div class="small dim">' + esc(v.created_by) + ' · ' + esc(time(v.created_at)) + (v.note ? ' · ' + esc(v.note) : '') + '</div>';
      if (r.diff !== undefined) {
        html += '<div class="small dim">與 v' + r.from.version + ' 的差異</div><pre>' + diffHtml(r.diff) + '</pre>';
        if (r.done_before.length) html += '<div class="small">照舊版做完的 task：' + esc(r.done_before.map(function (t) { return t.title; }).join('、')) + '<br><span class="dim">要跟著改的話：orch plan new --prd ' + esc(v.name) + ' --since ' + r.from.version + '</span></div>';
      }
      html += '<details' + (r.diff === undefined ? ' open' : '') + '><summary>全文</summary><pre>' + esc(v.content) + '</pre></details>';
      if (r.diff !== undefined) html += '<div class="row"><button class="primary" data-prd-seen="' + esc(v.name) + '" data-version="' + v.version + '">標為已讀</button></div>';
      openModal(html);
    }).catch(function (e) { toast(e.message, true); });
  }

  // ── events ───────────────────────────────────────────────────
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-task],[data-answer],[data-plan-act],[data-prd],[data-prd-diff],[data-prd-seen],[data-cancel-task],[data-task-act],[data-close]') : null;
    if (!el) { if (ev.target === $('modal')) closeModal(); return; }
    if (el.hasAttribute('data-close')) { closeModal(); return; }
    if (el.hasAttribute('data-answer')) {
      var card = el.closest('[data-decision]');
      var picked = card.querySelector('input[type=radio]:checked');
      var msg = card.querySelector('textarea').value.trim();
      var action = el.getAttribute('data-answer');
      if (action === 'continue' && !picked && !msg) { toast('請選一個選項或填寫回答', true); return; }
      act({ type: 'decision_answer', id: card.getAttribute('data-decision'), choice: picked ? picked.value : undefined, message: msg || undefined, action: action,
        project: card.querySelector('[data-project]').checked }, el,
        action === 'approve' ? '核准這個 task？（會照現狀同步、驗證並合併）' : action === 'cancel' ? '取消這個 task？（會刪掉它的 worktree 與分支）' : null);
      return;
    }
    if (el.hasAttribute('data-plan-act')) {
      var pc = el.closest('[data-plan]'); var id = pc.getAttribute('data-plan'); var fb = pc.querySelector('textarea').value.trim();
      var a = el.getAttribute('data-plan-act');
      if (a === 'approve') act({ type: 'plan_approve', id: id, message: fb || undefined }, el, '核准計畫並建立它的 task？');
      else if (a === 'reject') { if (!fb) { toast('退回要寫明要改什麼', true); return; } act({ type: 'plan_reject', id: id, message: fb }, el); }
      else act({ type: 'plan_cancel', id: id }, el, '取消這個計畫？');
      return;
    }
    if (el.hasAttribute('data-task-act')) {
      var tb = el.closest('[data-task-box]'); var tid = tb.getAttribute('data-task-box'); var why = tb.querySelector('textarea').value.trim();
      if (el.getAttribute('data-task-act') === 'approve') act({ type: 'task_approve', id: tid }, el, '核准並合併這個 task？（會先合併最新 main 再驗證）');
      else { if (!why) { toast('退回要寫明要改什麼', true); return; } act({ type: 'task_reject', id: tid, message: why }, el); }
      return;
    }
    if (el.hasAttribute('data-cancel-task')) { act({ type: 'task_cancel', id: el.getAttribute('data-cancel-task') }, el, '取消這個 task？（會刪掉它的 worktree 與分支）'); return; }
    if (el.hasAttribute('data-prd-seen')) { act({ type: 'prd_seen', name: el.getAttribute('data-prd-seen'), version: Number(el.getAttribute('data-version')) }, el); return; }
    ev.preventDefault();
    if (el.hasAttribute('data-prd-diff')) { showPrd(el.getAttribute('data-prd-diff'), Number(el.getAttribute('data-to')), Number(el.getAttribute('data-from'))); return; }
    if (el.hasAttribute('data-prd')) { showPrd(el.getAttribute('data-prd'), Number(el.getAttribute('data-version')), 0); return; }
    if (el.hasAttribute('data-task')) showTask(el.getAttribute('data-task'));
  });
  document.addEventListener('change', function (ev) {
    if (ev.target && ev.target.id === 'show-finished') {
      showFinished = ev.target.checked;
      try { localStorage.setItem('orch-show-finished', showFinished ? '1' : '0'); } catch (e) {}
      render();
    }
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeModal(); });

  /** Do not re-render under the user's hands (typing, a dialog, a picked option). */
  function busy() {
    if ($('modal').classList.contains('open')) return true;
    var a = document.activeElement;
    if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') && a.type !== 'checkbox') return true;
    var typed = Array.prototype.some.call(document.querySelectorAll('textarea'), function (t) { return t.value.trim() !== ''; });
    return typed || document.querySelector('input[type=radio]:checked') !== null;
  }

  function refresh(force) {
    api('/api/state').then(function (s) {
      state = s;
      $('updated').textContent = '更新於 ' + new Date(s.generated_at).toLocaleTimeString();
      var key = JSON.stringify(Object.assign({}, s, { generated_at: '' }));
      if (!force && key === lastKey) return; // nothing changed: leave the page alone
      if (force || !busy()) {
        lastKey = key;
        var y = window.scrollY;
        var open = Array.prototype.map.call(document.querySelectorAll('main details'), function (d) { return d.open; });
        render();
        Array.prototype.forEach.call(document.querySelectorAll('main details'), function (d, i) { if (open[i]) d.open = true; });
        window.scrollTo(0, y);
        $('paused').textContent = '';
      } else $('paused').textContent = '（有新資料，你在輸入中所以暫停更新）';
    }).catch(function (e) {
      $('orch').className = 'pill bad'; $('orch').textContent = '連不到 dashboard：' + e.message;
    });
  }
  refresh(true);
  setInterval(function () { refresh(false); }, 5000);
})();
</script>
</body>
</html>`;
}
