import { DASHBOARD_STYLE_BLOCK } from './ui-styles.js';
import { DASHBOARD_BODY } from './ui-layout.js';
import { CLIENT_CORE_SCRIPT } from './ui-client-core.js';
import { CLIENT_ACTION_SCRIPT } from './ui-client-actions.js';

export { API_TOKEN_STORAGE_KEY, buildApiHeaders } from './ui-auth.js';

export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sangfor Engineer Web</title>
${DASHBOARD_STYLE_BLOCK}
</head>
<body>
${DASHBOARD_BODY}
  <script>
${CLIENT_CORE_SCRIPT}

${CLIENT_ACTION_SCRIPT}

    initTokenInput();
    loadDashboard();
  </script>
</body>
</html>`;
}
