import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { isAbsolute } from 'node:path';
import type { Duplex } from 'node:stream';
import express, { type RequestHandler, type Response } from 'express';
import { renderPilotAccessPage } from './pilot-access-page.js';

const sessionCookie = '__Host-donefac-pilot';
const sessionSeconds = 12 * 60 * 60;
const accessPath = '/pilot-access';
const logoutPath = `${accessPath}/logout`;

type Session = { expiry: NodeJS.Timeout; sockets: Set<Duplex> };
export interface PilotAccess {
  origin: string;
  middleware: RequestHandler;
  authorizeUpgrade(request: IncomingMessage, socket: Duplex): { status: 401 | 403 | 421 } | null;
  close(): void;
}

function publicOrigin(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('DONEFAC_PILOT_ORIGIN에는 팀 접속 HTTPS 주소를 지정해 주세요.'); }
  if (!/^https:\/\//i.test(value) || url.protocol !== 'https:' || url.pathname !== '/' ||
      url.username || url.password || value.includes('?') || value.includes('#')) {
    throw new Error('DONEFAC_PILOT_ORIGIN에는 경로와 자격 증명이 없는 HTTPS 주소를 지정해 주세요.');
  }
  return url;
}

function readAccessCode(path: string): Buffer {
  const invalid = 'DONEFAC_PILOT_ACCESS_FILE에는 소유자만 읽을 수 있는 일반 파일의 절대 경로와 64자리 소문자 16진수 접속 키가 필요합니다.';
  if (!isAbsolute(path)) throw new Error(invalid);
  try {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size < 64 || metadata.size > 66) throw new Error(invalid);
      const bytes = Buffer.alloc(67);
      const length = readSync(descriptor, bytes);
      const value = bytes.subarray(0, length).toString('utf8');
      if (!/^[0-9a-f]{64}(?:\r?\n)?$/.test(value)) throw new Error(invalid);
      return Buffer.from(value.slice(0, 64), 'ascii');
    } finally { closeSync(descriptor); }
  } catch { throw new Error(invalid); }
}

function sessionId(request: IncomingMessage) {
  let token: string | undefined;
  for (const entry of (request.headers.cookie ?? '').split(';')) {
    const cookie = entry.trim();
    if (!cookie.startsWith(`${sessionCookie}=`)) continue;
    const value = cookie.slice(sessionCookie.length + 1);
    if (token !== undefined || !/^[A-Za-z0-9_-]{43}$/.test(value)) return undefined;
    token = value;
  }
  return token;
}

function sendAccessPage(response: Response, options: Parameters<typeof renderPilotAccessPage>[0], status = 200) {
  const { html, nonce } = renderPilotAccessPage(options);
  response.set({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
  }).status(status).type('html').send(html);
}

function returningTo(value: unknown) {
  return typeof value === 'string' && value.startsWith('#/') && value.length <= 1_024 && !/[\x00-\x1f\x7f]/.test(value) ? value : '';
}

function setSessionCookie(response: Response, token: string, maxAge: number) {
  response.append('Set-Cookie', `${sessionCookie}=${token}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`);
}

export function createPilotAccess(env: NodeJS.ProcessEnv = process.env): PilotAccess | null {
  const { DONEFAC_PILOT_ORIGIN: originSetting, DONEFAC_PILOT_ACCESS_FILE: accessPathSetting } = env;
  if (originSetting === undefined && accessPathSetting === undefined) return null;
  if (!originSetting || !accessPathSetting) throw new Error('팀 접속 모드에는 DONEFAC_PILOT_ORIGIN과 DONEFAC_PILOT_ACCESS_FILE이 함께 필요합니다.');
  const origin = publicOrigin(originSetting);
  const accessCode = readAccessCode(accessPathSetting);
  const sessions = new Map<string, Session>();
  const parseLogin = express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 2 });

  function endSession(token: string | undefined) {
    if (!token) return;
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token);
    clearTimeout(session.expiry);
    for (const socket of session.sockets) socket.destroy();
  }

  function isHost(request: IncomingMessage) {
    return request.headersDistinct.host?.length === 1 && request.headers.host?.toLowerCase() === origin.host.toLowerCase();
  }

  const middleware: RequestHandler = (request, response, next) => {
    if (!isHost(request)) {
      response.set('Cache-Control', 'no-store').status(421).json({error: '설정된 팀 접속 주소에서 열어 주세요.'});
      return;
    }
    const path = request.url.split('?')[0];
    // These two entry points verify their own credentials in the normal API.
    if (path === '/api/v1' || path.startsWith('/api/v1/') ||
        (path === '/api/integrations/gitlab/webhook' && request.method === 'POST')) {
      response.set('Cache-Control', 'no-store');
      next();
      return;
    }
    const token = sessionId(request);
    const authenticated = token !== undefined && sessions.has(token);
    const reading = request.method === 'GET' || request.method === 'HEAD';
    if (!reading && request.headers.origin !== origin.origin) {
      response.set('Cache-Control', 'no-store').status(403).json({error: '같은 팀 접속 주소에서 요청해 주세요.'});
      return;
    }
    if (reading && (path === accessPath || path === '/' && !authenticated)) {
      sendAccessPage(response, {authenticated});
      return;
    }
    if (request.method === 'POST' && path === accessPath) {
      parseLogin(request, response, error => {
        const fragment = returningTo(request.body?.returnFragment);
        if (error || !request.is('application/x-www-form-urlencoded')) {
          sendAccessPage(response, {authenticated: false, error: '접속 키 입력을 확인해 주세요.', returnFragment: fragment}, 400);
          return;
        }
        const candidate = request.body?.accessCode;
        if (typeof candidate !== 'string' || !/^[0-9a-f]{64}$/.test(candidate) || !timingSafeEqual(Buffer.from(candidate, 'ascii'), accessCode)) {
          sendAccessPage(response, {authenticated: false, error: '팀 접속 키를 다시 확인해 주세요.', returnFragment: fragment}, 401);
          return;
        }
        endSession(token);
        const sessionToken = randomBytes(32).toString('base64url');
        const expiry = setTimeout(() => endSession(sessionToken), sessionSeconds * 1_000).unref();
        sessions.set(sessionToken, {expiry, sockets: new Set()});
        setSessionCookie(response, sessionToken, sessionSeconds);
        response.set('Cache-Control', 'no-store').redirect(303, `/${fragment}`);
      });
      return;
    }
    if (request.method === 'POST' && path === logoutPath) {
      endSession(token);
      setSessionCookie(response, '', 0);
      response.set('Cache-Control', 'no-store').redirect(303, accessPath);
      return;
    }
    if (!authenticated) {
      response.set('Cache-Control', 'no-store').status(401).json({
        error: '팀 접속이 필요합니다. 새 탭에서 /pilot-access를 열어 접속한 뒤 다시 시도해 주세요.',
        code: 'PILOT_ACCESS_REQUIRED',
      });
      return;
    }
    response.set('Cache-Control', 'no-store');
    next();
  };

  return {
    origin: origin.origin,
    middleware,
    authorizeUpgrade(request, socket) {
      if (!isHost(request)) return {status: 421};
      if (request.headers.origin !== origin.origin) return {status: 403};
      const token = sessionId(request);
      const session = token && sessions.get(token);
      if (!session) return {status: 401};
      session.sockets.add(socket);
      socket.once('close', () => session.sockets.delete(socket));
      return null;
    },
    close() { for (const token of sessions.keys()) endSession(token); },
  };
}
