import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfluenceJiraList } from '../../shared/confluence-jira-list.js';
import { JIRA_SAVED_VIEW_QUERY_LIMIT } from '../../shared/types.js';

const parameter = (name: string, value: string) => `<ac:parameter ac:name="${name}">${value}</ac:parameter>`;
const query = parameter('jqlQuery', 'project = OLD AND status = Open');
const macro = (body: string, attributes = 'ac:name="jira"') =>
  `<ac:structured-macro ${attributes}>${body}</ac:structured-macro>`;

test('reads the literal modern list query and display options from preserved Confluence XML', () => {
  const raw = macro([
    parameter('server', 'Original Jira &amp; QA'),
    parameter('serverId', '144880e9-a1111-333f-9412-ed999a9999fa'),
    parameter('columns', 'key,summary,assignee,status'),
    parameter('maximumIssues', '20'),
    parameter('jqlQuery', 'project = &quot;OLD&quot; AND status = &apos;QA &amp; Review&apos;'),
  ].join('\r\n'), 'ac:name="Jira" ac:schema-version="1" ac:macro-id="synthetic" xmlns:ac="http://atlassian.com/content"');
  assert.deepEqual(parseConfluenceJiraList(` \n${raw}\n `), {
    jql: 'project = "OLD" AND status = \'QA & Review\'', server: 'Original Jira & QA', columns: 'key,summary,assignee,status', maximumIssues: 20,
  });
  assert.deepEqual(parseConfluenceJiraList(macro(query)), { jql: 'project = OLD AND status = Open' });
});

test('accepts a legacy standalone list with literal JQL and default visibility', () => {
  const raw = `<ac:macro ac:name='JIRAISSUES'>
    ${parameter('jqlQuery', 'project=OLD AND status = &#34;Ready &amp;lt; check&#x22;')}
    ${parameter('count', 'false')}
    ${parameter('cache', 'off')}
    ${parameter('anonymous', 'false')}
    ${parameter('renderMode', 'static')}
    ${parameter('columns', 'type;key;summary')}
  </ac:macro>`;
  assert.deepEqual(parseConfluenceJiraList(raw), { jql: 'project=OLD AND status = "Ready &lt; check"', columns: 'type;key;summary' });
});

test('preserves source-only macro variants and refuses ambiguous or malformed XML', () => {
  const unsupported = [
    'const query = "project = OLD";',
    macro(parameter('key', 'OLD-42')),
    macro(query + parameter('issueKey', 'OLD-42')),
    macro(query + parameter('count', 'true')),
    macro(query + parameter('anonymous', 'true')),
    macro(query + parameter('url', '<ri:url ri:value="https://jira.example.test/issues?filter=1"/>')),
    macro(parameter('filterId', '10600')),
    macro(query + parameter('sortBy', 'updated')),
    macro(query + query),
    macro(parameter('jqlQuery', '<strong>project = OLD</strong>')),
    macro(query + '<ac:rich-text-body><p>extra</p></ac:rich-text-body>'),
    macro(query, 'ac:name="jira" ac:schema-version="2"'),
    macro(query, 'ac:name="jira" ac:name="jira"'),
    macro(query, 'ac:name="jira" xmlns:ac="https://unrelated.example.test"'),
    macro(query, 'ac:name="jira" ac:macro-id="bad<id"'),
    macro(query, 'ac:name="jira" arbitrary="ignored"'),
    macro(query, 'ac:name="code"'),
    macro(query + '<script/>'),
    macro(query + 'trailing text'),
    macro(query + parameter('maximumIssues', '0')),
    macro(query + parameter('maximumIssues', '1e2')),
    macro(query + parameter('maximumIssues', '99999999999999999')),
    macro(parameter('jqlQuery', ' ')),
    `${macro(query)}${macro(query)}`,
    `<p>${macro(query)}</p>`,
    `<ac:structured-macro ac:name="jira">${query}</ac:macro>`,
    `<!DOCTYPE ac:structured-macro SYSTEM "https://jira.example.test/unsafe">${macro(query)}`,
    macro(`<?anything ignored?>${query}`),
    macro(parameter('jqlQuery', 'project = &unresolved;')),
    macro(parameter('jqlQuery', 'project = &')),
    macro(parameter('jqlQuery', 'project = &#0;')),
    macro(parameter('jqlQuery', 'project = &#xD800;')),
    macro(parameter('jqlQuery', 'project = &#x110000;')),
    macro(parameter('jqlQuery', 'project = \u0000')),
  ];
  for (const raw of unsupported) assert.equal(parseConfluenceJiraList(raw), undefined, raw);
});

test('enforces the team JQL bound after XML decoding and skips oversized raw blocks', () => {
  const escaped = '&amp;'.repeat(JIRA_SAVED_VIEW_QUERY_LIMIT);
  assert.equal(parseConfluenceJiraList(macro(parameter('jqlQuery', escaped)))?.jql.length, JIRA_SAVED_VIEW_QUERY_LIMIT);
  assert.equal(parseConfluenceJiraList(macro(parameter('jqlQuery', `${escaped}x`))), undefined);
  assert.equal(parseConfluenceJiraList(macro(query + parameter('server', 'x'.repeat(64 * 1024)))), undefined);
});
