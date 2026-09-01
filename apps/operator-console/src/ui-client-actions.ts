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
    };`;
