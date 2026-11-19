import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { calendarDate, calendarDay, createCalendarMath, defaultWorkCalendar } from '../../shared/calendar';
import type { Issue, ProjectWorkloadCapacity, ProjectWorkloadResult, WorkspaceSnapshot } from '../../shared/types';

const capacityDraft = ({ defaultDailyMinutes, members, exceptions }: ProjectWorkloadCapacity) => ({ defaultDailyMinutes, members, exceptions });

test('간트에서 계획 시간을 편집하고 가용 시간을 저장한 뒤 일정 미리보기와 적용 결과를 비교한다', async ({ page, request: requests }) => {
  const initial = await (await requests.get('/api/workspace')).json() as WorkspaceSnapshot;
  const projectId = initial.projects[0].id;
  const assignee = initial.users[0];
  const path = `/api/projects/${projectId}/workload-capacity`;
  const capacity = async () => {
    const response = await requests.get(path);
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json() as Promise<ProjectWorkloadCapacity>;
  };
  const originalCapacity = await capacity();
  const math = createCalendarMath(initial.calendars?.find(calendar => calendar.projectId === projectId) ?? defaultWorkCalendar(projectId));
  const nextWeek = calendarDay(new Date().toISOString().slice(0, 10)) + 7;
  const datePair = Array.from({length:56}, (_, index) => nextWeek + index).find(day => math.isWorking(calendarDate(day)) && math.isWorking(calendarDate(day + 1)));
  expect(datePair).toBeDefined();
  const start = calendarDate(datePair!);
  const end = calendarDate(datePair! + 1);
  const title = `작업량 브라우저 검증 ${randomUUID()}`;
  let issue: Issue | undefined;

  try {
    const response = await requests.post('/api/issues', { data:{projectId,title,assigneeId:assignee.id,startDate:start,endDate:start,estimate:8} });
    expect(response.status(), await response.text()).toBe(201);
    issue = await response.json() as Issue;
    const issueId = issue.id;
    await page.goto(`/#/${projectId}/gantt`);
    await page.getByRole('button', { name:'담당자 작업량', exact:true }).click();
    const workload = page.getByRole('region', { name:'담당자별 업무량', exact:true });
    await expect(workload).toBeVisible();
    await workload.getByLabel('업무량 시작일', {exact:true}).fill(start);

    await workload.getByRole('button', { name:new RegExp(title) }).click();
    const details = page.getByRole('dialog', { name:title, exact:true });
    await expect(details).toBeVisible();
    const minutes = details.getByLabel('계획 작업 시간 (분)', {exact:true});
    await expect(minutes).toHaveValue('');
    await expect(details.getByLabel('예상 소요 (포인트)', {exact:true})).toHaveValue('8');
    await minutes.fill('150');
    const issueSaved = page.waitForResponse(value => value.request().method() === 'PATCH' && new URL(value.url()).pathname === `/api/issues/${issueId}`);
    await details.getByRole('button', { name:'변경사항 저장',exact:true }).click();
    const savedResponse = await issueSaved;
    expect(savedResponse.status(), await savedResponse.text()).toBe(200);
    const saved = await savedResponse.json() as Issue;
    expect({effort:saved.plannedEffortMinutes,points:saved.estimate}).toEqual({effort:150,points:8});
    await details.getByRole('button', { name:'업무 상세 닫기',exact:true }).click();
    await expect(details).toHaveCount(0);

    await workload.getByRole('button', {name:'가용 시간 설정',exact:true}).click();
    await workload.getByLabel('기본 일일 가용 시간 (분)', {exact:true}).fill('100');
    const capacitySaved = page.waitForResponse(value => value.request().method() === 'PATCH' && new URL(value.url()).pathname === path);
    await workload.getByRole('button', {name:'가용 시간 저장',exact:true}).click();
    const capacityResponse = await capacitySaved;
    expect(capacityResponse.status(), await capacityResponse.text()).toBe(200);
    await expect.poll(async () => (await capacity()).defaultDailyMinutes).toBe(100);

    const firstDay = workload.getByRole('button', {name:`${start} ${assignee.name} 업무량`,exact:true});
    await expect(firstDay).toBeVisible();
    await expect(firstDay).toHaveAttribute('data-scheduled-minutes','150');
    await expect(firstDay).toHaveAttribute('data-available-minutes','100');
    await firstDay.click();
    await expect(workload.getByRole('heading', {name:`${assignee.name} · ${start}`,exact:true})).toBeVisible();
    await expect(workload.getByRole('button', {name:new RegExp(title)})).toBeVisible();

    const range = `/api/projects/${projectId}/workload?startDate=${start}&endDate=${end}`;
    const allotted = async () => {
      const response = await requests.get(range);
      expect(response.ok(), await response.text()).toBeTruthy();
      const result = await response.json() as ProjectWorkloadResult;
      return result.rows.find(row => row.userId === assignee.id)!.days
        .map(day => day.allocations.find(allocation => allocation.issueId === issueId)?.minutes ?? 0);
    };
    await expect.poll(allotted).toEqual([150,0]);

    await page.getByRole('button', {name:`${issue.key} 종료일 조정`,exact:true}).press('ArrowRight');
    const preview = page.getByRole('dialog', {name:'일정 변경 미리보기',exact:true});
    await expect(preview).toBeVisible();
    const comparison = preview.getByRole('region', {name:'일정 미리보기 업무량 비교',exact:true});
    await expect(comparison).toBeVisible();
    await expect(comparison).toContainText('초과 1 → 0 담당자·일');
    expect(await allotted()).toEqual([150,0]);
    await preview.getByRole('button', {name:'변경 적용',exact:true}).click();
    await expect.poll(allotted).toEqual([75,75]);
    await expect(preview).toHaveCount(0);
    await expect(page.getByLabel(`${issue.key} 종료일`, {exact:true})).toHaveValue(end);
    await expect(firstDay).toHaveAttribute('data-scheduled-minutes','75');
    await expect(workload.getByRole('button', {name:`${end} ${assignee.name} 업무량`,exact:true})).toHaveAttribute('data-scheduled-minutes','75');
    const breakdown = workload.getByRole('region', {name:'날짜별 업무 배분',exact:true});
    if (!(await breakdown.isVisible())) await firstDay.click();
    await expect(breakdown.getByRole('listitem').filter({hasText:title})).toContainText(/75분|1시간\s*15분/);
  } finally {
    try {
      if (issue) {
        const response = await requests.delete(`/api/issues/${issue.id}`);
        expect([200,404]).toContain(response.status());
        if (response.ok()) {
          const removed = await response.json() as {trashEntryId:string};
          expect((await requests.delete(`/api/trash/${removed.trashEntryId}`)).ok()).toBeTruthy();
        }
      }
    } finally {
      const current = await capacity();
      if (JSON.stringify(capacityDraft(current)) !== JSON.stringify(capacityDraft(originalCapacity))) {
        const restored = await requests.patch(path, {data:{...capacityDraft(originalCapacity),expectedVersion:current.version}});
        expect(restored.ok(), await restored.text()).toBeTruthy();
      }
    }
  }
});
