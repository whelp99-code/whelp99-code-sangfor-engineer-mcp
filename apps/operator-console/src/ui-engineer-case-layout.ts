import { PRODUCTS } from '../../../packages/shared/src/index.js';

const productOptions = PRODUCTS.map((p) => `<option value="${p.code}">${p.name} (${p.code})</option>`).join('');

export const ENGINEER_CASE_PANEL = `      <div id="engineer-case" class="panel">
        <h2>사례 입력·가이드 검토</h2>
        <div class="card" id="ec-first-use">
          <h3>처음 쓰는 경우</h3>
          <p class="meta">목적: 한 사례의 요구사항과 제공값을 검토하고, 저장된 가이드를 Word로 받습니다. 이 화면은 장비를 바꾸거나 승인·현장 인수를 하지 않습니다.</p>
          <p class="meta">단계: 1) 사례 만들기 2) 검토 3) 저장 4) 가이드 확인 5) Word 내려받기. 저장에 실패하면 내려받을 수 없습니다.</p>
          <p class="meta">예시: 가용 용량 여유 20% · 제공값 <code>usable-capacity | 40 | TiB</code>. 값을 비우면 미확인입니다. 없는 값을 0이나 PASS로 채우지 않습니다.</p>
          <p class="meta">다음 행동: 미확인이 있으면 정보를 더 받습니다. 문서의 review_ready는 검토 준비 주장일 뿐이며 승인=false, 가이드준비부여=false, 실행통과부여=false와 별개입니다.</p>
          <button class="primary" id="ec-btn-sample" type="button">대표 샘플 채우기</button>
        </div>
        <p class="meta">저장 성공은 승인·가이드 준비·실행 통과가 아닙니다. Word는 저장된 사례를 복사해 만들며 판정을 다시 계산하지 않습니다.</p>
        <div class="row2">
          <div><label>사례 ID</label><input id="ec-case-id" placeholder="비우면 자동 부여. 예: case-acme-1" /></div>
          <div><label>저장된 사례 불러오기</label><input id="ec-resume-id" placeholder="예: case-acme-1" /></div>
        </div>
        <div class="row2">
          <div>
            <label>모드</label>
            <select id="ec-mode">
              <option value="existing">기존 환경</option>
              <option value="new">신규 구축</option>
            </select>
          </div>
          <div><label>제품</label><select id="ec-product">${productOptions}</select></div>
        </div>
        <div class="row2">
          <div><label>펌웨어</label><input id="ec-firmware" placeholder="모르면 비움" /></div>
          <div><label>revision</label><input id="ec-revision" placeholder="저장 후 자동. 예: rev-1" /></div>
        </div>
        <label>요구사항 (한 줄에 하나)</label>
        <textarea id="ec-reqs" placeholder="가용 용량 여유 20% 이상 유지\\n관리 네트워크와 스토리지 네트워크 분리"></textarea>
        <label>수집/입력 (한 줄: 이름 | 값 | 단위). 값을 비우면 미확인입니다. 장비 관측값으로 승격하지 않습니다.</label>
        <textarea id="ec-collections" placeholder="usable-capacity | 40 | TiB\\nhost-cpu | | cores"></textarea>
        <div class="row2">
          <div><label>증거 artifact ID</label><input id="ec-artifact-id" placeholder="다른 사례 값은 거절됩니다" /></div>
          <div class="meta" style="align-self:end">범위는 서버 인증 문맥입니다. tenant/project를 입력해 권한으로 쓰지 않습니다.</div>
        </div>
        <button class="primary" id="ec-btn-review" type="button">검토</button>
        <button class="primary" id="ec-btn-save" type="button">저장</button>
        <button class="primary" id="ec-btn-resume" type="button">불러오기</button>
        <button class="primary" id="ec-btn-artifact" type="button">증거 확인</button>
        <button class="primary" id="ec-btn-export" type="button">Word 내려받기</button>
        <div id="ec-status" class="ec-status warn">아직 검토하지 않았습니다. 완료가 아닙니다.</div>
        <div class="card" style="margin-top:14px"><h3>요구사항</h3><div id="ec-requirements" class="meta">검토 전</div></div>
        <div class="card" style="margin-top:14px"><h3>수집 결과</h3><div id="ec-observations" class="meta">검토 전</div></div>
        <div class="card" style="margin-top:14px"><h3>계산</h3><div id="ec-calculations" class="meta">검토 전</div></div>
        <div class="card" style="margin-top:14px"><h3>미확인·다음 행동</h3><div id="ec-unresolved" class="meta">검토 전</div></div>
        <div class="card" style="margin-top:14px">
          <h3>가이드 미리보기</h3>
          <div id="ec-guide-meta" class="meta">저장 전에 초안을 볼 수 있습니다. Word는 저장된 사례만 받습니다.</div>
          <div id="ec-guide-steps" class="meta">단계 없음</div>
        </div>
        <details id="ec-diagnostic"><summary>보조 진단 JSON</summary><pre class="result" id="ec-json"></pre></details>
      </div>`;
