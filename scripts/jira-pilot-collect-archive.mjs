import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs';
import { chmod, link, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { MAX_FILE_BYTES } from '../server/attachments.ts';
import { LEGACY_MAX_EXPANDED_BYTES, LEGACY_MAX_FILES, LEGACY_MAX_FILE_BYTES, LEGACY_MAX_RAW_BYTES } from '../server/legacy-import-archive.ts';

const idPattern = /^[1-9]\d*$/u;
const pathPart = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const unsupportedPathCharacter = /[\\\x00-\x1f\x7f]/u;

function parseAttachmentId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && idPattern.test(value) ? value : null;
}

export function jiraCollectAttachmentUrl(value, baseUrl, id) {
  const attachmentId = parseAttachmentId(id);
  if (!attachmentId || typeof value !== 'string' || value !== value.trim() || !value ||
      value.includes('?') || value.includes('#') || unsupportedPathCharacter.test(value)) return null;

  try {
    const base = new URL(baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    const context = base.pathname.replace(/\/+$/u, '');
    const url = new URL(value, new URL(`${context}/`, base));
    if (url.origin !== base.origin || url.username || url.password || !url.pathname.startsWith(`${context}/`)) return null;

    const path = url.pathname.slice(context.length + 1);
    if (new RegExp(`^rest/api/(?:2|3|latest)/attachment/content/${attachmentId}$`, 'u').test(path)) return url;

    const name = new RegExp(`^secure/attachment/${attachmentId}/([^/]+)$`, 'u').exec(path)?.[1];
    if (!name) return null;
    const decoded = decodeURIComponent(name);
    if (!decoded || decoded === '.' || decoded === '..' || decoded.includes('/') || unsupportedPathCharacter.test(decoded)) return null;
    return url;
  } catch {
    return null;
  }
}

function outputExists() {
  return new Error('수집 ZIP 경로에 파일 또는 디렉터리가 이미 있습니다.');
}

export async function createJiraPilotArchive(outputPath) {
  const absolute = resolve(outputPath);
  const parent = await realpath(dirname(absolute));
  const destination = join(parent, basename(absolute));
  const existing = await lstat(destination).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) throw outputExists();

  const staging = await mkdtemp(join(parent, '.jira-pilot-'));
  const files = new Map();
  const directories = new Set();
  let expandedBytes = 0;
  let publication;
  let closing;

  function addFile(name, bytes) {
    if (publication || closing) throw new Error('완료된 Jira 수집 ZIP에는 항목을 추가할 수 없습니다.');
    const path = typeof name === 'string' ? name.split('/') : [];
    if (!path.length || name.length > 1024 || path.some(part => !pathPart.test(part))) {
      throw new Error('Jira 수집 ZIP 항목의 경로가 올바르지 않습니다.');
    }
    const key = name.toLowerCase();
    const parents = path.slice(0, -1).map((_, index) => path.slice(0, index + 1).join('/').toLowerCase());
    if (files.has(key) || directories.has(key) || parents.some(parent => files.has(parent))) {
      throw new Error('Jira 수집 ZIP에 겹치는 항목 경로가 있습니다.');
    }
    if (files.size >= LEGACY_MAX_FILES || bytes.length > LEGACY_MAX_FILE_BYTES || expandedBytes + bytes.length > LEGACY_MAX_EXPANDED_BYTES) {
      throw new Error('Jira 수집 ZIP이 5,000개 항목·개별 64 MiB·압축 해제 합계 256 MiB 제한을 초과했습니다.');
    }
    const stagedFile = join(staging, `entry-${files.size}`);
    writeFileSync(stagedFile, bytes, { flag: 'wx', mode: 0o600 });
    files.set(key, { name, path: stagedFile, size: bytes.length });
    for (const parent of parents) directories.add(parent);
    expandedBytes += bytes.length;
  }

  async function writeArchive(signal) {
    signal?.throwIfAborted();
    if (!files.size) throw new Error('Jira 수집 ZIP에 저장할 항목이 없습니다.');
    const archive = join(staging, 'package.zip');
    const zip = new yazl.ZipFile();
    const inputs = new Set();
    const digest = createHash('sha256');
    let bytes = 0;
    const measure = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > LEGACY_MAX_RAW_BYTES) {
          done(new Error('Jira 수집 ZIP은 64 MiB 이하여야 합니다. 수집 범위를 나누어 주세요.'));
          return;
        }
        digest.update(chunk);
        done(null, chunk);
      },
    });

    zip.on('error', error => zip.outputStream.destroy(error));
    try {
      for (const file of files.values()) {
        zip.addReadStreamLazy(file.name, { size: file.size, mode: 0o100600 }, callback => {
          const input = createReadStream(file.path);
          inputs.add(input);
          input.once('close', () => inputs.delete(input));
          callback(null, input);
        });
      }
      await Promise.all([
        pipeline(zip.outputStream, measure, createWriteStream(archive, { flags: 'wx', mode: 0o600, flush: true }), { signal }),
        Promise.resolve().then(() => zip.end()),
      ]);
    } finally {
      for (const input of inputs) input.destroy();
      zip.outputStream.destroy();
    }
    await chmod(archive, 0o600);
    const sha256 = digest.digest('hex');
    signal?.throwIfAborted();
    try { await link(archive, destination); }
    catch (error) {
      if (error.code === 'EEXIST') throw outputExists();
      throw error;
    }
    return { bytes, sha256 };
  }

  return {
    addJson(name, value) {
      if (typeof name !== 'string' || !name.endsWith('.json')) throw new Error('Jira JSON 항목에는 .json 파일 이름이 필요합니다.');
      const json = JSON.stringify(value);
      if (typeof json !== 'string') throw new Error('Jira 수집 JSON 응답이 비어 있습니다.');
      addFile(name, Buffer.from(json));
    },
    addAttachment(id, bytes) {
      const attachmentId = parseAttachmentId(id);
      if (!attachmentId || !Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) {
        throw new Error('Jira 첨부파일 ID와 크기를 확인해 주세요. 첨부파일은 20 MiB 이하여야 합니다.');
      }
      addFile(`attachments/${attachmentId}`, bytes);
    },
    async publish(signal) {
      if (closing) throw new Error('종료된 Jira 수집 ZIP은 게시할 수 없습니다.');
      publication ??= writeArchive(signal);
      return publication;
    },
    async close() {
      closing ??= (async () => {
        await publication?.catch(() => {});
        await rm(staging, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}
