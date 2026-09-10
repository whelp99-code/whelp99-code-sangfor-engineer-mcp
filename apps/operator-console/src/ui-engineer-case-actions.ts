export const ENGINEER_CASE_ACTION_SCRIPT = `
    var ecAssembled = null, ecExpectedRevision = '', ecSavedCaseId = '', ecLastSave = null;
    try { ecLastSave = JSON.parse(sessionStorage.getItem('sangfor_ec_last_save') || 'null'); } catch (e) {}

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

    function ecRenderGuide(review) {
      var guide = review.guide || {};
      var meta = $('ec-guide-meta');
      ecClear(meta);
      ecAppend(meta, 'p', ecText(guide.durableLabel, '초안/저장 구분 없음') +
        ' · 사례 revision ' + ecText(guide.caseRevision, 'unknown') +
        ' · 가이드 revision ' + ecText(guide.guideRevision, 'unknown'), 'meta');
      ecAppend(meta, 'p', ecText(guide.readinessClaim, '문서 준비도 주장 없음'), 'meta');
      ecAppend(meta, 'p', 'field_accepted=' + String(!!guide.fieldAccepted) +
        ' · approved_for_window=' + String(!!guide.approvedForWindow), 'meta');
      if (review.progressClaim) ecAppend(meta, 'p', review.progressClaim, 'meta');
      if (review.nextActions && review.nextActions.length) {
        ecAppend(meta, 'p', '다음 행동: ' + review.nextActions.join(' / '), 'meta');
      }
      var steps = $('ec-guide-steps');
      ecClear(steps);
      if (!guide.steps || !guide.steps.length) {
        ecAppend(steps, 'p', '저장된 단계 없음. 없는 단계를 만들지 않습니다.', 'meta');
      } else {
        guide.steps.forEach(function (step) {
          ecAppend(steps, 'p', String(step.order) + '. ' + ecText(step.title, step.id) + ' — 검증: ' + ecText(step.verify, '미확인'), 'snippet');
        });
      }
      if (guide.unresolved && guide.unresolved.length) {
        guide.unresolved.forEach(function (item) {
          ecAppend(steps, 'p', '미확인: ' + item, 'meta');
        });
      }
    }

    function ecShowReview(data) {
      var review = data.review || {};
      var failures = review.failures || [];
      var caseId = review.caseId || $('ec-case-id').value.trim();
      var last = (ecLastSave && ecLastSave.caseId === caseId) ? ecLastSave : null;
      var omit = data.applyFileOmitted || (last && last.omit);
      var unresolved = data.unresolved || (last && last.unresolved);
      if (omit) {
        ecStatus('warn', '사례 문서는 유지됨. 가이드 적용 파일 생략: ' + omit + (unresolved ? ' · ' + unresolved : '') + '. dry-run 봉투는 준비되지 않았습니다. 승인·가이드 준비·실행 통과가 아닙니다. · ' + ecGrantLine(data));
      } else if (data.durable === 'saved' && last && !last.omit) {
        ecStatus('ok', '저장됨. 승인·가이드 준비·실행 통과가 아닙니다. · ' + ecGrantLine(data));
      } else if (data.durable === 'saved') {
        ecStatus('warn', '검토됨. dry-run 봉투는 준비되지 않았습니다. 생략 사유를 입증하지 못했습니다. 완료가 아닙니다. · ' + ecGrantLine(data));
      } else {
        var kind = data.ok ? 'warn' : 'fail';
        var headline = data.ok
          ? (data.status === 'reviewed' ? '검토됨. 완료가 아닙니다.' : '응답을 완료로 보지 않습니다.')
          : ('실패: ' + ecText(data.code || data.error, '요청 실패'));
        if (review.collectionConnected) failures = failures.concat(['수집 연결 주장은 이 화면에서 인정하지 않습니다']);
        ecStatus(kind, headline + ' ' + ecText(review.collectionSummary, '') + ' ' + failures.join(' / ') + ' · ' + ecGrantLine(data));
      }
      ecRenderRows($('ec-requirements'), review.requirements, '요구사항 없음');
      ecRenderRows($('ec-observations'), review.observations, '수집 결과 없음');
      ecRenderRows($('ec-calculations'), review.calculations, '계산 불가');
      ecRenderRows($('ec-unresolved'), review.unresolved, '미확인 항목 표시 없음');
      ecRenderGuide(review);
      if (review.caseId) $('ec-case-id').value = review.caseId;
      if (review.revision) $('ec-revision').value = review.revision;
      $('ec-json').textContent = JSON.stringify(data.document || data, null, 2);
      ecAssembled = data.document || null;
      if (data.durable === 'saved' && review.revision) {
        ecExpectedRevision = review.revision;
        ecSavedCaseId = review.caseId || $('ec-case-id').value.trim();
      }
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

    async function ecDownloadDocx(caseId, artifactId) {
      var path = '/api/engineer-cases/guide-download?caseId=' + encodeURIComponent(caseId) + '&artifactId=' + encodeURIComponent(artifactId);
      var response = await fetch(path, { method: 'GET', headers: buildApiHeaders(readApiToken(), {}) });
      if (response.status === 401 || !response.ok) return false;
      var blob = await response.blob();
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

    $('ec-btn-sample').onclick = function () {
      $('ec-reqs').value = '가용 용량 여유 20% 이상 유지';
      $('ec-collections').value = 'usable-capacity | 40 | TiB\\nhost-cpu | | cores';
      $('ec-case-id').value = $('ec-case-id').value.trim() || 'case-sample-1';
      ecStatus('warn', '샘플을 채웠습니다. 아직 저장·내려받기가 아닙니다. 완료가 아닙니다.');
    };

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
        var omitFail = result.data.applyFileOmitted ? ' 가이드 적용 파일 생략: ' + result.data.applyFileOmitted + '.' : '';
        ecStatus('fail', '저장되지 않음: ' + code + '.' + omitFail + ' 완료가 아닙니다. · ' + ecGrantLine(result.data));
        $('ec-json').textContent = JSON.stringify(result.data, null, 2);
        return;
      }
      ecExpectedRevision = result.data.revision || '';
      ecSavedCaseId = result.data.caseId || $('ec-case-id').value.trim();
      ecLastSave = { caseId: ecSavedCaseId, omit: result.data.applyFileOmitted, unresolved: result.data.unresolved };
      try { sessionStorage.setItem('sangfor_ec_last_save', JSON.stringify(ecLastSave)); } catch (e) {}
      if (result.data.caseId) $('ec-case-id').value = result.data.caseId;
      if (result.data.revision) $('ec-revision').value = result.data.revision;
      var omit = result.data.applyFileOmitted;
      var omitLine = omit ? '사례 문서는 유지됨. 가이드 적용 파일 생략: ' + omit + (result.data.unresolved ? ' · ' + result.data.unresolved : '') + '. dry-run 봉투는 준비되지 않았습니다. ' : '저장됨. ';
      ecStatus(omit ? 'warn' : 'ok', omitLine + '승인·가이드 준비·실행 통과가 아닙니다. · ' + ecGrantLine(result.data));
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
      var caseId = ecSavedCaseId || $('ec-case-id').value.trim() || $('ec-resume-id').value.trim();
      if (!ecSavedCaseId && !caseId) {
        ecStatus('fail', '내보내기 오류: 저장된 사례가 없습니다. 완료가 아닙니다.');
        return;
      }
      var body = { caseId: caseId };
      if (ecExpectedRevision) body.expectedRevision = ecExpectedRevision;
      var result = await ecCall('/api/engineer-cases/guide-export', body);
      $('ec-json').textContent = JSON.stringify(result.data, null, 2);
      if (!result.data.ok || result.data.downloadComplete !== true || !result.data.artifactId) {
        var exported = result.data.exportedCaseRevision ? ' 생성 문서 사례 revision=' + result.data.exportedCaseRevision : '';
        var current = result.data.currentCaseRevision ? ' 현재 저장 revision=' + result.data.currentCaseRevision : '';
        ecStatus('fail', '내보내기 오류: ' + ecText(result.data.code || result.data.error, 'EXPORT_FAILED') + exported + current + '. 완료가 아닙니다. · ' + ecGrantLine(result.data));
        return;
      }
      var downloaded = await ecDownloadDocx(result.data.caseId, result.data.artifactId);
      if (!downloaded) {
        ecStatus('fail', '내보내기는 되었으나 내려받기에 실패했습니다. 완료가 아닙니다. · ' + ecGrantLine(result.data));
        return;
      }
      var changed = ' 생성 문서 사례 revision=' + result.data.exportedCaseRevision +
        ' · 가이드 revision=' + result.data.exportedGuideRevision +
        (result.data.revisionChangedDuringExport
          ? ' · 현재 저장 revision=' + result.data.currentCaseRevision + ' (생성 문서와 다름)'
          : '') + '.';
      ecStatus('warn', 'Word를 받았습니다. 승인·가이드 준비·실행 통과가 아닙니다.' + changed + ' · ' + ecGrantLine(result.data));
      $('ec-artifact-id').value = result.data.artifactId;
      if (result.data.currentCaseRevision) {
        $('ec-revision').value = result.data.currentCaseRevision;
        ecExpectedRevision = result.data.currentCaseRevision;
      }
    };
`;
