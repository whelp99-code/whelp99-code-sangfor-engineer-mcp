export const ENGINEER_CASE_RENDER_SCRIPT = `
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
      $('ec-json').textContent = JSON.stringify(data.document || data, null, 2);
    }
`;
