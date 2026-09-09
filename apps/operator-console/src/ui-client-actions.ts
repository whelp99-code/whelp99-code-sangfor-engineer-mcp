export const CLIENT_ACTION_SCRIPT = `    $('btn-analyze').onclick = async () => {
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

    function textValue(value, fallback) {
      const text = typeof value === 'string' ? value.trim() : '';
      return text || fallback;
    }

    function appendText(parent, tag, value, className) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      element.textContent = value;
      parent.appendChild(element);
      return element;
    }

    function searchMode(value) {
      if (value === 'semantic' || value === 'hybrid-semantic') return 'semantic';
      if (value === 'hash' || value === 'hybrid-hash') return 'hash';
      if (value === 'bm25') return 'bm25';
      return 'unknown';
    }

    function renderSearchMessage(target, message) {
      target.replaceChildren();
      appendText(target, 'p', message, 'meta');
    }

    function renderSearchCards(target, items, emptyMessage) {
      target.replaceChildren();
      if (!Array.isArray(items) || items.length === 0) {
        appendText(target, 'p', emptyMessage, 'meta');
        return;
      }
      const cards = document.createDocumentFragment();
      items.forEach((item) => {
        const card = document.createElement('article');
        card.className = 'card';
        appendText(card, 'h3', textValue(item.title || item.id, 'untitled'));
        appendText(card, 'div', '제품: ' + textValue(item.product, 'unknown') +
          ' · 버전: ' + textValue(item.version, 'unknown') +
          ' · 섹션: ' + textValue(item.section, 'unknown') +
          ' · 신뢰: ' + textValue(item.trustLevel, 'unknown'), 'meta');
        appendText(card, 'div', '검색 모드: ' + searchMode(item.retrievalMode), 'meta');
        appendText(card, 'div', '출처: ' + textValue(item.source, 'unknown'), 'meta');
        appendText(card, 'p', textValue(item.text || item.snippet, ''), 'snippet');
        cards.appendChild(card);
      });
      target.appendChild(cards);
    }

    $('btn-rag').onclick = async () => {
      try {
        const hits = await api('/api/rag-search', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({
          query: $('rag-query').value.trim(),
          product: $('rag-product').value || undefined,
          version: $('rag-version').value.trim() || undefined,
          limit: Number($('rag-limit').value) || 10
        })});
        const items = hits.items || hits.hits || hits.results || (Array.isArray(hits) ? hits : []);
        renderSearchCards($('rag-hits'), items,
          hits.diagnostics?.evidenceRequirement === 'live-runtime'
            ? '공개 문서로 현재 장비 상태를 확인할 수 없습니다. 권한 있는 장비 조회 결과가 필요합니다.'
            : '결과가 없습니다. 검색어, 제품 또는 버전을 바꿔 다시 검색하세요.');
        if (hits.diagnostics?.degraded) appendText($('rag-hits'), 'p', '검색 기능 일부를 사용할 수 없어 대체 결과를 표시했습니다. 원문을 확인하세요.', 'meta');
      } catch (e) { renderSearchMessage($('rag-hits'), '오류: ' + String(e.message || e)); }
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
      try {
        const data = await api('/api/knowledge?product=' + encodeURIComponent($('kn-product').value) + '&type=' + encodeURIComponent($('kn-type').value));
        renderSearchCards($('kn-content'), data.items, '청크가 없습니다. 제품 또는 유형을 바꿔 다시 불러오세요.');
      } catch (e) { renderSearchMessage($('kn-content'), '오류: ' + String(e.message || e)); }
    };`;
