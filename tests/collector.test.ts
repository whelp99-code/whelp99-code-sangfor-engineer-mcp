import { describe, expect, it } from 'vitest';
import {
  htmlToText,
  isCommunityNoise,
  parseCommunityThread,
  parseCommunityThreadIds,
  parseKbCategoryNavigation
} from '../packages/sangfor-collector/src/index.js';

describe('sangfor-collector', () => {
  it('parses community thread ids from forum HTML', () => {
    const html = '<a href="forum.php?mod=viewthread&amp;tid=12345">x</a>';
    expect(parseCommunityThreadIds(html)).toEqual([12345]);
  });

  it('skips noisy community titles', () => {
    expect(isCommunityNoise('Round 60 | Join the Daily Q&A Challenge and Get Coins')).toBe(true);
    expect(isCommunityNoise('Block Indonesia Online Gambling')).toBe(false);
  });

  it('extracts first post body from thread HTML', () => {
    const html = `
      <span id="thread_subject">HCI storage MTU issue</span>
      <td class="t_f" id="postmessage_1"><p>Storage network MTU must be 9000 end-to-end before cluster initialization. Validate switch ports, host NICs, and storage targets on the same VLAN before enabling jumbo frames in production HCI deployments.</p></td>
    `;
    const doc = parseCommunityThread(html, 1, 'https://community.sangfor.com/forum.php?mod=viewthread&tid=1');
    expect(doc?.product).toBe('HCI');
    expect(doc?.text.toLowerCase()).toContain('mtu');
  });

  it('parses KB navigation article ids', () => {
    const nav = {
      cloudModule: {
        cloudProducts: {
          items: [
            {
              name: 'HCI',
              link: '/detailPage?articleData=%7B%22articleType%22%3A1,%22articleId%22%3A%22abc123%22%7D'
            }
          ]
        }
      }
    };
    const articles = parseKbCategoryNavigation(nav, 'https://knowledgebase.sangfor.com');
    expect(articles.some(a => a.articleId === 'abc123' && a.product === 'HCI')).toBe(true);
  });

  it('strips HTML to plain text', () => {
    expect(htmlToText('<p>Hello <b>HCI</b></p>')).toContain('Hello HCI');
  });
});
