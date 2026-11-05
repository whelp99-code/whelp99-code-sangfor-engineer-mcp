import { ENGINEER_CASE_RENDER_SCRIPT } from './ui-engineer-case-render.js';
import { ENGINEER_CASE_STATE_SCRIPT } from './ui-engineer-case-state.js';

export const ENGINEER_CASE_ACTION_SCRIPT = ENGINEER_CASE_RENDER_SCRIPT + ENGINEER_CASE_STATE_SCRIPT + `
    function ecText(value, fallback) { return ((typeof value === 'string' ? value.trim() : '') || fallback); }
    function ecClear(target) { while (target.firstChild) target.removeChild(target.firstChild); }
    function ecAppend(parent, tag, value, className) {
      var el = document.createElement(tag);
      if (className) el.className = className;
      el.textContent = value;
      parent.appendChild(el);
      return el;
    }
    function ecStatus(kind, message) { var box = $('ec-status'); box.className = 'ec-status ' + kind; box.textContent = message; }
    function ecGrantLine(data) {
      return '승인=' + String(!!data.approved) + ' · 가이드준비부여=' + String(!!data.guideReadyGranted) + ' · 실행통과부여=' + String(!!data.executionPassGranted) + ' · 저장완료표시=' + String(!!data.saveComplete);
    }

    function ecIsSaveSuccess(data) { return !!(data && data.ok === true && data.status === 'saved'); }
    function ecIsComplete(data) { return false; }

    function ecParseCollections(text) {
      return String(text || '').split('\\n').map(function (line) { return line.trim(); }).filter(Boolean).map(function (line, index) {
        var parts = line.split('|').map(function (part) { return part.trim(); });
        return { id: parts[3] || undefined, label: parts[0] || ('field-' + (index + 1)), valueText: parts[1] || '', unit: parts[2] || '' };
      });
    }

    function ecReadDraft() {
      return {
        caseId: $('ec-case-id').value.trim() || undefined,
        mode: $('ec-mode').value,
        product: $('ec-product').value,
        firmware: $('ec-firmware').value.trim() || undefined,
        revision: $('ec-revision').value.trim() || undefined,
        requirementLines: lines('ec-reqs'),
        collections: ecParseCollections($('ec-collections').value),
        analysis: $('ec-analysis').value.trim() ? JSON.parse($('ec-analysis').value) : undefined
      };
    }

    async function ecCall(path, body) {
      var request = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      request.headers = buildApiHeaders(readApiToken(), request.headers);
      var response = await fetch(path, request);
      var data = await response.json().catch(function () { return {}; });
      if (response.status === 401) {
        $('auth-hint').textContent = '401 인증 필요: API bearer token을 저장하세요';
        data = Object.assign({ ok: false, status: 'unsaved', code: data.code || 'unauthorized', error: data.error || 'unauthorized' }, data);
      }
      data.saveComplete = false;
      data.downloadComplete = !!data.downloadComplete;
      data.guideReadyGranted = !!data.guideReadyGranted;
      data.executionPassGranted = !!data.executionPassGranted;
      data.approved = !!data.approved;
      return { httpStatus: response.status, data: data };
    }

    async function ecDownloadDocx(caseId, artifactId, token) {
      var path = '/api/engineer-cases/guide-download?caseId=' + encodeURIComponent(caseId) + '&artifactId=' + encodeURIComponent(artifactId);
      var response = await fetch(path, { method: 'GET', headers: buildApiHeaders(readApiToken(), {}) });
      if (response.status === 401 || !response.ok) return false;
      var blob = await response.blob();
      if (!ecCurrent(token)) return false;
      var name = 'engineer-guide.docx';
      var disposition = response.headers.get('content-disposition') || '';
      var match = disposition.match(/filename="([A-Za-z0-9._-]+\\.docx)"/);
      if (match) name = match[1];
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = name;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      return true;
    }

    async function ecReview(token) {
      if (!ecGuardEdit()) return false;
      var draft;
      try { draft = ecReadDraft(); } catch (error) { ecStatus('fail', '계산·요구사항 연결 JSON 구문 오류를 수정하세요.'); return false; }
      var result = await ecCall('/api/engineer-cases/review', { draft: draft });
      if (!ecCurrent(token)) return false;
      ecTransition('review', result.data); token.fingerprint = ecFingerprint();
      ecShowReview(result.data);
      return !!ecState.document;
    }
    function ecRun(action) {
      return async function () {
        var token = ecTransition('start');
        try { await action(token); } catch (error) {
          if (ecCurrent(token)) ecStatus('fail', '요청 실패. 저장·내려받기 완료가 아닙니다.');
        }
      };
    }
    $('ec-btn-sample').onclick = function () {
      $('ec-reqs').value = '가용 용량 여유 20% 이상 유지';
      $('ec-collections').value = 'usable-capacity | 40 | TiB\\nhost-cpu | | cores';
      $('ec-case-id').value = $('ec-case-id').value.trim() || 'case-sample-1';
      $('ec-analysis').value = ''; ecTransition('invalidate');
      ecStatus('warn', '샘플을 채웠습니다. 아직 저장·내려받기가 아닙니다. 완료가 아닙니다.');
    };
    $('ec-btn-review').onclick = ecRun(async function (token) {
      if (!ecGuardEdit()) return;
      if (ecState.resumedCaseId === $('ec-case-id').value.trim()) {
        ecStatus('warn', '불러온 문서 원본을 검토합니다. 편집은 새 사례 ID로 시작하세요.'); return;
      }
      await ecReview(token);
    });
    $('ec-btn-save').onclick = ecRun(async function (token) {
      if (!ecGuardEdit()) return;
      if (ecState.persisted && ecState.persisted.caseId === $('ec-case-id').value.trim() && ecState.persisted.fingerprint === ecFingerprint()) {
        ecStatus('warn', '현재 입력은 저장된 revision입니다. 중복 저장하지 않습니다. 승인·현장 인수가 아닙니다.'); return;
      }
      if (!ecState.document || ecState.fingerprint !== ecFingerprint()) {
        if (!await ecReview(token)) return;
      }
      var doc = ecState.document, persisted = ecState.persisted;
      var payload = { requestId: 'req-' + Date.now(), document: doc };
      if (persisted && persisted.caseId === doc.caseId) payload.expectedRevision = persisted.revision;
      var result = await ecCall('/api/engineer-cases', payload);
      if (!ecCurrent(token)) return;
      if (!ecIsSaveSuccess(result.data) || result.data.caseId !== doc.caseId) {
        var code = result.data.code || result.data.error || String(result.httpStatus);
        if (code === 'REVISION_CONFLICT') ecTransition('export');
        var omitFail = result.data.applyFileOmitted ? ' 가이드 적용 파일 생략: ' + result.data.applyFileOmitted + '.' : '';
        ecStatus('fail', '저장되지 않음: ' + code + '.' + omitFail + ' 완료가 아닙니다. · ' + ecGrantLine(result.data));
        $('ec-json').textContent = JSON.stringify(result.data, null, 2); return;
      }
      // Persisted revisions may differ from the submitted revision. Resume, do not re-stamp an old guide.
      ecTransition('save', Object.assign({}, result.data, { document: result.data.revision === doc.revision ? doc : null }));
      if (result.data.revision !== doc.revision) ecTransition('export');
      var omit = result.data.applyFileOmitted;
      var omitLine = omit ? '사례 문서는 유지됨. 가이드 적용 파일 생략: ' + omit + (result.data.unresolved ? ' · ' + result.data.unresolved : '') + '. dry-run 봉투는 준비되지 않았습니다. ' : '저장됨. ';
      ecStatus(omit ? 'warn' : 'ok', omitLine + '승인·가이드 준비·실행 통과가 아닙니다. · ' + ecGrantLine(result.data));
      $('ec-json').textContent = JSON.stringify(result.data, null, 2);
    });
    $('ec-btn-resume').onclick = ecRun(async function (token) {
      var caseId = $('ec-resume-id').value.trim() || $('ec-case-id').value.trim();
      var result = await ecCall('/api/engineer-cases/review', { caseId: caseId });
      if (!ecCurrent(token) || caseId !== ($('ec-resume-id').value.trim() || $('ec-case-id').value.trim())) return;
      if (result.data.ok && result.data.document && result.data.document.caseId === caseId) ecTransition('resume', result.data);
      else ecTransition('invalidate');
      ecShowReview(result.data);
    });
    $('ec-btn-artifact').onclick = ecRun(async function (token) {
      var result = await ecCall('/api/engineer-cases/artifact', {
        caseId: $('ec-case-id').value.trim() || $('ec-resume-id').value.trim(), artifactId: $('ec-artifact-id').value.trim()
      });
      if (!ecCurrent(token)) return;
      if (result.data.ok && result.data.payload) {
        $('ec-json').textContent = String(result.data.payload);
        ecStatus('warn', '증거를 표시합니다. 다운로드·완료가 아닙니다. · ' + ecGrantLine(result.data)); return;
      }
      ecStatus('fail', '타 사례이거나 증거 접근이 거절되었습니다: ' + ecText(result.data.code || result.data.error, 'ARTIFACT_NOT_FOUND') + '. 완료가 아닙니다.');
    });
    $('ec-btn-export').onclick = ecRun(async function (token) {
      var persisted = ecState.persisted;
      if (!persisted || ecState.mustResume || persisted.caseId !== $('ec-case-id').value.trim() || persisted.fingerprint !== ecFingerprint()) {
        ecStatus('fail', '내보내기 오류: 현재 입력을 저장하거나 불러오기 하세요. 완료가 아닙니다.'); return;
      }
      // Dispatch may persist a new revision even if its acknowledgement/download fails.
      ecTransition('export');
      var result = await ecCall('/api/engineer-cases/guide-export', { caseId: persisted.caseId, expectedRevision: persisted.revision });
      if (!ecCurrent(token)) return;
      $('ec-json').textContent = JSON.stringify(result.data, null, 2);
      if (!result.data.ok || result.data.caseId !== persisted.caseId || result.data.downloadComplete !== true || !result.data.artifactId) {
        ecStatus('fail', '내보내기 오류: ' + ecText(result.data.code || result.data.error, 'EXPORT_FAILED') + '. 불러오기 하세요. 완료가 아닙니다.'); return;
      }
      var downloaded = await ecDownloadDocx(result.data.caseId, result.data.artifactId, token);
      if (!ecCurrent(token)) return;
      if (!downloaded) { ecStatus('fail', '내보내기는 되었으나 내려받기에 실패했습니다. 불러오기 하세요. 완료가 아닙니다.'); return; }
      var changed = ' 생성 문서 사례 revision=' + result.data.exportedCaseRevision + ' · 가이드 revision=' + result.data.exportedGuideRevision +
        ' · 현재 저장 revision=' + result.data.currentCaseRevision + '. 불러오기 후 다시 검토하세요.';
      ecStatus('warn', 'Word를 받았습니다. 승인·가이드 준비·실행 통과가 아닙니다.' + changed + ' · ' + ecGrantLine(result.data));
      $('ec-artifact-id').value = result.data.artifactId;
    });
`;
