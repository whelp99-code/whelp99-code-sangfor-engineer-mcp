export const DASHBOARD_STYLE_BLOCK = `  <style>
    :root { --bg:#0f172a; --card:#1e293b; --accent:#38bdf8; --text:#e2e8f0; --muted:#94a3b8; --ok:#4ade80; --warn:#fbbf24; --err:#f87171; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:Segoe UI,system-ui,sans-serif; background:var(--bg); color:var(--text); }
    header { padding:16px 24px; border-bottom:1px solid #334155; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px; }
    h1 { margin:0; font-size:1.25rem; }
    .badge { background:#0369a1; padding:4px 10px; border-radius:999px; font-size:.75rem; }
    .auth-box { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
    .auth-box input { width:220px; }
    .auth-box button { padding:8px 10px; border:1px solid #334155; border-radius:8px; background:#0b1220; color:var(--text); cursor:pointer; }
    .auth-hint { color:var(--warn); font-size:.8rem; }
    main { display:grid; grid-template-columns:200px 1fr; min-height:calc(100vh - 56px); }
    nav { padding:16px; border-right:1px solid #334155; }
    nav button { display:block; width:100%; text-align:left; margin:4px 0; padding:9px 11px; border:1px solid #334155; border-radius:8px; background:var(--card); color:var(--text); cursor:pointer; font-size:.9rem; }
    nav button.active { border-color:var(--accent); background:#0c4a6e; }
    section { padding:20px 24px; overflow:auto; }
    .panel { display:none; }
    .panel.active { display:block; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px; }
    .card { background:var(--card); border:1px solid #334155; border-radius:12px; padding:14px; }
    .card h3 { margin:0 0 8px; font-size:.95rem; color:var(--accent); }
    .meta { color:var(--muted); font-size:.82rem; margin-bottom:8px; }
    .stats { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
    .stat { background:var(--card); border:1px solid #334155; border-radius:10px; padding:10px 14px; min-width:100px; }
    .stat strong { display:block; font-size:1.35rem; color:var(--accent); }
    a.link { color:var(--accent); }
    label { display:block; margin:8px 0 4px; font-size:.85rem; color:var(--muted); }
    input, select, textarea { width:100%; padding:8px 10px; border:1px solid #334155; border-radius:8px; background:#0b1220; color:var(--text); font:inherit; }
    textarea { min-height:80px; resize:vertical; }
    button.primary { margin-top:12px; padding:10px 16px; border:none; border-radius:8px; background:var(--accent); color:#0f172a; font-weight:600; cursor:pointer; }
    button.primary:disabled { opacity:.5; cursor:not-allowed; }
    pre.result { background:#0b1220; border:1px solid #334155; border-radius:10px; padding:12px; overflow:auto; max-height:420px; font-size:.8rem; white-space:pre-wrap; word-break:break-word; }
    .health-ok { color:var(--ok); }
    .health-off { color:var(--muted); }
    .health-bad { color:var(--err); }
    .doc-list { list-style:none; padding:0; margin:0; }
    .doc-list li { margin:8px 0; }
    iframe { width:100%; height:360px; border:1px solid #334155; border-radius:12px; background:#fff; }
    .snippet { font-size:.88rem; line-height:1.4; max-height:4.2em; overflow:hidden; }
    .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    @media (max-width:768px) { main { grid-template-columns:1fr; } nav { display:flex; flex-wrap:wrap; gap:6px; border-right:none; border-bottom:1px solid #334155; } nav button { width:auto; } .row2 { grid-template-columns:1fr; } }
  </style>`;
