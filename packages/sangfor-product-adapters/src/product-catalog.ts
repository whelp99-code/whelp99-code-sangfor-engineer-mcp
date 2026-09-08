import type { RiskLevel } from '@sangfor/shared';
import type { AutomationProductCode, ProductAdapter, ProductCapability } from './types.js';

const HCI_SCP_ENDPOINTS = [
  'POST /janus/v2/public-key',
  'POST /janus/v2/login',
  'GET /janus/20180725/tasks/{task_id}',
  'GET /openstack/compute/v2/servers',
  'GET /openstack/image/v2/images',
  'GET /openstack/volume/v2/volumes',
  'GET /openstack/network/v2.0/networks'
];

const IAG_WEBUI_ROUTES = [
  'WEBUI GET System > Interfaces',
  'WEBUI GET System > Routing',
  'WEBUI GET User Management > Authentication Source',
  'WEBUI GET Policy > Access Control',
  'WEBUI GET Policy > URL/Application Control',
  'WEBUI GET Logs > Internet Access Logs'
];

const ENDPOINT_SECURE_WEBUI_ROUTES = [
  'WEBUI GET Dashboard (Home) > Agent Status',
  'WEBUI GET Defense > Malware Scan',
  'WEBUI GET Policies > App Control',
  'WEBUI GET Policies > General Policies > Endpoint Control > USB Device Control',
  'WEBUI GET Detection and Response > Security Events',
  'WEBUI GET Endpoints > Endpoint Inventory',
  'WEBUI GET System > Agent Deployment',
  'WEBUI GET System > Data Sync > Syslog Reporting'
];

const NDR_API_ENDPOINTS = [
  'GET /api/v1/event_sources',
  'GET /api/v1/sensors',
  'GET /api/v1/incidents',
  'GET /api/v1/alerts/rules',
  'GET /api/v1/dashboards',
  'GET /api/v1/soar/playbooks',
  'POST /api/v1/soar/playbooks/{id}/execute'
];

export const LEGACY_ADAPTERS: Record<AutomationProductCode, ProductAdapter> = {
  HCI_SCP: {
    product: 'HCI_SCP',
    aliases: ['hci_scp', 'hci/scp', 'scp', 'hci', 'acloud', 'sangfor cloud platform'],
    strategy: 'api-first',
    authMethods: ['SCP OpenAPI token/signature flow', 'WebUI session fallback'],
    apiLikely: true,
    apiCatalogStatus: 'ready',
    menuRoutes: [
      'Home > Overview',
      'Resource Center > Resource Pools',
      'Resource Center > Virtual Machines',
      'Resource Center > Network > Topology',
      'Reliability > HA',
      'Reliability > DRS',
      'System > Licensing',
      'Operations > Alerts',
      'Operations > Tasks'
    ],
    capabilities: [
      capability('resource_inventory', 'Resource pool, node, VM, storage, network collection', ['version', 'license', 'resource_pool', 'node', 'vm', 'storage', 'network', 'alert', 'task'], ['resource', 'node', 'vm', 'storage', 'network', 'inventory', 'alert', 'license'], 'low', false, ['Resource Center', 'Resource Pools'], HCI_SCP_ENDPOINTS),
      capability('ha_drs', 'HA/DRS planning', ['ha', 'drs', 'resource_pool', 'task'], ['ha', 'drs', 'availability', 'cluster balance'], 'high', true, ['Reliability', 'HA/DRS'], ['GET /janus/20180725/tasks/{task_id}', 'PUT /openstack/compute/v2/servers/{id}/metadata']),
      capability('vm_resource', 'VM resource and power operation planning', ['vm', 'task'], ['vm', 'cpu', 'memory', 'migrate', 'power', 'delete'], 'critical', true, ['Resource Center', 'Virtual Machines'], ['GET /openstack/compute/v2/servers', 'POST /openstack/compute/v2/servers/{id}/action']),
      capability('license_alert', 'License and alert mismatch validation', ['version', 'license', 'alert'], ['license', 'mismatch', 'alert', 'ntp'], 'medium', false, ['System', 'Licensing'], ['GET /janus/20180725/tasks/{task_id}'])
    ]
  },
  IAG: {
    product: 'IAG',
    aliases: ['iag', 'internet access gateway', 'iam', 'access gateway'],
    strategy: 'webui-first',
    authMethods: ['WebUI session', 'Network/API discovery when enabled'],
    apiLikely: false,
    apiCatalogStatus: 'ready',
    menuRoutes: [
      'System > Interfaces',
      'System > Routing',
      'User Management > Authentication Source',
      'Policy > Access Control',
      'Policy > URL/Application Control',
      'Logs > Internet Access Logs'
    ],
    capabilities: [
      capability('auth_source', 'AD/LDAP and authentication policy planning', ['version', 'license', 'interface', 'route', 'user_auth'], ['ad', 'ldap', 'authentication', 'user', 'group', 'sso'], 'high', true, ['User Management', 'Authentication Source'], IAG_WEBUI_ROUTES),
      capability('internet_policy', 'Internet access, URL and application policy planning', ['access_policy', 'url_application_policy', 'logs'], ['internet', 'url', 'application', 'policy', 'exception', 'allow', 'block'], 'high', true, ['Policy', 'Access Control'], IAG_WEBUI_ROUTES),
      capability('log_validation', 'Log and audit validation', ['logs'], ['log', 'audit', 'report', 'verify'], 'low', false, ['Logs', 'Internet Access Logs'], IAG_WEBUI_ROUTES)
    ]
  },
  ENDPOINT_SECURE: {
    product: 'ENDPOINT_SECURE',
    aliases: ['endpoint secure', 'endpoint security', 'edr', 'epp', 'asec'],
    strategy: 'webui-first',
    authMethods: ['WebUI session', 'Operator dry-run route catalog'],
    apiLikely: false,
    apiCatalogStatus: 'ready',
    menuRoutes: [
      'Dashboard (Home)',
      'Detection and Response > Security Events',
      'Defense > Malware Scan',
      'Endpoints > Endpoint Inventory',
      'Policies > App Control',
      'Policies > General Policies > Endpoint Control > USB Device Control',
      'System > Agent Deployment',
      'System > Data Sync > Syslog Reporting'
    ],
    capabilities: [
      capability('endpoint_inventory', 'Endpoint, agent and update status collection', ['license', 'endpoint_agent', 'update_status'], ['endpoint', 'agent', 'online', 'offline', 'update', '에이전트', '설치'], 'low', false, ['Dashboard (Home)'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('protection_policy', 'Anti-malware scan and protection policy', ['policy', 'malware_ransomware', 'exception_list'], ['policy', 'malware', 'ransomware', 'scan', 'anti-virus', 'antivirus', 'engine update', '검사', '엔진'], 'high', true, ['Defense', 'Malware Scan'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('app_control', 'Software/application control policy', ['policy', 'software_control'], ['software control', 'unauthorized software', 'application', 'app control', '소프트웨어', '통제'], 'high', true, ['Policies', 'App Control'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('device_control', 'USB and device control policy', ['policy', 'device_control'], ['device control', 'usb', 'storage media', '저장매체', 'usb device'], 'high', true, ['Policies', 'General Policies', 'Endpoint Control', 'USB Device Control'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('security_events', 'Security event logs and audit trail', ['logs', 'security_events', 'audit'], ['log', 'event', 'audit', 'detection', '보안 이벤트', '로그', '감사'], 'low', false, ['Detection and Response', 'Security Events'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('agent_deployment', 'Agent deployment planning', ['endpoint_agent', 'policy'], ['deploy', 'deployment', 'install', 'agent', 'agent rollout', '배포'], 'high', true, ['System', 'Agent Deployment'], ENDPOINT_SECURE_WEBUI_ROUTES),
      capability('syslog_export', 'Syslog/SIEM log forwarding', ['logs', 'syslog', 'siem'], ['syslog', 'siem', 'log export', 'data sync', '로그 전송'], 'medium', false, ['System', 'Data Sync', 'Syslog Reporting'], ENDPOINT_SECURE_WEBUI_ROUTES)
    ]
  },
  NDR: {
    product: 'NDR',
    aliases: ['ndr', 'cyber command', 'athena ndr', 'soc'],
    strategy: 'hybrid',
    authMethods: ['WebUI session', 'NDR REST API catalog (third-party integration doc)'],
    apiLikely: true,
    apiCatalogStatus: 'ready',
    menuRoutes: [
      'Dashboard > Security Operations',
      'Assets > Sensors/Connectors',
      'Events > Event Sources',
      'Incidents > Incident List',
      'Alerts > Alert Rules',
      'SOAR > Playbooks',
      'System > Integrations'
    ],
    capabilities: [
      capability('event_source', 'Event source and sensor integration planning', ['version', 'license', 'event_sources', 'sensors_connectors', 'integration_status'], ['event source', 'sensor', 'connector', 'syslog', 'api source', 'ngaf', 'iag', 'endpoint'], 'medium', false, ['Events', 'Event Sources'], NDR_API_ENDPOINTS),
      capability('incident_alert', 'Incident, alert and dashboard validation', ['incidents', 'alerts'], ['incident', 'alert', 'dashboard', 'report'], 'low', false, ['Incidents', 'Incident List'], NDR_API_ENDPOINTS),
      capability('soar_response', 'SOAR/playbook response action planning', ['soar_playbooks'], ['soar', 'playbook', 'response', 'isolate', 'block', 'quarantine'], 'critical', true, ['SOAR', 'Playbooks'], NDR_API_ENDPOINTS)
    ]
  }
};

function capability(
  id: string,
  title: string,
  collectSections: string[],
  planKeywords: string[],
  riskLevel: RiskLevel,
  approvalRequired: boolean,
  menuPath: string[],
  apiEndpointCandidates: string[]
): ProductCapability {
  return { id, title, collectSections, planKeywords, riskLevel, approvalRequired, menuPath, apiEndpointCandidates };
}
