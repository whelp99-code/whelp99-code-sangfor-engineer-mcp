// 서버렌더 단일 HTML + vanilla JS. 클라이언트 JS는 이 서버측 템플릿 리터럴 안에
// 들어가므로 backtick과 ${ 를 절대 쓰지 않는다(문자열 연결만).
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sangfor Control Tower</title>
  <style>
    :root { --bg:#0f172a; --card:#1e293b; --accent:#38bdf8; --text:#e2e8f0; --muted:#94a3b8; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; }
    * { box-sizing:border-box; }
    body { margin:0; font-family:Segoe UI,system-ui,sans-serif; background:var(--bg); color:var(--text); }
    header { padding:14px 22px; border-bottom:1px solid #334155; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
    h1 { margin:0; font-size:1.2rem; }
    .auth-box { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .auth-box input { width:220px; }
    main { display:grid; grid-template-columns:190px 1fr; min-height:calc(100vh - 54px); }
    nav { padding:14px; border-right:1px solid #334155; }
    nav button, nav a.ext { display:block; width:100%; text-align:left; margin:4px 0; padding:9px 11px; border:1px solid #334155; border-radius:8px; background:var(--card); color:var(--text); cursor:pointer; font-size:.9rem; text-decoration:none; }
    nav button.active { border-color:var(--accent); background:#0c4a6e; }
    section { padding:18px 22px; overflow:auto; }
    .panel { display:none; }
    .panel.active { display:block; }
    .grid4 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
    .card { background:var(--card); border:1px solid #334155; border-radius:12px; padding:14px; }
    .card h3 { margin:0 0 10px; font-size:.95rem; color:var(--accent); }
    .meta { color:var(--muted); font-size:.82rem; }
    table { width:100%; border-collapse:collapse; font-size:.85rem; }
    th, td { text-align:left; padding:6px 8px; border-bottom:1px solid #334155; vertical-align:top; }
    tr.clickable { cursor:pointer; }
    tr.clickable:hover { background:#0c4a6e33; }
    label { display:block; margin:8px 0 4px; font-size:.85rem; color:var(--muted); }
    input, select, textarea { width:100%; padding:8px 10px; border:1px solid #334155; border-radius:8px; background:#0b1220; color:var(--text); font:inherit; }
    textarea { min-height:70px; resize:vertical; font-family:ui-monospace,monospace; }
    button.primary { margin-top:10px; padding:9px 14px; border:none; border-radius:8px; background:var(--accent); color:#0f172a; font-weight:600; cursor:pointer; }
    button.small { padding:4px 9px; border:1px solid #334155; border-radius:6px; background:#0b1220; color:var(--text); cursor:pointer; font-size:.8rem; margin-right:4px; }
    pre.result { background:#0b1220; border:1px solid #334155; border-radius:10px; padding:12px; overflow:auto; max-height:420px; font-size:.78rem; white-space:pre-wrap; word-break:break-word; }
    .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:.72rem; font-weight:600; }
    .sf-read_only { background:#14532d; color:var(--ok); }
    .sf-write { background:#78350f; color:var(--warn); }
    .sf-destructive { background:#7f1d1d; color:var(--err); }
    .st-succeeded { color:var(--ok); }
    .st-failed { color:var(--err); }
    .st-pending_approval { color:var(--warn); }
    .st-running { color:var(--accent); }
    .st-rejected { color:var(--muted); }
    .hl-ok { color:var(--ok); }
    .hl-bad { color:var(--err); }
    .tabbar button { margin:0 6px 8px 0; }
    .tool-item { margin:4px 0; }
    .filters { display:flex; gap:8px; flex-wrap:wrap; align-items:end; margin-bottom:10px; }
    .filters > div { min-width:130px; }
    #run-modal { display:none; position:fixed; inset:0; background:#000a; padding:5vh 8vw; z-index:10; }
    #run-modal .card { max-height:88vh; overflow:auto; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    @media (max-width:860px) { main { grid-template-columns:1fr; } .grid4, .row2 { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Sangfor Control Tower</h1>
    <div class="auth-box">
      <input id="api-token" type="password" autocomplete="off" placeholder="API bearer token" />
      <button class="small" id="save-token" type="button">토큰 저장</button>
      <span class="meta">:3700 · bridge :3600</span>
    </div>
  </header>
  <main>
    <nav id="nav">
      <button data-panel="dashboard" class="active">대시보드</button>
      <button data-panel="tools">도구 실행</button>
      <button data-panel="runs">실행 이력</button>
      <button data-panel="devices">장비 관리</button>
      <button data-panel="playbooks">플레이북</button>
      <a class="ext" href="http://localhost:3502" target="_blank">운영콘솔 :3502 ↗</a>
      <a class="ext" href="http://localhost:3400" target="_blank">Mock콘솔 :3400 ↗</a>
    </nav>
    <section>
      <div id="dashboard" class="panel active">
        <button class="small" onclick="loadOverview()">새로고침</button>
        <div class="grid4" style="margin-top:10px">
          <div class="card"><h3>장비 · 자문 요약</h3><div id="w-devices" class="meta">로딩…</div></div>
          <div class="card"><h3>시스템 건강도</h3><div id="w-health" class="meta">로딩…</div></div>
          <div class="card"><h3>승인 대기 큐</h3><div id="w-pending" class="meta">로딩…</div></div>
          <div class="card"><h3>최근 실행 20건</h3><div id="w-recent" class="meta">로딩…</div></div>
        </div>
      </div>

      <div id="tools" class="panel">
        <div class="tabbar" id="tool-tabs"></div>
        <div class="row2">
          <div class="card"><h3>도구 목록</h3><div id="tool-list" class="meta">카테고리를 선택하세요</div></div>
          <div class="card">
            <h3 id="tf-title">도구 선택 대기</h3>
            <div id="tf-device-row" style="display:none"><label>장비 (선택 시 인자 자동 주입)</label><select id="tf-device"></select></div>
            <div id="tf-fields"></div>
            <div id="tf-actions" style="display:none">
              <button class="primary" onclick="runTool()">실행</button>
              <button class="small" onclick="mintToken()" style="margin-left:8px">승인 토큰 민팅 (HCI tool-args용)</button>
            </div>
            <pre class="result" id="tf-result" style="display:none"></pre>
          </div>
        </div>
      </div>

      <div id="runs" class="panel">
        <div class="filters">
          <div><label>상태</label><select id="rf-status"><option value="">전체</option><option>pending_approval</option><option>running</option><option>succeeded</option><option>failed</option><option>rejected</option></select></div>
          <div><label>도구</label><input id="rf-tool" placeholder="sangfor.advisor_..." /></div>
          <div><label>장비 ID</label><input id="rf-device" /></div>
          <div><label>Sweep ID</label><input id="rf-sweep" /></div>
          <div><label>기간(일)</label><input id="rf-since" type="number" value="14" /></div>
          <div><button class="primary" onclick="loadRuns()">조회</button></div>
        </div>
        <div class="card"><table id="runs-table"><thead><tr><th>시각</th><th>도구</th><th>안전등급</th><th>상태</th><th>소요</th><th>요약</th></tr></thead><tbody></tbody></table></div>
      </div>

      <div id="devices" class="panel">
        <div class="row2">
          <div class="card">
            <h3>장비 목록</h3>
            <button class="primary" id="btn-sweep" onclick="runSweep()">전체 일괄 자문 실행</button>
            <table id="devices-table" style="margin-top:10px"><thead><tr><th>이름</th><th>제품</th><th>host</th><th>태그</th><th></th></tr></thead><tbody></tbody></table>
          </div>
          <div class="card">
            <h3 id="df-title">장비 등록</h3>
            <label>이름 *</label><input id="df-name" />
            <label>제품 *</label><select id="df-product"></select>
            <label>host *</label><input id="df-host" placeholder="10.0.0.1 또는 http://127.0.0.1:3400" />
            <label>태그 (쉼표 구분)</label><input id="df-tags" />
            <label>credentialEnv (JSON — 값은 env 변수 이름)</label><textarea id="df-credenv" placeholder='{"username":"FGT_LAB_USER","password":"FGT_LAB_PASS"}'></textarea>
            <button class="primary" onclick="saveDevice()">저장</button>
            <button class="small" onclick="resetDeviceForm()" style="margin-left:8px">초기화</button>
          </div>
        </div>
      </div>

      <div id="playbooks" class="panel">
        <div class="row2">
          <div class="card">
            <h3>플레이북 목록</h3>
            <button class="primary" onclick="requestAssemble()">AI 조립 요청</button>
            <table id="pb-table" style="margin-top:10px"><thead><tr><th>이름</th><th>목표</th><th>활성rev</th><th>최근실행</th></tr></thead><tbody></tbody></table>
            <h3 style="margin-top:16px">에이전트 작업 큐 (open)</h3>
            <div id="pb-tasks" class="meta">로딩…</div>
          </div>
          <div class="card">
            <h3 id="pb-detail-title">플레이북 선택 대기</h3>
            <div id="pb-detail" class="meta">좌측에서 선택하세요.</div>
          </div>
        </div>
      </div>
    </section>
  </main>

  <div id="run-modal" onclick="if(event.target===this)this.style.display='none'">
    <div class="card">
      <button class="small" onclick="document.getElementById('run-modal').style.display='none'">닫기</button>
      <pre class="result" id="run-modal-pre"></pre>
    </div>
  </div>

<script>
(function () {
  'use strict';
  var TOKEN_KEY = 'sangfor_api_token';
  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function headers(json) {
    var h = json ? { 'content-type': 'application/json' } : {};
    var t = (localStorage.getItem(TOKEN_KEY) || '').trim();
    if (t) h.authorization = 'Bearer ' + t;
    return h;
  }
  function req(method, path, body) {
    return fetch(path, {
      method: method, headers: headers(body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      });
    });
  }
  function fail(err) { alert('오류: ' + err.message); }
  function when(iso) { return iso ? String(iso).replace('T', ' ').slice(5, 19) : '-'; }
  function statusHtml(s) { return '<span class="st-' + esc(s) + '">' + esc(s) + '</span>'; }
  function safetyHtml(s) { return '<span class="badge sf-' + esc(s) + '">' + esc(s) + '</span>'; }

  // ── 네비 ──
  var navButtons = document.querySelectorAll('#nav button');
  navButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      navButtons.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
      $(btn.dataset.panel).classList.add('active');
      if (btn.dataset.panel === 'dashboard') loadOverview();
      if (btn.dataset.panel === 'tools') loadTools();
      if (btn.dataset.panel === 'runs') loadRuns();
      if (btn.dataset.panel === 'devices') loadDevices();
      if (btn.dataset.panel === 'playbooks') loadPlaybooks();
    });
  });
  $('api-token').value = localStorage.getItem(TOKEN_KEY) || '';
  $('save-token').addEventListener('click', function () {
    localStorage.setItem(TOKEN_KEY, $('api-token').value.trim());
    loadOverview();
  });

  // ── 대시보드 ──
  window.loadOverview = function () {
    req('GET', '/api/overview').then(function (o) {
      $('w-devices').innerHTML = o.devices.length === 0 ? '등록된 장비 없음' : o.devices.map(function (d) {
        var adv = d.lastAdvisory;
        var badge = !adv ? '<span class="meta">미점검</span>'
          : adv.ok === undefined ? statusHtml(adv.status)
          : '<span class="' + (adv.ok ? 'hl-ok' : 'hl-bad') + '">' + (adv.ok ? 'OK' : 'FAIL') + ' pass=' + adv.pass + ' fail=' + adv.fail + '</span> <span class="meta">' + when(adv.finishedAt) + '</span>';
        return '<div style="margin:6px 0"><strong>' + esc(d.name) + '</strong> <span class="meta">' + esc(d.productLabel) + ' · ' + esc(d.host) + '</span><br/>' + badge + '</div>';
      }).join('');
      $('w-recent').innerHTML = o.recentRuns.length === 0 ? '실행 이력 없음' : '<table><tbody>' + o.recentRuns.map(function (r) {
        return '<tr class="clickable" onclick="showRun(\'' + esc(r.runId) + '\')"><td>' + when(r.requestedAt) + '</td><td>' + esc(r.toolId) + '</td><td>' + statusHtml(r.status) + '</td><td>' + (r.durationMs == null ? '-' : r.durationMs + 'ms') + '</td></tr>';
      }).join('') + '</tbody></table>';
      $('w-pending').innerHTML = o.pendingApprovals.length === 0 ? '대기 없음' : o.pendingApprovals.map(function (r) {
        return '<div style="margin:6px 0"><strong>' + esc(r.toolId) + '</strong> <span class="meta">' + when(r.requestedAt) + '</span><br/><span class="meta">' + esc(JSON.stringify(r.args)).slice(0, 120) + '</span><br/>'
          + '<button class="small" onclick="approveRun(\'' + esc(r.runId) + '\')">승인</button>'
          + '<button class="small" onclick="rejectRun(\'' + esc(r.runId) + '\')">거부</button></div>';
      }).join('');
      var order = ['bridge', 'mcp', 'mockConsole', 'store', 'rag'];
      $('w-health').innerHTML = order.map(function (k) {
        var h = o.health[k];
        return '<div><span class="' + (h.ok ? 'hl-ok' : 'hl-bad') + '">●</span> ' + k + ' <span class="meta">' + esc(h.detail) + '</span></div>';
      }).join('');
    }).catch(fail);
  };
  window.approveRun = function (runId) {
    var by = prompt('승인자 ID (approvedBy)');
    if (!by) return;
    req('POST', '/api/runs/' + runId + '/approve', { approvedBy: by })
      .then(function (r) { alert('실행 결과: ' + r.status + (r.error ? ' — ' + r.error : '')); loadOverview(); })
      .catch(fail);
  };
  window.rejectRun = function (runId) {
    var reason = prompt('거부 사유');
    if (!reason) return;
    req('POST', '/api/runs/' + runId + '/reject', { reason: reason })
      .then(function () { loadOverview(); }).catch(fail);
  };

  // ── 도구 실행 ──
  var toolGroups = {};
  var currentTool = null;
  var deviceCache = { devices: [], vendors: [] };
  window.loadTools = function () {
    Promise.all([req('GET', '/api/tools'), req('GET', '/api/devices')]).then(function (results) {
      toolGroups = results[0].groups;
      deviceCache = results[1];
      $('tool-tabs').innerHTML = Object.keys(toolGroups).sort().map(function (cat) {
        return '<button class="small" onclick="showCategory(\'' + esc(cat) + '\')">' + esc(cat) + ' (' + toolGroups[cat].length + ')</button>';
      }).join('');
    }).catch(fail);
  };
  window.showCategory = function (cat) {
    $('tool-list').innerHTML = toolGroups[cat].map(function (t) {
      var safety = t.annotations.destructiveHint ? 'destructive' : (t.annotations.readOnlyHint ? 'read_only' : 'write');
      return '<div class="tool-item">' + safetyHtml(safety) + ' <a href="#" onclick="selectTool(\'' + esc(cat) + '\',\'' + esc(t.name) + '\');return false" style="color:var(--accent)">' + esc(t.name) + '</a><br/><span class="meta">' + esc(t.description).slice(0, 140) + '</span></div>';
    }).join('');
  };
  window.selectTool = function (cat, name) {
    currentTool = toolGroups[cat].find(function (t) { return t.name === name; });
    $('tf-title').textContent = name;
    $('tf-actions').style.display = 'block';
    $('tf-result').style.display = 'none';
    var devOptions = '<option value="">(장비 미지정)</option>' + deviceCache.devices.map(function (d) {
      return '<option value="' + esc(d.id) + '">' + esc(d.name) + ' (' + esc(d.product) + ')</option>';
    }).join('');
    $('tf-device').innerHTML = devOptions;
    $('tf-device-row').style.display = 'block';
    var props = (currentTool.inputSchema && currentTool.inputSchema.properties) || {};
    var required = (currentTool.inputSchema && currentTool.inputSchema.required) || [];
    $('tf-fields').innerHTML = Object.keys(props).map(function (key) {
      var p = props[key];
      var star = required.indexOf(key) > -1 ? ' *' : '';
      var id = 'arg-' + key;
      if (p.enum) {
        return '<label>' + esc(key) + star + '</label><select id="' + id + '" data-arg="' + esc(key) + '" data-kind="string"><option value=""></option>' + p.enum.map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('') + '</select>';
      }
      if (p.type === 'boolean') {
        return '<label>' + esc(key) + star + '</label><select id="' + id + '" data-arg="' + esc(key) + '" data-kind="boolean"><option value=""></option><option>true</option><option>false</option></select>';
      }
      if (p.type === 'number' || p.type === 'integer') {
        return '<label>' + esc(key) + star + '</label><input id="' + id + '" data-arg="' + esc(key) + '" data-kind="number" type="number" />';
      }
      if (p.type === 'string' || p.type === undefined) {
        var dflt = p.default === undefined ? '' : String(p.default);
        return '<label>' + esc(key) + star + ' <span class="meta">' + esc(p.description || '') + '</span></label><input id="' + id + '" data-arg="' + esc(key) + '" data-kind="string" value="' + esc(dflt) + '" />';
      }
      return '<label>' + esc(key) + star + ' <span class="meta">(JSON)</span></label><textarea id="' + id + '" data-arg="' + esc(key) + '" data-kind="json"></textarea>';
    }).join('');
  };
  function collectArgs() {
    var args = {};
    var nodes = document.querySelectorAll('#tf-fields [data-arg]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var raw = el.value.trim();
      if (raw === '') continue; // 빈 값은 생략 → 서버측 장비 병합이 채움
      var kind = el.dataset.kind;
      if (kind === 'number') args[el.dataset.arg] = Number(raw);
      else if (kind === 'boolean') args[el.dataset.arg] = raw === 'true';
      else if (kind === 'json') args[el.dataset.arg] = JSON.parse(raw);
      else args[el.dataset.arg] = raw;
    }
    return args;
  }
  window.runTool = function () {
    if (!currentTool) return;
    var args;
    try { args = collectArgs(); } catch (e) { return alert('JSON 인자 파싱 실패: ' + e.message); }
    var body = { toolId: currentTool.name, args: args };
    var deviceId = $('tf-device').value;
    if (deviceId) body.deviceId = deviceId;
    $('tf-result').style.display = 'block';
    $('tf-result').textContent = '실행 중…';
    req('POST', '/api/runs', body).then(function (run) {
      if (run.status === 'pending_approval') {
        $('tf-result').textContent = '승인 대기로 이동했습니다 (runId: ' + run.runId + '). 대시보드 승인 큐에서 승인/거부하세요.';
      } else {
        $('tf-result').textContent = JSON.stringify(run, null, 2);
      }
    }).catch(function (e) { $('tf-result').textContent = '오류: ' + e.message; });
  };
  window.mintToken = function () {
    var actionType = prompt('actionType (예: hci.create-volume)');
    if (!actionType) return;
    var actionTarget = prompt('actionTarget (예: 127.0.0.1:vol-a)') || undefined;
    var approvedBy = prompt('approvedBy');
    if (!approvedBy) return;
    req('POST', '/api/approvals/mint', {
      actionType: actionType, actionTarget: actionTarget, approvedBy: approvedBy,
      changeTicketId: prompt('changeTicketId', 'CHG-manual') || 'CHG-manual',
      rollbackPlanId: prompt('rollbackPlanId', 'RB-manual') || 'RB-manual',
    }).then(function (signed) {
      var el = document.querySelector('#tf-fields [data-arg="approval"]');
      if (el && el.dataset.kind === 'json') { el.value = JSON.stringify(signed); alert('approval 필드에 삽입했습니다.'); }
      else { $('tf-result').style.display = 'block'; $('tf-result').textContent = JSON.stringify(signed, null, 2); }
    }).catch(fail);
  };

  // ── 실행 이력 ──
  window.loadRuns = function () {
    var q = [];
    if ($('rf-status').value) q.push('status=' + encodeURIComponent($('rf-status').value));
    if ($('rf-tool').value.trim()) q.push('toolId=' + encodeURIComponent($('rf-tool').value.trim()));
    if ($('rf-device').value.trim()) q.push('deviceId=' + encodeURIComponent($('rf-device').value.trim()));
    if ($('rf-sweep').value.trim()) q.push('sweepId=' + encodeURIComponent($('rf-sweep').value.trim()));
    if ($('rf-since').value) q.push('sinceDays=' + encodeURIComponent($('rf-since').value));
    req('GET', '/api/runs' + (q.length ? '?' + q.join('&') : '')).then(function (data) {
      document.querySelector('#runs-table tbody').innerHTML = data.runs.map(function (r) {
        return '<tr class="clickable" onclick="showRun(\'' + esc(r.runId) + '\')">'
          + '<td>' + when(r.requestedAt) + '</td><td>' + esc(r.toolId) + '</td>'
          + '<td>' + safetyHtml(r.toolSafety) + '</td><td>' + statusHtml(r.status) + '</td>'
          + '<td>' + (r.durationMs == null ? '-' : r.durationMs + 'ms') + '</td>'
          + '<td class="meta">' + esc(r.resultSummary || r.error || '') + '</td></tr>';
      }).join('');
    }).catch(fail);
  };
  window.showRun = function (runId) {
    req('GET', '/api/runs/' + runId).then(function (run) {
      $('run-modal-pre').textContent = JSON.stringify(run, null, 2);
      $('run-modal').style.display = 'block';
    }).catch(fail);
  };

  // ── 장비 관리 ──
  var editingDeviceId = null;
  window.loadDevices = function () {
    req('GET', '/api/devices').then(function (data) {
      deviceCache = data;
      $('df-product').innerHTML = data.vendors.map(function (v) {
        return '<option value="' + esc(v.product) + '">' + esc(v.label) + ' (' + esc(v.product) + ')</option>';
      }).join('');
      document.querySelector('#devices-table tbody').innerHTML = data.devices.map(function (d) {
        return '<tr><td>' + esc(d.name) + '</td><td>' + esc(d.product) + '</td><td>' + esc(d.host) + '</td><td class="meta">' + esc(d.tags.join(', ')) + '</td>'
          + '<td><button class="small" onclick="editDevice(\'' + esc(d.id) + '\')">수정</button>'
          + '<button class="small" onclick="removeDevice(\'' + esc(d.id) + '\')">삭제</button></td></tr>';
      }).join('');
    }).catch(fail);
  };
  window.resetDeviceForm = function () {
    editingDeviceId = null;
    $('df-title').textContent = '장비 등록';
    $('df-name').value = ''; $('df-host').value = ''; $('df-tags').value = ''; $('df-credenv').value = '';
  };
  window.editDevice = function (id) {
    var d = deviceCache.devices.find(function (x) { return x.id === id; });
    if (!d) return;
    editingDeviceId = id;
    $('df-title').textContent = '장비 수정: ' + d.name;
    $('df-name').value = d.name; $('df-product').value = d.product; $('df-host').value = d.host;
    $('df-tags').value = d.tags.join(', ');
    $('df-credenv').value = d.credentialEnv ? JSON.stringify(d.credentialEnv) : '';
  };
  window.saveDevice = function () {
    var body = {
      name: $('df-name').value.trim(),
      product: $('df-product').value,
      host: $('df-host').value.trim(),
      tags: $('df-tags').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    };
    var credRaw = $('df-credenv').value.trim();
    if (credRaw) {
      try { body.credentialEnv = JSON.parse(credRaw); } catch (e) { return alert('credentialEnv JSON 파싱 실패: ' + e.message); }
    }
    var p = editingDeviceId ? req('PUT', '/api/devices/' + editingDeviceId, body) : req('POST', '/api/devices', body);
    p.then(function () { resetDeviceForm(); loadDevices(); }).catch(fail);
  };
  window.removeDevice = function (id) {
    if (!confirm('장비를 삭제할까요?')) return;
    req('DELETE', '/api/devices/' + id).then(function () { loadDevices(); }).catch(fail);
  };
  window.runSweep = function () {
    if (!confirm('등록된 전체 장비에 일괄 자문(read-only)을 실행할까요?')) return;
    $('btn-sweep').disabled = true;
    req('POST', '/api/sweep', {}).then(function (data) {
      $('btn-sweep').disabled = false;
      $('rf-sweep').value = data.sweepId;
      document.querySelector('#nav button[data-panel="runs"]').click();
    }).catch(function (e) { $('btn-sweep').disabled = false; fail(e); });
  };

  // ── 플레이북 ──
  var pbCache = {};
  window.loadPlaybooks = function () {
    Promise.all([req('GET', '/api/playbooks'), req('GET', '/api/agent-tasks?status=open')]).then(function (res) {
      var pbs = res[0].playbooks || [];
      pbCache = {};
      document.querySelector('#pb-table tbody').innerHTML = pbs.map(function (p) {
        pbCache[p.id] = p;
        var last = p.lastRun ? statusHtml(p.lastRun.status) : '<span class="meta">-</span>';
        return '<tr class="clickable" onclick="showPlaybook(\'' + esc(p.id) + '\')"><td>' + esc(p.name) + '</td><td class="meta">' + esc(p.goal).slice(0, 40) + '</td><td>' + (p.activeRev == null ? '-' : 'rev ' + p.activeRev) + '</td><td>' + last + '</td></tr>';
      }).join('');
      var tasks = res[1].tasks || [];
      $('pb-tasks').innerHTML = tasks.length === 0 ? '없음' : tasks.map(function (t) {
        return '<div style="margin:4px 0"><strong>' + esc(t.kind) + '</strong> <span class="meta">' + esc(JSON.stringify(t.payload)).slice(0, 80) + '</span> <button class="small" onclick="cancelTask(\'' + esc(t.id) + '\')">취소</button></div>';
      }).join('');
    }).catch(fail);
  };
  window.requestAssemble = function () {
    var goal = prompt('조립 목표 (goal)');
    if (!goal) return;
    req('POST', '/api/agent-tasks', { kind: 'assemble', payload: { goal: goal } })
      .then(function () { alert('AI 조립 요청을 큐에 등록했습니다. 에이전트가 draft를 제출하면 목록에 나타납니다.'); loadPlaybooks(); }).catch(fail);
  };
  window.cancelTask = function (id) {
    req('PATCH', '/api/agent-tasks/' + id, { cancel: true }).then(loadPlaybooks).catch(fail);
  };
  window.showPlaybook = function (id) {
    req('GET', '/api/playbooks/' + id).then(function (pb) {
      $('pb-detail-title').textContent = pb.name;
      var active = null;
      for (var i = pb.revisions.length - 1; i >= 0; i--) { if (pb.revisions[i].status === 'approved') { active = pb.revisions[i].rev; break; } }
      var html = '<div class="meta">' + esc(pb.goal) + '</div>';
      html += pb.revisions.map(function (r) { return renderRevision(pb.id, r, active); }).join('');
      html += '<div style="margin-top:10px"><button class="primary" ' + (active == null ? 'disabled' : '') + ' onclick="executePlaybook(\'' + esc(pb.id) + '\')">실행</button>';
      html += '<button class="small" onclick="requestRevise(\'' + esc(pb.id) + '\')" style="margin-left:8px">AI 수정 요청</button></div>';
      html += '<div id="pb-run" style="margin-top:12px"></div>';
      $('pb-detail').innerHTML = html;
    }).catch(fail);
  };
  function renderRevision(pbId, r, activeRev) {
    var badge = r.status === 'approved' ? '<span class="hl-ok">승인 rev ' + r.rev + '</span>'
      : r.status === 'rejected' ? '<span class="hl-bad">반려 rev ' + r.rev + '</span>'
      : '<span class="st-pending_approval">draft rev ' + r.rev + '</span>';
    var s = '<div class="card" style="margin:8px 0;padding:10px"><div>' + badge + (r.rev === activeRev ? ' <span class="badge sf-read_only">활성</span>' : '') + '</div>';
    s += '<div class="meta">' + (r.blocks || []).map(function (b) {
      return b.type === 'report' ? '📄 ' + esc(b.title || 'report') : '🔧 ' + esc(b.title || b.toolId) + (b.deviceId ? ' @' + esc(b.deviceId) : '');
    }).join(' → ') + '</div>';
    if (r.note) s += '<div class="meta">note: ' + esc(r.note) + '</div>';
    if (r.rejectReason) s += '<div class="hl-bad">반려사유: ' + esc(r.rejectReason) + '</div>';
    if (r.status === 'draft') {
      s += '<button class="small" onclick="reviewRev(\'' + esc(pbId) + '\',' + r.rev + ',true)">승인</button>';
      s += '<button class="small" onclick="reviewRev(\'' + esc(pbId) + '\',' + r.rev + ',false)">반려</button>';
    }
    return s + '</div>';
  }
  window.reviewRev = function (pbId, rev, approve) {
    var by = prompt('검토자 ID (reviewedBy)'); if (!by) return;
    var body = { reviewedBy: by };
    var path = '/api/playbooks/' + pbId + '/revisions/' + rev + (approve ? '/approve' : '/reject');
    if (!approve) { var reason = prompt('반려 사유'); if (!reason) return; body.reason = reason; }
    req('POST', path, body).then(function () { showPlaybook(pbId); loadPlaybooks(); }).catch(fail);
  };
  window.executePlaybook = function (pbId) {
    req('POST', '/api/playbooks/' + pbId + '/execute', {}).then(function (run) { renderRun(run.playbookRunId); }).catch(fail);
  };
  window.renderRun = function (pbrunId) {
    req('GET', '/api/playbook-runs/' + pbrunId).then(function (run) {
      var color = { succeeded: 'hl-ok', failed: 'hl-bad', partial: 'st-pending_approval', waiting_approval: 'st-pending_approval', running: 'st-running' };
      var h = '<div class="card" style="padding:10px"><div>실행 <span class="' + (color[run.status] || '') + '">' + esc(run.status) + '</span> <span class="meta">' + esc(pbrunId) + '</span></div>';
      h += '<div>' + run.blocks.map(function (b) {
        var st = b.status || '대기';
        var btn = b.status === 'pending_approval' ? ' <button class="small" onclick="approveBlock(\'' + esc(b.runId) + '\',\'' + esc(pbrunId) + '\')">승인</button><button class="small" onclick="rejectBlock(\'' + esc(b.runId) + '\',\'' + esc(pbrunId) + '\')">거부</button>' : '';
        return '<div class="meta">' + esc(b.blockId) + ': ' + statusHtml(st) + btn + '</div>';
      }).join('') + '</div>';
      h += '<button class="small" onclick="requestAnalyze(\'' + esc(pbrunId) + '\')">AI 분석 요청</button>';
      h += (run.analyses || []).map(function (a) { return renderAnalysis(a); }).join('');
      $('pb-run').innerHTML = h + '</div>';
    }).catch(fail);
  };
  window.approveBlock = function (runId, pbrunId) {
    var by = prompt('승인자 (approvedBy)'); if (!by) return;
    req('POST', '/api/runs/' + runId + '/approve', { approvedBy: by }).then(function () { renderRun(pbrunId); }).catch(fail);
  };
  window.rejectBlock = function (runId, pbrunId) {
    var reason = prompt('거부 사유'); if (!reason) return;
    req('POST', '/api/runs/' + runId + '/reject', { reason: reason }).then(function () { renderRun(pbrunId); }).catch(fail);
  };
  function renderAnalysis(a) {
    var s = '<div class="card" style="margin-top:8px;padding:10px"><div><strong>분석</strong> <span class="meta">' + esc(a.summary) + '</span></div>';
    s += (a.improvements || []).map(function (im, i) { return verdictRow(a.id, 'improvements', i, im.recommendation, im.verdict); }).join('');
    s += (a.proposals || []).map(function (pr, i) { return verdictRow(a.id, 'proposals', i, pr.action, pr.verdict); }).join('');
    return s + '</div>';
  }
  function verdictRow(anlId, part, index, label, verdict) {
    var done = verdict ? ' <span class="meta">(' + esc(verdict) + ')</span>' : '';
    var btns = verdict ? '' : '<button class="small" onclick="setVerdict(\'' + esc(anlId) + '\',\'' + part + '\',' + index + ',true)">채택</button><button class="small" onclick="setVerdict(\'' + esc(anlId) + '\',\'' + part + '\',' + index + ',false)">기각</button>';
    return '<div class="meta" style="margin:3px 0">[' + part + '] ' + esc(label) + done + ' ' + btns + '</div>';
  }
  window.setVerdict = function (anlId, part, index, accept) {
    var by = prompt('검토자'); if (!by) return;
    var body = { part: part, index: index, verdict: accept ? 'accepted' : 'dismissed', reviewedBy: by };
    if (accept && part === 'proposals') { var link = prompt('연결할 후속 플레이북 id (선택)'); if (link) body.linkedPlaybookId = link; }
    req('POST', '/api/analyses/' + anlId + '/verdict', body).then(function (a) {
      var pbrunId = a.playbookRunId; renderRun(pbrunId);
    }).catch(fail);
  };
  window.requestRevise = function (pbId) {
    var fb = prompt('수정 피드백 (feedback)'); if (!fb) return;
    req('POST', '/api/agent-tasks', { kind: 'revise', payload: { playbookId: pbId, feedback: fb } })
      .then(function () { alert('AI 수정 요청을 등록했습니다.'); loadPlaybooks(); }).catch(fail);
  };
  window.requestAnalyze = function (pbrunId) {
    req('POST', '/api/agent-tasks', { kind: 'analyze', payload: { playbookRunId: pbrunId } })
      .then(function () { alert('AI 분석 요청을 등록했습니다. 에이전트가 분석을 제출하면 이 화면에 나타납니다.'); }).catch(fail);
  };

  loadOverview();
})();
</script>
</body>
</html>`;
}
