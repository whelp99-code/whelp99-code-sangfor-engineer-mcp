import { describe, expect, it } from 'vitest';
import {
  extractCommunityForumIds,
  extractCommunityForumPageCount,
  extractCommunityPageCount,
  extractCommunityThreadIds,
  extractCommunityThreadPageCount,
  parseCommunityThreadPage
} from '../packages/sangfor-collector/src/site-learning-crawler.js';

describe('two-site learning crawler Community forum page parsers', () => {
  it('discovers every forum and thread ID from Discuz links', () => {
    const html = `
      <a href="forum.php?mod=forumdisplay&amp;fid=156">HCI</a>
      <a href="/forum.php?mod=forumdisplay&fid=167&page=2">IAG</a>
      <a href="forum.php?mod=viewthread&amp;tid=12230">Thread</a>
      <a href="thread-7805-1-1.html">Pretty thread</a>
    `;
    expect(extractCommunityForumIds(html)).toEqual([156, 167]);
    expect(extractCommunityThreadIds(html)).toEqual([7805, 12230]);
  });

  it('extracts all public post bodies from a Community thread page', () => {
    expect(parseCommunityThreadPage(`
      <title>HCI MTU troubleshooting - Sangfor Community</title>
      <td class="t_f" id="postmessage_1"><p>Set the storage MTU to 9000.</p></td>
      <td class="t_f" id="postmessage_2"><p>Verify the setting from every node.</p></td>
    `)).toEqual({
      title: 'HCI MTU troubleshooting - Sangfor Community',
      text: 'Set the storage MTU to 9000.\n\nVerify the setting from every node.'
    });
  });

  it('falls back to the AngularJS postlistData JSON payload when no server-rendered post markup exists', () => {
    // Some Discuz threads (viewthread module) render posts entirely client-side via
    // angular.module('viewthread').value('postlistData', {...}) instead of emitting
    // <td class="t_f" id="postmessage_N"> markup — a static regex on classic markup
    // silently drops these threads even though the real post text is present as an
    // escaped JSON string literal in the page.
    const html = `
      <title>How to Participate in Sangfor Beta Program? - Sangfor Community</title>
      <script>
        angular.module('viewthread').value('postlistData', {"151778":{"pid":"151778","tid":"8304","first":"1","author":"Sangfor Jojo","subject":"Beta","message":"<p>What Is Beta Program<\\/p>\\r\\n<p>Line two.<\\/p>"}});
      </script>
    `;
    expect(parseCommunityThreadPage(html)).toEqual({
      title: 'How to Participate in Sangfor Beta Program? - Sangfor Community',
      text: 'What Is Beta Program Line two.'
    });
  });

  it('returns null when neither server-rendered markup nor postlistData JSON contains a post body', () => {
    expect(parseCommunityThreadPage('<title>Empty</title><div>no posts here</div>')).toBeNull();
  });

  it('detects the last Discuz pagination page and defaults to one', () => {
    expect(extractCommunityPageCount(
      '<a href="forum.php?mod=forumdisplay&fid=156&page=2">2</a><a href="forum.php?mod=forumdisplay&fid=156&page=19">19</a>'
    )).toBe(19);
    expect(extractCommunityPageCount('<div>No pagination</div>')).toBe(1);
  });

  it('does not confuse forum and thread pagination links', () => {
    const html = `
      <a href="forum.php?mod=forumdisplay&fid=156&page=9">Forum 9</a>
      <a href="forum.php?mod=viewthread&tid=12230&page=31">Thread 31</a>
      <a href="forum-156-19.html">Pretty forum 19</a>
      <a href="thread-12230-41-1.html">Pretty thread 41</a>
    `;
    expect(extractCommunityForumPageCount(html, 156)).toBe(19);
    expect(extractCommunityThreadPageCount(html, 12230)).toBe(41);
  });
});
