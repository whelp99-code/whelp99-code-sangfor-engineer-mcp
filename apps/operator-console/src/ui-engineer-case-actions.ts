export const ENGINEER_CASE_ACTION_SCRIPT = `
    var ecAssembled = null;
    var ecExpectedRevision = '';

    function ecText(value, fallback) {
      var text = typeof value === 'string' ? value.trim() : '';
      return text || fallback;
    }

    function ecClear(target) {
      while (target.firstChild) target.removeChild(target.firstChild);
    }

    function ecAppend(parent, tag, value, className) {
      var el = document.createElement(tag);
      if (className) el.className = className;
      el.textContent = value;
      parent.appendChild(el);
      return el;
    }

    function ecStatus(kind, message) {
      var box = $('ec-status');
      box.className = 'ec-status ' + kind;
      box.textContent = message;
    }

    function ecGrantLine(data) {
      return '승인=' + String(!!data.approved) +
        ' · 가이드준비부여=' + String(!!data.guideReadyGranted) +
        ' · 실행통과부여=' + String(!!data.executionPassGranted) +
        ' · 저장완료표시=' + String(!!data.saveComplete);
    }

    function ecIsSaveSuccess(data) {
      return !!(data && data.ok === true && data.status === 'saved');
    }

    function ecIsComplete(data) {
      return false;
    }

    function ecParseCollections(text) {
      return String(text || '').split('\\n').map(function (line) { return line.trim(); }).filter(Boolean).map(function (line, index) {
        var parts = line.split('|').map(function (part) { return part.trim(); });
        return { id: undefined, label: parts[0] || ('field-' + (index + 1)), valueText: parts[1] || '', unit: parts[2] || '' };
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
        collections: ecParseCollections($('ec-collections').value)
      };
    }

    function ecRenderRows(target, rows, emptyMessage) {
      ecClear(target);
      if (!rows || !rows.length) {
        ecAppend(target, 'p', emptyMessage, 'meta');
        return;
      }
      rows.forEach(function (row) {
        var card = document.createElement('article');
        card.className = 'card';
        ecAppend(card, 'h3', ecText(row.title || row.id, '항목'));
        ecAppend(card, 'div', '출처: ' + ecText(row.sourceKindLabel, '미확인'), 'meta');
        ecAppend(card, 'p', ecText(row.detail, ''), 'snippet');
        if (row.nextAction) ecAppend(card, 'div', '다음: ' + row.nextAction, 'meta');
        target.appendChild(card);
      });
    }

    function ecShowReview(data) {
      var review = data.review || {};
      var failures = review.failures || [];
      var kind = data.ok ? 'warn' : 'fail';
      var headline = data.ok
        ? (data.status === 'reviewed' ? '검토됨. 완료가 아닙니다.' : '응답을 완료로 보지 않습니다.')
        : ('실패: ' + ecText(data.code || data.error, '요청 실패'));
      if (review.collectionConnected) failures = failures.concat(['수집 연결 주장은 이 화면에서 인정하지 않습니다']);
      ecStatus(kind, headline + ' ' + ecText(review.collectionSummary, '') + ' ' + failures.join(' / ') + ' · ' + ecGrantLine(data));
      ecRenderRows($('ec-requirements'), review.requirements, '요구사항 없음');
      ecRenderRows($('ec-observations'), review.observations, '수집 결과 없음');
      ecRenderRows($('ec-calculations'), review.calculations, '계산 불가');
      ecRenderRows($('ec-unresolved'), review.unresolved, '미확인 항목 표시 없음');
      if (review.caseId) $('ec-case-id').value = review.caseId;
      if (review.revision) $('ec-revision').value = review.revision;
      $('ec-json').textContent = JSON.stringify(data.document || data, null, 2);
      ecAssembled = data.document || null;
      if (data.durable === 'saved' && review.revision) ecExpectedRevision = review.revision;
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
      data.guideReadyGranted = !!data.guideReadyGranted;
      data.executionPassGranted = !!data.executionPassGranted;
      data.approved = !!data.approved;
      return { httpStatus: response.status, data: data };
    }

    $('ec-btn-review').onclick = async function () {
      var result = await ecCall('/api/engineer-cases/review', { draft: ecReadDraft() });
      ecShowReview(result.data);
      if (ecIsComplete(result.data) || result.data.status === 'saved') ecStatus('fail', '검토 응답을 저장 완료로 표시하지 않습니다.');
    };

    $('ec-btn-save').onclick = async function () {
      if (!ecAssembled) {
        var reviewed = await ecCall('/api/engineer-cases/review', { draft: ecReadDraft() });
        ecShowReview(reviewed.data);
        if (!reviewed.data.document) {
          ecStatus('fail', '저장되지 않음: 검토에 실패했습니다. 완료가 아닙니다.');
          return;
        }
      }
      var payload = { requestId: 'req-' + Date.now(), document: ecAssembled };
      if (ecExpectedRevision) payload.expectedRevision = ecExpectedRevision;
      var result = await ecCall('/api/engineer-cases', payload);
      if (!ecIsSaveSuccess(result.data)) {
        var code = result.data.code || result.data.error || String(result.httpStatus);
        ecStatus('fail', '저장되지 않음: ' + code + '. 완료가 아닙니다. · ' + ecGrantLine(result.data));
        $('ec-json').textContent = JSON.stringify(result.data, null, 2);
        return;
      }
      ecExpectedRevision = result.data.revision || '';
      if (result.data.caseId) $('ec-case-id').value = result.data.caseId;
      if (result.data.revision) $('ec-revision').value = result.data.revision;
      ecStatus('ok', '저장됨. 승인·가이드 준비·실행 통과가 아닙니다. · ' + ecGrantLine(result.data));
      $('ec-json').textContent = JSON.stringify(result.data, null, 2);
    };

    $('ec-btn-resume').onclick = async function () {
      var caseId = $('ec-resume-id').value.trim() || $('ec-case-id').value.trim();
      var result = await ecCall('/api/engineer-cases/review', { caseId: caseId });
      ecShowReview(result.data);
    };

    $('ec-btn-artifact').onclick = async function () {
      var result = await ecCall('/api/engineer-cases/artifact', {
        caseId: $('ec-case-id').value.trim() || $('ec-resume-id').value.trim(),
        artifactId: $('ec-artifact-id').value.trim()
      });
      if (result.data.ok && result.data.payload) {
        $('ec-json').textContent = String(result.data.payload);
        ecStatus('warn', '증거를 표시합니다. 다운로드·완료가 아닙니다. · ' + ecGrantLine(result.data));
        return;
      }
      ecStatus('fail', '타 사례이거나 증거 접근이 거절되었습니다: ' + ecText(result.data.code || result.data.error, 'ARTIFACT_NOT_FOUND') + '. 완료가 아닙니다.');
    };

    $('ec-btn-export').onclick = async function () {
      ecAssembled = null;
      ecStatus('fail', '내보내기 오류: 이 화면에서는 가이드를 내보내지 않습니다. 완료가 아닙니다.');
    };
`;
