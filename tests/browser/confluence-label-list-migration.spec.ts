import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { DocPage, LegacyPackageSummary, MigrationApplyResult, MigrationOptions, MigrationPreview, WorkspaceSnapshot } from '../../shared/types';
import { zip } from '../fixtures/legacy-export-zip.mjs';

const property = (name: string, value: string) => `<property name="${name}"><![CDATA[${value}]]></property>`;
const reference = (name: string, kind: string, id: string) => `<property name="${name}" class="${kind}"><id name="id">${id}</id></property>`;
const entity = (kind: string, id: string, content: string) => `<object class="${kind}"><id name="id">${id}</id>${content}</object>`;
const macro = (cql: string) => '<ac:structured-macro ac:name="contentbylabel">' +
  `<ac:parameter ac:name="cql">${cql}</ac:parameter></ac:structured-macro>`;

function exportedPage(id: string, title: string, body: string) {
  return entity('Page', id, property('title', title) + property('version', '1') + reference('space', 'Space', '42') +
    property('creationDate', '2020-01-02T03:04:05Z') + property('lastModificationDate', '2020-01-03T03:04:05Z')) +
    entity('BodyContent', `8${id}`, property('body', body) + property('bodyType', '2') + reference('content', 'Page', id));
}

test('360px에서 이관한 Confluence 라벨 목록은 실제 문서를 열고 넓은 범위의 매크로는 원문과 경고를 보존한다', async ({ page, request }) => {
  test.setTimeout(110_000);
  const suffix = randomUUID().slice(0, 7);
  const key = `LBL${suffix.toUpperCase()}`;
  const filename = `${key}.zip`;
  const projectName = `라벨 이관 프로젝트 ${suffix}`;
  const indexTitle = `배포 문서 색인 ${suffix}`;
  const memberTitle = `배포 운영 절차 ${suffix}`;
  const label = `Release-${suffix}`;
  const sameSpace = `label = ${label.toLowerCase()} AND type = page AND space = currentSpace() ORDER BY title ASC`;
  const widerScope = `label = ${label.toLowerCase()} AND type = page ORDER BY title ASC`;
  const original = macro(widerScope);
  const xml = '<hibernate-generic>' +
    entity('Space', '42', property('key', key) + property('name', projectName)) +
    exportedPage('100', indexTitle, macro(sameSpace) + original) +
    exportedPage('200', memberTitle, '<p>Confluence에서 이관한 운영 절차 본문</p>') +
    entity('Label', '300', property('name', label) + property('namespace', 'global')) +
    entity('Labelling', '400', reference('content', 'Page', '200') + reference('label', 'Label', '300')) +
    '</hibernate-generic>';
  const upload = await request.post(`/api/legacy-import/packages?${new URLSearchParams({ filename, product: 'confluence', instanceKey: `label-macro-${suffix}` })}`, {
    headers: { 'Content-Type': 'application/octet-stream' }, data: zip([{ path: 'entities.xml', bytes: Buffer.from(xml) }]),
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const source = await upload.json() as LegacyPackageSummary;
  let imported: DocPage[] = [];

  try {
    const options = await request.get(`/api/migrations/options?${new URLSearchParams({ packageId: source.id })}`);
    expect(options.ok(), await options.text()).toBe(true);
    const { defaultConfiguration } = await options.json() as MigrationOptions;
    const configuration = { ...defaultConfiguration, projects: defaultConfiguration.projects.map(mapping => ({ ...mapping, key, name: projectName })) };
    const proposed = await request.post('/api/migrations/preview', { data: { configuration } });
    expect(proposed.status(), await proposed.text()).toBe(201);
    const preview = await proposed.json() as MigrationPreview;
    const warningCode = 'LABEL_LIST_PARAMETERS_UNSUPPORTED';
    expect(preview.canApply, JSON.stringify(preview.notices)).toBe(true);
    expect(preview.notices.filter(notice => notice.code.startsWith('LABEL_LIST_'))).toEqual([
      expect.objectContaining({ code: warningCode, severity: 'warning', recordId: `${source.id}/page:100`, requiresAcknowledgement: true }),
    ]);

    const applied = await request.post(`/api/migrations/previews/${preview.id}/apply`, { data: {
      expectedVersion: preview.version, acknowledgements: preview.requiredAcknowledgements,
    } });
    expect(applied.status(), await applied.text()).toBe(201);
    const { import: receipt } = await applied.json() as MigrationApplyResult;
    expect(receipt.projectIds).toHaveLength(1);
    const [projectId] = receipt.projectIds;
    const response = await request.get('/api/workspace');
    expect(response.ok(), await response.text()).toBe(true);
    imported = (await response.json() as WorkspaceSnapshot).documents.filter(document => document.projectId === projectId);
    const index = imported.find(document => document.title === indexTitle);
    const member = imported.find(document => document.title === memberTitle);
    expect(index).toBeDefined();
    expect(member?.labels).toEqual([label]);

    await page.setViewportSize({ width: 360, height: 820 });
    await page.goto(`/#/${projectId}/documents/${index!.id}`);
    const title = page.getByRole('textbox', { name: '문서 제목', exact: true });
    await expect(title).toHaveValue(indexTitle, { timeout: 35_000 });
    const editor = page.locator('.docs-prose[contenteditable=true]');
    const list = editor.getByRole('region', { name: '라벨별 문서 목록', exact: true });
    await expect(list).toHaveCount(1);
    await expect(list.getByRole('listitem')).toHaveCount(1);
    const row = list.getByRole('button', { name: `목록 문서 열기 ${memberTitle}`, exact: true });
    await expect(row).toBeVisible();
    await expect(row.getByText(label, { exact: true })).toBeVisible();
    await expect(row.getByText(projectName, { exact: true })).toBeVisible();
    const code = editor.locator('pre code');
    await expect(code).toBeVisible();
    await expect(code).toHaveText(original);
    await row.click();
    await expect(title).toHaveValue(memberTitle);
    await expect(editor.getByText('Confluence에서 이관한 운영 절차 본문', { exact: true })).toBeVisible();

    await page.goto(`/#/${projectId}/settings?section=migration`);
    const receipts = page.getByRole('region', { name: '완료한 이관 영수증', exact: true });
    await receipts.getByRole('button', { name: new RegExp(receipt.id, 'u') }).click();
    await receipts.getByText('검토한 이관 진단', { exact: true }).click();
    await expect(receipts.getByText(`경고 · ${warningCode}`, { exact: true })).toBeVisible();
    await expect(receipts.getByText(/원문 코드 블록으로 보존했습니다/u)).toBeVisible();
  } finally {
    for (const document of imported) {
      const removed = await request.delete(`/api/documents/${document.id}?expectedVersion=${document.version}`);
      expect(removed.ok(), await removed.text()).toBe(true);
      const { trashEntryId } = await removed.json() as { trashEntryId: string };
      const purged = await request.delete(`/api/trash/${trashEntryId}`);
      expect(purged.ok(), await purged.text()).toBe(true);
    }
    const deleted = await request.delete(`/api/legacy-import/packages/${source.id}?expectedVersion=${source.version}`);
    expect(deleted.ok(), await deleted.text()).toBe(true);
  }
});
