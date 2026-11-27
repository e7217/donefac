import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { expect, test, type Page } from '@playwright/test';
import type { Editor } from '@tiptap/core';
import WebSocket, { type RawData } from 'ws';
import * as Y from 'yjs';
import { COLLABORATION_SCHEMA, type CollaborationSession, type CollaborationServerMessage } from '../../shared/collaboration';
import { collaborationBlockId, COLLABORATION_BLOCK_ORDER_ROOT, MAX_COLLABORATION_BLOCK_MOVES } from '../../shared/collaboration-block-order';
import type { DocPage, WorkspaceSnapshot } from '../../shared/types';

test('공동 편집의 이동한 블록을 지웠다가 복구하면 두 사용자가 같은 순서를 본다', async ({ page, request, browser, baseURL }) => {
  const workspace = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const project = workspace.projects[0];
  const leading = '처음 문단', moved = '움직일 문단', tail = '마지막 문단', inserted = '새 문단';
  const response = await request.post('/api/documents', { data: {
    projectId: project.id, title: `공동 편집 순서 복원 ${randomUUID()}`,
    content: { type: 'doc', content: [leading, moved, tail].map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) },
  } });
  expect(response.status(), await response.text()).toBe(201);
  const document = await response.json() as DocPage;
  const peerContext = await browser.newContext({ baseURL, viewport: { width: 360, height: 820 } });
  try {
    const enabled = await request.post(`/api/documents/${document.id}/collaboration/enable`, { data: { expectedVersion: document.version } });
    expect(enabled.status(), await enabled.text()).toBe(200);
    await page.addInitScript(actor => localStorage.setItem('donefac.actor', actor), workspace.users[0].id);
    await peerContext.addInitScript(actor => localStorage.setItem('donefac.actor', actor), workspace.users[1].id);
    const peer = await peerContext.newPage();
    const route = `/#/${project.id}/documents/${document.id}`;
    await page.setViewportSize({ width: 360, height: 820 });
    await Promise.all([page.goto(route), peer.goto(route)]);
    const body = (tab: Page) => tab.locator('.docs-live-prose');
    const order = (tab: Page) => tab.locator('.docs-live-prose > p').allTextContents();
    const sync = (tab: Page) => tab.locator('.docs-collaboration-state');
    await expect(sync(page)).toHaveText('서버에 동기화됨');
    await expect(sync(peer)).toHaveText('서버에 동기화됨');
    await body(page).getByText(moved, { exact: true }).click();
    await page.getByRole('button', { name: '블록 위로 이동', exact: true }).press('Enter');
    await expect.poll(() => order(peer)).toEqual([moved, leading, tail]);

    // Use the editor's actual split command so the projected root receives a normal structural edit.
    await body(page).evaluate((element, text) => {
      const editor = (element as HTMLElement & { editor?: Editor }).editor!;
      const end = editor.state.doc.firstChild!.nodeSize - 1;
      editor.chain().focus().setTextSelection(end).splitBlock().insertContent(text).run();
    }, inserted);
    await expect.poll(() => order(peer)).toEqual([moved, inserted, leading, tail]);
    await expect(sync(page)).toHaveText('서버에 동기화됨');

    // Split the native Yjs typing history from the upcoming structural deletion.
    await page.waitForTimeout(550);
    await body(page).evaluate(element => {
      const editor = (element as HTMLElement & { editor?: Editor }).editor!;
      editor.commands.deleteRange({ from: 0, to: editor.state.doc.firstChild!.nodeSize });
    });
    const removed = [inserted, leading, tail];
    await expect.poll(() => order(peer)).toEqual(removed);
    const toolbar = page.getByRole('toolbar', { name: '문서 서식' });
    await toolbar.getByRole('button', { name: '실행 취소', exact: true }).press('Enter');
    const restored = [moved, inserted, leading, tail];
    await expect.poll(() => order(page)).toEqual(restored);
    await expect.poll(() => order(peer)).toEqual(restored);
    await expect(sync(page)).toHaveText('서버에 동기화됨');
    await peer.reload();
    await expect.poll(() => order(peer)).toEqual(restored);
    await toolbar.getByRole('button', { name: '다시 실행', exact: true }).press('Enter');
    await expect.poll(() => order(peer)).toEqual(removed);
  } finally {
    await peerContext.close();
    const removed = await request.delete(`/api/documents/${document.id}`);
    if (removed.ok()) {
      const trash = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trash.trashEntryId}`);
    }
  }
});

test('공동 편집의 이동 기록이 가득 차면 새 블록 입력을 건너뛰고 기존 문단의 입력을 이어간다', async ({ page, request, baseURL }) => {
  const { projects: [project], users: [actor] } = await (await request.get('/api/workspace')).json() as WorkspaceSnapshot;
  const response = await request.post('/api/documents', { data: {
    projectId: project.id, title: `공동 편집 순서 한도 ${randomUUID()}`,
    content: { type: 'doc', content: ['원래 첫 문단', '옮긴 문단'].map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) },
  } });
  expect(response.status(), await response.text()).toBe(201);
  const document = await response.json() as DocPage;
  const local = new Y.Doc();
  let socket: WebSocket | undefined;
  try {
    const enabled = await request.post(`/api/documents/${document.id}/collaboration/enable`, { data: { expectedVersion: document.version } });
    expect(enabled.status()).toBe(200);
    const { epoch } = await enabled.json() as CollaborationSession;
    const endpoint = new URL('/api/collaboration', baseURL);
    endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    endpoint.search = new URLSearchParams({ documentId: document.id, actorId: actor.id }).toString();
    socket = new WebSocket(endpoint);
    await once(socket, 'open');
    const next = (type: CollaborationServerMessage['type']) => new Promise<CollaborationServerMessage>(resolve => {
      const receive = (raw: RawData) => {
        const message = JSON.parse(raw.toString()) as CollaborationServerMessage;
        if (message.type !== type && message.type !== 'error') return;
        socket!.off('message', receive);
        resolve(message);
      };
      socket!.on('message', receive);
    });
    const welcomeMessage = next('welcome');
    socket.send(JSON.stringify({ type: 'hello', schemaVersion: COLLABORATION_SCHEMA, epoch }));
    const welcome = await welcomeMessage;
    expect(welcome.type).toBe('welcome');
    if (welcome.type !== 'welcome') throw new Error('공동 편집 상태 확인에 실패했습니다.');
    Y.applyUpdate(local, Buffer.from(welcome.update, 'base64'));
    const [first, second] = local.getXmlFragment('default').toArray().map(collaborationBlockId);
    expect(first && second).toBeTruthy();
    const vector = Y.encodeStateVector(local);
    local.getArray(COLLABORATION_BLOCK_ORDER_ROOT).push(Array.from({ length: MAX_COLLABORATION_BLOCK_MOVES }, () => [second, 'before', first, null]));
    const receipt = next('ack');
    socket.send(JSON.stringify({ type: 'update', requestId: randomUUID(), epoch, update: Buffer.from(Y.encodeStateAsUpdate(local, vector)).toString('base64') }));
    expect((await receipt).type).toBe('ack');
    socket.terminate();

    await page.addInitScript(id => localStorage.setItem('donefac.actor', id), actor.id);
    await page.goto(`/#/${project.id}/documents/${document.id}`);
    const body = page.locator('.docs-live-prose');
    const blocks = body.locator(':scope > p');
    const sync = page.locator('.docs-collaboration-state');
    await expect(sync).toHaveText('서버에 동기화됨');
    await expect(blocks).toHaveText(['옮긴 문단', '원래 첫 문단']);
    await body.evaluate(element => {
      const editor = (element as HTMLElement & { editor?: Editor }).editor!;
      editor.chain().focus().setTextSelection(editor.state.doc.firstChild!.nodeSize - 1).splitBlock().run();
    });
    const moveControls = page.getByRole('group', { name: '본문 블록 순서', exact: true });
    await expect(moveControls.getByRole('button', { name: '블록 아래로 이동', exact: true })).toBeDisabled();
    await expect(moveControls.getByText('이 문서의 블록 이동 기록이 한도에 도달했습니다.', { exact: true })).toBeVisible();
    await expect(blocks).toHaveText(['옮긴 문단', '원래 첫 문단']);
    await body.evaluate(element => {
      const editor = (element as HTMLElement & { editor?: Editor }).editor!;
      editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 1);
    });
    await page.keyboard.insertText('의 입력');
    await expect(blocks).toHaveText(['옮긴 문단의 입력', '원래 첫 문단']);
    await expect(sync).toHaveText('서버에 동기화됨');
    await page.reload();
    await expect(blocks).toHaveText(['옮긴 문단의 입력', '원래 첫 문단']);
  } finally {
    socket?.terminate();
    local.destroy();
    const removed = await request.delete(`/api/documents/${document.id}`);
    if (removed.ok()) {
      const trash = await removed.json() as { trashEntryId: string };
      await request.delete(`/api/trash/${trash.trashEntryId}`);
    }
  }
});
