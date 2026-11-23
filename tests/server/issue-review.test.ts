import assert from 'node:assert/strict';
import test from 'node:test';
import { issueReviewPosition } from '../../src/lib/issue-review.js';

const issue = (id: string, projectId = 'alpha', key = `ALPHA-${id}`) => ({ id, key, projectId });

test('review follows the captured render order with current issue keys and skips deleted neighbors', () => {
  const order = ['3', '2', '4', '1'];
  const issues = [issue('1'), issue('3', 'alpha', 'ALPHA-30'), issue('8'), issue('4')];
  assert.deepEqual(issueReviewPosition(order, '4', issues, 'alpha'), {
    position: 2, total: 3, previous: { id: '3', key: 'ALPHA-30' }, next: { id: '1', key: 'ALPHA-1' },
  });
  assert.deepEqual(issueReviewPosition(order, '3', issues, 'alpha'), {
    position: 1, total: 3, previous: null, next: { id: '4', key: 'ALPHA-4' },
  });
  assert.equal(issueReviewPosition(order, '8', issues, 'alpha'), undefined);
  assert.equal(issueReviewPosition(order, '2', issues, 'alpha'), undefined);
});

test('project review skips moved targets and keeps a still-open issue as its anchor', () => {
  const order = ['1', '2', '3', '4', '4'];
  const issues = [issue('1', 'beta'), issue('2', 'beta'), issue('3', 'beta'), issue('4')];
  assert.deepEqual(issueReviewPosition(order, '2', issues, 'alpha'), {
    position: 1, total: 2, previous: null, next: { id: '4', key: 'ALPHA-4' },
  });
  assert.deepEqual(issueReviewPosition(order, '2', issues, null), {
    position: 2, total: 4, previous: { id: '1', key: 'ALPHA-1' }, next: { id: '3', key: 'ALPHA-3' },
  });
});
