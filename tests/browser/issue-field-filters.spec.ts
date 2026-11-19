import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { CustomFieldDefinition, Issue, Project, ProjectIssueSchema, SavedView } from '../../shared/types';

test('형식별 필터의 0과 false 조건을 공유 보기에 저장하고 스키마 이름 변경 뒤에도 다시 연다', async ({page,request}) => {
  const key = `FT${randomUUID().replaceAll('-', '').slice(0,8).toUpperCase()}`;
  const response = await request.post('/api/projects',{data:{key,name:`필터 검증 ${key}`}});
  expect(response.ok()).toBeTruthy();
  const project = (await response.json()) as Project;
  const schemaPath = `/api/projects/${project.id}/issue-schema`;
  const original = (await (await request.get(schemaPath)).json()) as ProjectIssueSchema;
  const fields: CustomFieldDefinition[] = [
    {id:'metric',name:'검증 점수',description:'',kind:'number',required:false,issueTypes:[],options:[],archived:false},
    {id:'approved',name:'검토 완료',description:'',kind:'checkbox',required:false,issueTypes:[],options:[],archived:false},
  ];
  const schemaResponse = await request.patch(schemaPath,{
    data:{expectedVersion:original.version,issueTypes:original.issueTypes,fields},
  });
  expect(schemaResponse.ok(),await schemaResponse.text()).toBeTruthy();
  const schema = (await schemaResponse.json()) as ProjectIssueSchema;
  const created: Issue[] = [];
  const views: SavedView[] = [];
  const zeroTitle = `영점과 미완료 ${key}`;
  const positiveTitle = `양수와 완료 ${key}`;
  const noneTitle = `필드가 없는 업무 ${key}`;
  try {
    for (const [title,customFields] of [
      [zeroTitle,{metric:0,approved:false}],
      [positiveTitle,{metric:5,approved:true}],
      [noneTitle,{}],
    ] as const) {
      const result = await request.post('/api/issues',{data:{projectId:project.id,title,customFields}});
      expect(result.ok(),await result.text()).toBeTruthy();
      created.push(await result.json() as Issue);
    }
    const legacy = await request.post('/api/views',{
      data:{projectId:project.id,name:'프로젝트 전체',layout:'list',filters:{query:'',status:'all',assigneeId:'all',type:'all'}},
    });
    expect(legacy.ok()).toBeTruthy();
    const all = await legacy.json() as SavedView;
    views.push(all);

    await page.setViewportSize({width:360,height:820});
    await page.goto(`/#/${project.id}/issues`);
    const filter = page.getByRole('region',{name:'사용자 정의 필드 필터',exact:true});
    const edit = filter.getByRole('button',{name:'사용자 정의 필드 필터 편집',exact:true});
    const editor = filter.getByRole('form',{name:'사용자 정의 필드 필터 편집기',exact:true});
    const add = editor.getByRole('button',{name:'필드 필터 조건 추가',exact:true});
    const apply = editor.getByRole('button',{name:'필드 필터 적용',exact:true});
    await edit.click();
    await add.click();
    const bounds = await editor.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(360);
    await editor.getByLabel('필터 조건 1 필드',{exact:true}).selectOption('metric');
    await editor.getByLabel('필터 조건 1 비교',{exact:true}).selectOption('equals');
    await editor.getByLabel('필터 조건 1 값',{exact:true}).fill('0');
    await add.click();
    await editor.getByLabel('필터 조건 2 필드',{exact:true}).selectOption('approved');
    await editor.getByLabel('필터 조건 2 비교',{exact:true}).selectOption('equals');
    await editor.getByLabel('필터 조건 2 값',{exact:true}).selectOption('false');
    await apply.click();
    const issueList = page.locator('.issue-table');
    await expect(issueList.getByText(zeroTitle,{exact:true})).toBeVisible();
    await expect(issueList.getByText(positiveTitle,{exact:true})).toHaveCount(0);
    await expect(issueList.getByText(noneTitle,{exact:true})).toHaveCount(0);

    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('button',{name:'보드',exact:true}).click();
    await page.getByRole('button',{name:'현재 보기 저장',exact:true}).click();
    const dialog = page.getByRole('dialog',{name:'업무 보기 저장',exact:true});
    await dialog.getByLabel('보기 이름',{exact:true}).fill('영점 미완료');
    const savedResponse = page.waitForResponse(result=>result.url().endsWith('/api/views') && result.request().method()==='POST');
    await dialog.getByRole('button',{name:'저장',exact:true}).click();
    const saved = await (await savedResponse).json() as SavedView;
    views.push(saved);
    expect(saved.filters.fieldFilter).toEqual({match:'all',rules:[
      {fieldId:'metric',operator:'equals',value:0},
      {fieldId:'approved',operator:'equals',value:false},
    ]});
    await expect(dialog).toBeHidden();

    await edit.click();
    await editor.getByLabel('필드 필터 일치 방식',{exact:true}).selectOption('any');
    await editor.getByLabel('필터 조건 1 값',{exact:true}).fill('5');
    const picker = page.getByLabel('저장된 업무 보기',{exact:true});
    page.once('dialog',popup=>void popup.dismiss());
    await picker.selectOption(all.id);
    await expect(picker).toHaveValue(saved.id);
    await expect(editor.getByLabel('필터 조건 1 값',{exact:true})).toHaveValue('5');
    await expect(page.locator('.issue-board-card').getByText(positiveTitle,{exact:true})).toHaveCount(0);
    await apply.click();
    await expect(page.locator('.issue-board-card').getByText(positiveTitle,{exact:true})).toBeVisible();
    await expect(page.locator('.issue-board-card').getByText(zeroTitle,{exact:true})).toBeVisible();

    const renamed = await request.patch(schemaPath,{
      data:{expectedVersion:schema.version,issueTypes:schema.issueTypes,
        fields:fields.map(field=>field.id==='metric'?{...field,name:'이름 바꾼 점수',archived:true}:field)},
    });
    expect(renamed.ok(),await renamed.text()).toBeTruthy();
    await page.reload();
    await picker.selectOption(saved.id);
    await expect(page.locator('.issue-board-card').getByText(zeroTitle,{exact:true})).toBeVisible();
    await expect(page.locator('.issue-board-card').getByText(positiveTitle,{exact:true})).toHaveCount(0);
    await edit.click();
    await expect(editor.getByLabel('필터 조건 1 필드',{exact:true}).locator('option:checked')).toHaveText('이름 바꾼 점수 · 보관됨');
    await editor.getByRole('button',{name:'필터 조건 2 삭제',exact:true}).click();
    await editor.getByRole('button',{name:'필터 조건 1 삭제',exact:true}).click();
    await apply.click();
    await expect(page.locator('.issue-board-card').getByText(noneTitle,{exact:true})).toBeVisible();
  } finally {
    for (const view of views) await request.delete(`/api/views/${view.id}?expectedVersion=${view.version}`);
    for (const issue of created) await request.delete(`/api/issues/${issue.id}`);
  }
});
