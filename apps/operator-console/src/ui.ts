import { PRODUCTS } from '../../../packages/shared/src/index.js';

const productOptions = PRODUCTS.map(p => `<option value="${p.code}">${p.name} (${p.code})</option>`).join('');

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sangfor Engineer Web</title>
  <style>
    :root { --bg:#0f172a; --card:#1e293b; --accent:#38bdf8; --text:#e2e8f0; --muted:#94a3b8; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:Segoe UI,system-ui,sans-serif; background:var(--bg); color:var(--text); }
    header { padding:16px 24px; border-bottom:1px solid #334155; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
    h1 { margin:0; font-size:1.25rem; }
    .badge { background:#0369a1; padding:4px 10px; border-radius:999px; font-size:.75rem; }
    main { display:grid; grid-template-columns:200px 1fr; min-height:calc(100vh - 56px); }
    nav { padding:16px; border-right:1px solid #334155; }
    nav button { display:block; width:100%; text-align:left; margin:4px 0; padding:9px 11px; border:1px solid #334155; border-radius:8px; background:var(--card); color:var(--text); cursor:pointer; font-size:.9rem; }
    nav button.active { border-color:var(--accent); background:#0c4a6e; }
    section { padding:20px 24px; overflow:auto; }
    .panel { display:none; }
    .panel.active { display:block; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px; }
    .card { background:var(--card); border:1px solid #334155; border-radius:12px; padding:14px; }
    .card h3 { margin:0 0 8px; font-size:.95rem; color:var(--accent); }
    .meta { color:var(--muted); font-size:.82rem; margin-bottom:8px; }
    .stats { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
    .stat { background:var(--card); border:1px solid #334155; border-radius:10px; padding:10px 14px; min-width:100px; }
    .stat strong { display:block; font-size:1.35rem; color:var(--accent); }
    a.link { color:var(--accent); }
    label { display:block; margin:8px 0 4px; font-size:.85rem; color:var(--muted); }
    input, select, textarea { width:100%; padding:8px 10px; border:1px solid #334155; border-radius:8px; background:#0b1220; color:var(--text); font:inherit; }
    textarea { min-height:80px; resize:vertical; }
    button.primary { margin-top:12px; padding:10px 16px; border:none; border-radius:8px; background:var(--accent); color:#0f172a; font-weight:600; cursor:pointer; }
    button.primary:disabled { opacity:.5; cursor:not-allowed; }
    pre.result { background:#0b1220; border:1px solid #334155; border-radius:10px; padding:12px; overflow:auto; max-height:420px; font-size:.8rem; white-space:pre-wrap; word-break:break-word; }
    .health-ok { color:var(--ok); }
    .health-off { color:var(--muted); }
    .health-bad { color:var(--err); }
    .doc-list { list-style:none; padding:0; margin:0; }
    .doc-list li { margin:8px 0; }
    iframe { width:100%; height:360px; border:1px solid #334155; border-radius:12px; background:#fff; }
    .snippet { font-size:.88rem; line-height:1.4; max-height:4.2em; overflow:hidden; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    @media (max-width:768px) { main { grid-template-columns:1fr; } nav { display:flex; flex-wrap:wrap; gap:6px; border-right:none; border-bottom:1px solid #334155; } nav button { width:auto; } .row2 { grid-template-columns:1fr; } }
  </style>
</head>
<body>
  <header>
    <h1>Sangfor Engineer Web</h1>
    <span class="badge">MCP는 Cursor 등 stdio · 웹은 :3502</span>
  </header>
  <main>
    <nav id="nav">
      <button data-panel="dashboard" class="active">대시보드</button>
      <button data-panel="analyze">프로젝트 분석</button>
      <button data-panel="plan">설정 플랜</button>
      <button data-panel="rag">RAG 검색</button>
      <button data-panel="products">제품 어댑터</button>
      <button data-panel="feedback">피드백</button>
      <button data-panel="knowledge">지식 브라우저</button>
      <button data-panel="automation">자동화 현황</button>
    </nav>
    <section>
      <div id="dashboard" class="panel active">
        <h2>시스템 상태</h2>
        <div class="stats" id="stats"></div>
        <div class="row2">
          <div class="card"><h3>PostgreSQL Store</h3><div id="store-health" class="meta">로딩…</div></div>
          <div class="card"><h3>임베딩 / MiMo</h3><div id="embed-health" class="meta">로딩…</div></div>
        </div>
        <div class="card" style="margin-top:14px">
          <h3>문서 링크</h3>
          <ul class="doc-list">
            <li><a class="link" href="https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/blob/main/docs/design/KB_DAILY_CDP_AUTOMATION.md" target="_blank">Glass CDP — KB 일일 자동화</a> · <code>pnpm run check:glass-cdp</code></li>
            <li><a class="link" href="https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/blob/main/docs/design/RAG_SEMANTIC_EMBEDDINGS.md" target="_blank">Rapid-MLX + MiMo RAG</a> · <code>pnpm run check:embedding-providers</code></li>
            <li><a class="link" href="https://github.com/whelp99-code/whelp99-code-sangfor-engineer-mcp/blob/main/docs/LOCAL_SETUP.md#mimo-token-plan" target="_blank">MiMo Token Plan</a> (<code>tp-xxxxx</code>, APAC <code>token-plan-sgp</code>)</li>
          </ul>
        </div>
        <p class="meta" style="margin-top:14px">Mock HCI 콘솔: <a class="link" href="http://localhost:3400" target="_blank">http://localhost:3400</a></p>
        <iframe src="http://localhost:3400" title="Mock Sangfor HCI Console"></iframe>
      </div>

      <div id="automation" class="panel">
        <h2>필드 엔지니어 자동화 현황</h2>
        <p class="meta">read-only 자문/진단의 통합 가시성. "대체율"은 automatable AND field_verified atom만 카운트(정직 지표).</p>
        <div class="stats" id="auto-stats"></div>
        <div class="row2">
          <div class="card"><h3>실장비 진단 (Service 3)</h3><div id="auto-diagnoses" class="meta">로딩…</div></div>
          <div class="card"><h3>Spec 커버리지 · 안전등급</h3><div id="auto-specs" class="meta">로딩…</div></div>
        </div>
        <div class="card" style="margin-top:14px"><h3>WorkAtom (제품×라이프사이클)</h3><pre class="result" id="auto-atoms">로딩…</pre></div>
      </div>

      <div id="analyze" class="panel">
        <h2>프로젝트 분석</h2>
        <p class="meta">고객명·제품·요구사항을 입력하면 리스크·누락 입력·지식 쿼리를 반환합니다.</p>
        <label>고객명 *</label><input id="an-customer" placeholder="예: ACME Corp" />
        <div class="row2">
          <div><label>제품</label><select id="an-product">${productOptions}</select></div>
          <div><label>버전</label><input id="an-version" placeholder="6.11" /></div>
        </div>
        <label>프로젝트 유형</label><input id="an-type" placeholder="deployment, poc, migration…" />
        <label>요구사항 (한 줄에 하나)</label><textarea id="an-reqs" placeholder="HA 구성\\n스토리지 네트워크 MTU 9000"></textarea>
        <button class="primary" id="btn-analyze">분석 실행</button>
        <pre class="result" id="an-result"></pre>
      </div>

      <div id="plan" class="panel">
        <h2>설정 플랜 생성 (RAG)</h2>
        <p class="meta">RAG 인덱스를 참조해 precheck·단계·롤백·검증이 포함된 플랜을 생성합니다.</p>
        <label>고객명 *</label><input id="pl-customer" placeholder="예: ACME Corp" />
        <div class="row2">
          <div><label>제품 *</label><select id="pl-product">${productOptions}</select></div>
          <div><label>버전</label><input id="pl-version" placeholder="6.11" /></div>
        </div>
        <label>요구사항 (한 줄에 하나)</label><textarea id="pl-reqs" placeholder="VM 마이그레이션 계획"></textarea>
        <button class="primary" id="btn-plan">플랜 생성</button>
        <pre class="result" id="pl-result"></pre>
      </div>

      <div id="rag" class="panel">
        <h2>RAG 검색</h2>
        <label>검색어 *</label><input id="rag-query" placeholder="HCI HA 설정" />
        <div class="row2">
          <div><label>제품</label><select id="rag-product"><option value="">(전체)</option>${productOptions}</select></div>
          <div><label>결과 수</label><input id="rag-limit" type="number" value="10" min="1" max="50" /></div>
        </div>
        <button class="primary" id="btn-rag">검색</button>
        <div class="grid" id="rag-hits" style="margin-top:14px"></div>
      </div>

      <div id="products" class="panel">
        <h2>제품 어댑터</h2>
        <div class="card" style="margin-bottom:14px">
          <h3>콘솔 탐색 (discover)</h3>
          <div class="row2">
            <div><label>제품</label><select id="pd-product">${productOptions}</select></div>
            <div><label>대상 URL</label><input id="pd-url" placeholder="https://..." /></div>
          </div>
          <button class="primary" id="btn-discover">탐색</button>
        </div>
        <div class="card" style="margin-bottom:14px">
          <h3>요구사항 분석</h3>
          <label>요구사항 (한 줄에 하나)</label><textarea id="pd-reqs"></textarea>
          <button class="primary" id="btn-pd-analyze">분석</button>
        </div>
        <div class="card">
          <h3>Excel ITAC 체크리스트</h3>
          <label>파일 경로 (로컬)</label><input id="xl-path" placeholder="/path/to/checklist.xlsx" />
          <label>또는 파일 업로드</label><input id="xl-file" type="file" accept=".xlsx,.xls" />
          <label><input type="checkbox" id="xl-plan" /> 변경 플랜까지 생성</label>
          <button class="primary" id="btn-excel">가져오기</button>
        </div>
        <pre class="result" id="pd-result"></pre>
      </div>

      <div id="feedback" class="panel">
        <h2>피드백 제출</h2>
        <div class="row2">
          <div><label>제품</label><select id="fb-product">${productOptions}</select></div>
          <div><label>유형</label><input id="fb-type" placeholder="planner_miss, operator_bug…" /></div>
        </div>
        <div class="row2">
          <div><label>심각도</label><select id="fb-severity"><option>low</option><option>medium</option><option selected>high</option><option>critical</option></select></div>
          <div><label>역할</label><select id="fb-role"><option>engineer</option><option>user</option><option>customer</option><option>verifier</option></select></div>
        </div>
        <label>내용 *</label><textarea id="fb-text" placeholder="플랜에서 롤백 단계가 누락됨"></textarea>
        <button class="primary" id="btn-feedback">제출</button>
        <pre class="result" id="fb-result"></pre>
      </div>

      <div id="knowledge" class="panel">
        <h2>지식 브라우저</h2>
        <div class="row2" style="margin-bottom:12px">
          <div><label>제품</label><select id="kn-product">${productOptions}</select></div>
          <div><label>유형</label><select id="kn-type"><option value="manual">Manual</option><option value="wiki">Wiki</option></select></div>
        </div>
        <button class="primary" id="btn-knowledge">불러오기</button>
        <div class="grid" id="kn-content" style="margin-top:14px"></div>
      </div>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const panels = document.querySelectorAll('.panel');
    document.querySelectorAll('#nav button').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('#nav button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        panels.forEach(p => p.classList.toggle('active', p.id === btn.dataset.panel));
        if (btn.dataset.panel === 'dashboard') loadDashboard();
        if (btn.dataset.panel === 'automation') loadAutomation();
      };
    });

    async function loadAutomation() {
      try {
        const [cov, diag, spec] = await Promise.all([api('/api/coverage'), api('/api/diagnoses'), api('/api/spec-coverage')]);
        const c = cov.coverage;
        $('auto-stats').innerHTML =
          '<div class="stat"><strong>' + (c.replacementRate * 100).toFixed(1) + '%</strong>1인 대체율(정직)</div>' +
          '<div class="stat"><strong>' + c.replacedAtoms + '/' + c.automatableAtoms + '</strong>field_verified 대체</div>' +
          '<div class="stat"><strong>' + c.humanOnlyAtoms + '</strong>사람 전용</div>' +
          '<div class="stat"><strong>' + c.totalAtoms + '</strong>총 WorkAtom</div>';
        $('auto-diagnoses').innerHTML = (diag.diagnoses || []).length
          ? diag.diagnoses.map(d => '<div><b>' + d.file + '</b><br>' + (d.summary || '') + '<br>' + (d.verdict || '') + '</div>').join('<hr style="border-color:#334155">')
          : '진단 산출물 없음';
        $('auto-specs').innerHTML =
          '<b>Spec:</b> ' + (spec.specs || []).map(s => s.product + ' ' + s.version + '(' + s.items + ')').join(', ') +
          '<br><b>안전등급:</b> ' + (spec.safety || []).map(s => s.capabilityId + '=' + s.safetyClass).slice(0, 8).join(', ');
        $('auto-atoms').textContent = JSON.stringify(c.byPhase, null, 2);
      } catch (e) { $('auto-stats').innerHTML = '오류: ' + e.message; }
    }

    async function api(path, opts) {
      const r = await fetch(path, opts);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || r.statusText);
      return data;
    }

    function lines(id) {
      return $(id).value.split('\\n').map(s => s.trim()).filter(Boolean);
    }

    function healthLine(ok, label, detail) {
      const status = ok === null ? '● OFF' : (ok ? '● OK' : '● FAIL');
      const cls = ok === null ? 'health-off' : (ok ? 'health-ok' : 'health-bad');
      return '<span class="' + cls + '">' + status + '</span> ' + label + (detail ? ' — ' + detail : '');
    }

    async function loadDashboard() {
      const [summary, store, embed] = await Promise.all([
        api('/api/summary'),
        api('/api/health/store'),
        api('/api/health/embeddings')
      ]);
      $('stats').innerHTML = [
        ['매뉴얼', summary.manualCount],
        ['Wiki', summary.wikiCount],
        ['RAG 청크', summary.rag?.chunkCount || 0],
        ['Store', summary.storeEnabled ? 'ON' : 'OFF']
      ].map(([l,v]) => '<div class="stat"><span>'+l+'</span><strong>'+v+'</strong></div>').join('');
      $('store-health').innerHTML = healthLine(store.enabled ? store.ok : null, store.enabled ? 'DATABASE_URL 설정됨' : '비활성', store.detail);
      $('embed-health').innerHTML = [
        healthLine(embed.embeddingHealth?.ok, '임베딩: ' + embed.embeddingProvider, embed.embeddingHealth?.detail),
        healthLine(embed.mimoRerankHealth?.ok, 'MiMo rerank' + (embed.mimoRerankEnabled ? '' : ' (off)'), embed.mimoRerankHealth?.detail),
        '<div class="meta">dims=' + embed.dimensions + ' · cloud RAG=' + embed.allowCloudRag + '</div>'
      ].join('<br>');
    }

    $('btn-analyze').onclick = async () => {
      $('btn-analyze').disabled = true;
      try {
        const body = {
          customerName: $('an-customer').value.trim(),
          product: $('an-product').value,
          version: $('an-version').value.trim() || undefined,
          projectType: $('an-type').value.trim() || undefined,
          requirements: lines('an-reqs')
        };
        $('an-result').textContent = JSON.stringify(await api('/api/analyze-project', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) }), null, 2);
      } catch (e) { $('an-result').textContent = String(e.message || e); }
      $('btn-analyze').disabled = false;
    };

    $('btn-plan').onclick = async () => {
      $('btn-plan').disabled = true;
      $('pl-result').textContent = '생성 중… (RAG 검색 포함)';
      try {
        const body = {
          customerName: $('pl-customer').value.trim(),
          product: $('pl-product').value,
          version: $('pl-version').value.trim() || undefined,
          requirements: lines('pl-reqs')
        };
        $('pl-result').textContent = JSON.stringify(await api('/api/generate-config-plan', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) }), null, 2);
      } catch (e) { $('pl-result').textContent = String(e.message || e); }
      $('btn-plan').disabled = false;
    };

    $('btn-rag').onclick = async () => {
      try {
        const hits = await api('/api/rag-search', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({
          query: $('rag-query').value.trim(),
          product: $('rag-product').value || undefined,
          limit: Number($('rag-limit').value) || 10
        })});
        const items = hits.items || hits.hits || hits.results || (Array.isArray(hits) ? hits : []);
        $('rag-hits').innerHTML = (items.length ? items : []).map(c => (
          '<article class="card"><h3>'+(c.title||c.id||'chunk')+'</h3>'+
          '<div class="meta">'+(c.product||'')+(c.score != null ? ' · score '+c.score.toFixed(3) : '')+'</div>'+
          '<p class="snippet">'+(c.text||c.snippet||'')+'</p></article>'
        )).join('') || '<p class="meta">결과 없음</p>';
      } catch (e) { $('rag-hits').innerHTML = '<p class="meta">'+e.message+'</p>'; }
    };

    $('btn-discover').onclick = async () => {
      try {
        $('pd-result').textContent = JSON.stringify(await api('/api/discover-console', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({
          product: $('pd-product').value,
          targetUrl: $('pd-url').value.trim() || undefined
        })}), null, 2);
      } catch (e) { $('pd-result').textContent = String(e.message || e); }
    };

    $('btn-pd-analyze').onclick = async () => {
      try {
        $('pd-result').textContent = JSON.stringify(await api('/api/analyze-requirements', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({
          product: $('pd-product').value,
          requirements: lines('pd-reqs')
        })}), null, 2);
      } catch (e) { $('pd-result').textContent = String(e.message || e); }
    };

    $('btn-excel').onclick = async () => {
      $('btn-excel').disabled = true;
      try {
        const body = { generatePlan: $('xl-plan').checked, prioritizeOnly: true };
        const path = $('xl-path').value.trim();
        const file = $('xl-file').files[0];
        if (file) {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          body.contentBase64 = btoa(bin);
          body.fileName = file.name;
        } else if (path) {
          body.filePath = path;
        } else throw new Error('파일 경로 또는 업로드 필요');
        $('pd-result').textContent = JSON.stringify(await api('/api/import-excel', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) }), null, 2);
      } catch (e) { $('pd-result').textContent = String(e.message || e); }
      $('btn-excel').disabled = false;
    };

    $('btn-feedback').onclick = async () => {
      try {
        $('fb-result').textContent = JSON.stringify(await api('/api/feedback', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({
          product: $('fb-product').value,
          feedbackType: $('fb-type').value.trim() || 'general',
          severity: $('fb-severity').value,
          feedbackText: $('fb-text').value.trim(),
          sourceRole: $('fb-role').value
        })}), null, 2);
      } catch (e) { $('fb-result').textContent = String(e.message || e); }
    };

    $('btn-knowledge').onclick = async () => {
      const data = await api('/api/knowledge?product=' + $('kn-product').value + '&type=' + $('kn-type').value);
      $('kn-content').innerHTML = data.items.map(c => (
        '<article class="card"><h3>'+c.title+'</h3>'+
        '<div class="meta">'+c.sourceType+' · '+c.product+(c.section?' · '+c.section:'')+'</div>'+
        '<p class="snippet">'+c.text+'</p></article>'
      )).join('') || '<p class="meta">청크 없음</p>';
    };

    loadDashboard();
  </script>
</body>
</html>`;
}
