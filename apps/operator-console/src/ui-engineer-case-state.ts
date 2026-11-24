// One owner for review/persistence/generation state and server-driven form writes.
export const ENGINEER_CASE_STATE_SCRIPT = `
    var ecState = { generation: 0, document: null, fingerprint: '', persisted: null, resumedCaseId: '', editableCaseId: '', mustResume: false };
    var ecLastSave = null;
    try { ecLastSave = JSON.parse(sessionStorage.getItem('sangfor_ec_last_save') || 'null'); } catch (e) {}
    var ecFields = ['ec-case-id','ec-mode','ec-product','ec-firmware','ec-revision','ec-reqs','ec-collections','ec-analysis'];
    function ecFingerprint() { return JSON.stringify(ecFields.map(function (id) { return $(id).value; })); }
    function ecTransition(kind, data) {
      if (kind === 'start' || kind === 'invalidate') {
        ecState.generation++;
        if (kind === 'invalidate') {
          ecState.document = null; ecState.fingerprint = '';
          var persisted = ecState.persisted;
          if (persisted && persisted.caseId === ecState.editableCaseId && persisted.caseId === $('ec-case-id').value.trim() && $('ec-revision').value === persisted.revision) {
            $('ec-revision').value = 'rev-' + Date.now() + '-' + ecState.generation;
          }
        }
        return { generation: ecState.generation, fingerprint: ecFingerprint() };
      }
      if (kind === 'review') {
        if (data.document) {
          $('ec-case-id').value = data.document.caseId; $('ec-revision').value = data.document.revision;
          // Track editable drafts separately; a previously resumed rich original stays protected.
          ecState.editableCaseId = data.document.caseId;
        }
        ecState.document = data.document || null; ecState.fingerprint = ecFingerprint();
      }
      if (kind === 'resume') {
        var doc = data.document;
        $('ec-case-id').value = doc.caseId; $('ec-revision').value = doc.revision;
        $('ec-mode').value = doc.mode; $('ec-product').value = doc.product; $('ec-firmware').value = doc.firmware || '';
        $('ec-reqs').value = doc.requirements.map(function (r) { return r.constraint || r.acceptanceCriterion; }).join('\\n');
        $('ec-collections').value = doc.observations.map(function (o) {
          var d = o.value.presence === 'known' ? o.value.data : {};
          var value = d.kind === 'number' ? d.number : d.kind === 'integer' ? d.integer : d.kind === 'string' ? d.text : '';
          return [o.target || o.id, value, d.unit || '', o.id].join(' | ');
        }).join('\\n');
        $('ec-analysis').value = '';
        ecState.document = doc; ecState.resumedCaseId = doc.caseId; ecState.editableCaseId = ''; ecState.mustResume = false;
        ecState.fingerprint = ecFingerprint();
        ecState.persisted = { caseId: doc.caseId, revision: doc.revision, fingerprint: ecState.fingerprint };
      }
      if (kind === 'save') {
        $('ec-case-id').value = data.caseId; $('ec-revision').value = data.revision;
        ecState.document = null; ecState.fingerprint = '';
        ecState.persisted = { caseId: data.caseId, revision: data.revision, fingerprint: ecFingerprint() };
        // Keep the exact reviewed document for repeat saves, never rebuild a resumed case.
        if (data.document) { ecState.document = data.document; ecState.fingerprint = ecFingerprint(); }
        ecLastSave = { caseId: data.caseId, omit: data.applyFileOmitted, unresolved: data.unresolved };
        try { sessionStorage.setItem('sangfor_ec_last_save', JSON.stringify(ecLastSave)); } catch (e) {}
      }
      if (kind === 'export') {
        ecState.document = null; ecState.fingerprint = ''; ecState.mustResume = true;
        ecState.persisted = null;
      }
    }
    function ecCurrent(token) { return token.generation === ecState.generation && token.fingerprint === ecFingerprint(); }
    function ecGuardEdit() {
      if (ecState.mustResume) { ecStatus('fail', '서버 revision이 바뀔 수 있습니다. 불러오기 후 다시 검토하세요.'); return false; }
      if (ecState.resumedCaseId === $('ec-case-id').value.trim() && ecState.fingerprint !== ecFingerprint()) {
        ecStatus('fail', '불러온 문서는 원본 그대로만 저장합니다. 편집은 새 사례 ID로 시작하거나 불러오기 하세요.'); return false;
      }
      return true;
    }
    ecFields.forEach(function (id) {
      ['input', 'change'].forEach(function (event) { $(id).addEventListener(event, function () {
        ecTransition('invalidate'); ecStatus('warn', '입력이 바뀌었습니다. 다시 검토·저장해야 합니다.');
      }); });
    });
`;
