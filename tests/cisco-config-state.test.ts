import { describe, it, expect } from 'vitest';
import { mapCiscoConfigState } from '@sangfor-engineer/cisco-client';

describe('mapCiscoConfigState', () => {
  it('counts total interfaces from RESTCONF response', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [
        { name: 'GigabitEthernet0/0/0' },
        { name: 'GigabitEthernet0/0/1' },
        { name: 'Loopback0' },
      ],
    };

    const items = mapCiscoConfigState(apiResponse, 'api');

    const interfaceCount = items.find((item) => item.observedKey === 'interfaceCount');
    expect(interfaceCount?.value).toBe(3);
    expect(interfaceCount?.source).toBe('api');
  });

  it('counts loopback interfaces separately', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [
        { name: 'GigabitEthernet0/0/0' },
        { name: 'Loopback0' },
        { name: 'Loopback1' },
        { name: 'Loopback2' },
      ],
    };

    const items = mapCiscoConfigState(apiResponse, 'mock');

    const loopbackCount = items.find((item) => item.observedKey === 'loopbackCount');
    expect(loopbackCount?.value).toBe(3);
    expect(loopbackCount?.source).toBe('mock');
  });

  it('extracts static route count from routing section', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [],
      'ietf-routing:routing': {
        'static-routes': {
          static: [
            { destination_prefix: '10.0.0.0/8' },
            { destination_prefix: '192.168.0.0/16' },
          ],
        },
      },
    };

    const items = mapCiscoConfigState(apiResponse, 'api');

    const staticRouteCount = items.find((item) => item.observedKey === 'staticRouteCount');
    expect(staticRouteCount?.value).toBe(2);
  });

  it('detects OSPF when control-plane-protocol includes ospf', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [],
      'ietf-routing:routing': {
        'control-plane-protocols': {
          'control-plane-protocol': [
            { type: 'ospf', name: 'ospf_1' },
          ],
        },
      },
    };

    const items = mapCiscoConfigState(apiResponse, 'api');

    const ospfEnabled = items.find((item) => item.observedKey === 'ospfEnabled');
    expect(ospfEnabled?.value).toBe(true);
  });

  it('returns zero static routes when none present', () => {
    const apiResponse = {
      'ietf-interfaces:interface': [],
      'ietf-routing:routing': {
        'static-routes': {
          static: undefined,
        },
      },
    };

    const items = mapCiscoConfigState(apiResponse, 'api');

    const staticRouteCount = items.find((item) => item.observedKey === 'staticRouteCount');
    expect(staticRouteCount?.value).toBe(0);
  });
});
