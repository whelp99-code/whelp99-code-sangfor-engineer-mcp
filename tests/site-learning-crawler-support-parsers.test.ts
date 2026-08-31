import { describe, expect, it } from 'vitest';
import {
  flattenSupportLeaves,
  parseSupportCasePage,
  parseSupportProductVersions,
  parseSupportShowcaseRows,
  selectSupportProductVersions
} from '../packages/sangfor-collector/src/site-learning-crawler.js';

describe('two-site learning crawler Support portal payload parsers', () => {
  it('parses every Support product and version without fabricating IDs', () => {
    const parsed = parseSupportProductVersions({
      code: 200,
      data: {
        10: {
          id: 10,
          name: 'Hyper Converged Infrastructure (HCI/aSV)',
          version: [
            { id: 1381, name: '6.11.3', product_id: 10 },
            { id: 1150, name: 'All versions', product_id: 10 }
          ]
        }
      }
    });
    expect(parsed).toEqual([
      { productId: 10, productName: 'Hyper Converged Infrastructure (HCI/aSV)', versionId: 1381, versionName: '6.11.3' },
      { productId: 10, productName: 'Hyper Converged Infrastructure (HCI/aSV)', versionId: 1150, versionName: 'All versions' }
    ]);
  });

  it('selects every concrete version and skips aggregate aliases', () => {
    expect(selectSupportProductVersions([
      { productId: 10, productName: 'HCI', versionId: 1381, versionName: '6.11.3' },
      { productId: 10, productName: 'HCI', versionId: 1150, versionName: 'All versions' },
      { productId: 10, productName: 'HCI', versionId: 1370, versionName: '6.11.2' },
      { productId: 11, productName: 'VDI', versionId: 1389, versionName: '5.9.6R1' }
    ])).toEqual([
      { productId: 10, productName: 'HCI', versionId: 1381, versionName: '6.11.3' },
      { productId: 10, productName: 'HCI', versionId: 1370, versionName: '6.11.2' },
      { productId: 11, productName: 'VDI', versionId: 1389, versionName: '5.9.6R1' }
    ]);
  });

  it('flattens Support category trees into leaf document URLs', () => {
    expect(flattenSupportLeaves([
      {
        id: 94,
        name: 'User Manual',
        children: [{
          id: 101,
          name: 'Installation',
          children: [{ id: 102, name: 'Power' }, { id: 103, name: 'Wiring' }]
        }]
      }
    ])).toEqual([
      { categoryId: 102, path: ['User Manual', 'Installation', 'Power'] },
      { categoryId: 103, path: ['User Manual', 'Installation', 'Wiring'] }
    ]);
  });

  it('parses Support showcase links and paginated troubleshooting cases', () => {
    expect(parseSupportShowcaseRows({
      code: 0,
      rows: [{
        id: 32,
        code: 'TROUBLESHOOTING_CASES',
        name: 'HCI/aSV',
        linkUrl: '/cases/list?product_id=10&type=1',
        remark: 'Hyper Converged Infrastructure'
      }]
    })).toEqual([{
      id: 32,
      code: 'TROUBLESHOOTING_CASES',
      name: 'HCI/aSV',
      linkUrl: '/cases/list?product_id=10&type=1',
      remark: 'Hyper Converged Infrastructure'
    }]);
    expect(parseSupportCasePage({
      code: 0,
      rows: {
        content: [{
          id: '2:309038',
          title: 'HCI diagnosis tool',
          content: '<p>Run the diagnostic tool and inspect the report.</p>',
          product: '10'
        }],
        totalPages: 11
      }
    })).toEqual({
      totalPages: 11,
      cases: [{
        id: '2:309038',
        title: 'HCI diagnosis tool',
        text: 'Run the diagnostic tool and inspect the report.',
        productId: 10
      }]
    });
  });
});
