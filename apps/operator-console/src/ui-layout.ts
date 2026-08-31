import { PRODUCTS } from '../../../packages/shared/src/index.js';

const productOptions = PRODUCTS.map(p => `<option value="${p.code}">${p.name} (${p.code})</option>`).join('');

export const DASHBOARD_BODY = `  <header>
    <h1>Sangfor Engineer Web</h1>
    <div class="auth-box">
      <input id="api-token" type="password" autocomplete="off" placeholder="API bearer token" />
      <button id="save-token" type="button">토큰 저장</button>
      <span id="auth-hint" class="auth-hint"></span>
      <span class="badge">MCP는 Cursor 등 stdio · 웹은 :3502</span>
    </div>
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
  </main>`;
