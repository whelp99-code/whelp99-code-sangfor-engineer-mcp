import { API_TOKEN_STORAGE_KEY } from './ui-auth.js';

export const CLIENT_CORE_SCRIPT = `    const API_TOKEN_STORAGE_KEY = '${API_TOKEN_STORAGE_KEY}';
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

    function readApiToken() {
      try { return localStorage.getItem(API_TOKEN_STORAGE_KEY) || ''; }
      catch { return ''; }
    }

    function buildApiHeaders(token, headers) {
      const out = Object.assign({}, headers || {});
      const trimmed = String(token || '').trim();
      if (trimmed) out.authorization = 'Bearer ' + trimmed;
      return out;
    }

    function initTokenInput() {
      const tokenInput = $('api-token');
      tokenInput.value = readApiToken();
      $('save-token').onclick = () => {
        try {
          localStorage.setItem(API_TOKEN_STORAGE_KEY, tokenInput.value.trim());
          $('auth-hint').textContent = '토큰 저장됨';
        } catch (e) {
          $('auth-hint').textContent = '토큰 저장 실패';
        }
      };
    }

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
      const request = Object.assign({}, opts || {});
      request.headers = buildApiHeaders(readApiToken(), request.headers);
      const r = await fetch(path, request);
      const data = await r.json().catch(() => ({}));
      if (r.status === 401) {
        $('auth-hint').textContent = '401 인증 필요: API bearer token을 저장하세요';
      }
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
    }`;
