import { createDecipheriv } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const CREDENTIAL_KEY_FILE = '.credential-key';
const KEY_BYTES = 32;

/** @param {string} dataDirectory */
export function readWorkspaceCredentialKey(dataDirectory) {
  let fd;
  try {
    fd = openSync(join(dataDirectory, CREDENTIAL_KEY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error('.credential-key 파일을 읽을 수 없습니다.');
  }
  try {
    const stat = fstatSync(fd);
    const invalidKey = '32바이트 일반 .credential-key 파일이 필요합니다.';
    if (!stat.isFile() || stat.size !== KEY_BYTES) throw new Error(invalidKey);
    const key = Buffer.alloc(KEY_BYTES + 1);
    let size = 0;
    while (size < key.length) {
      const read = readSync(fd, key, size, key.length - size, size);
      if (!read) break;
      size += read;
    }
    if (size !== KEY_BYTES) throw new Error(invalidKey);
    return key.subarray(0, KEY_BYTES);
  } finally {
    closeSync(fd);
  }
}

/** @param {Buffer} key @param {string} value */
export function decryptWorkspaceCredential(key, value) {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('암호화된 자격 증명의 형식이 올바르지 않습니다.');
  const [iv, tag, content] = parts.map(part => Buffer.from(part, 'base64'));
  if (iv.length !== 12) throw new Error('암호화된 자격 증명의 형식이 올바르지 않습니다.');
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(content), decipher.final()]);
}

/** @param {import('node:sqlite').DatabaseSync} db @param {Buffer | null} key */
export function assertWorkspaceCredentials(db, key) {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");

  /** @param {unknown} value */
  function assertCredential(value) {
    if (!key) throw new Error('저장된 자격 증명에 원본 .credential-key 파일이 필요합니다. 데이터베이스와 함께 복원해 주세요.');
    try {
      if (typeof value !== 'string') throw new Error();
      decryptWorkspaceCredential(key, value);
    } catch {
      throw new Error('.credential-key로 저장된 자격 증명을 확인할 수 없습니다. 데이터베이스와 같은 사본의 키를 사용해 주세요.');
    }
  }

  if (table.get('settings')) {
    const row = db.prepare("SELECT value FROM settings WHERE key='gitlab'").get();
    if (row) {
      let gitlab;
      try { gitlab = JSON.parse(String(row.value)); }
      catch { throw new Error('SQLite의 GitLab 설정 형식이 올바르지 않습니다.'); }
      for (const field of ['token', 'webhookSecret', 'signingToken']) {
        const value = gitlab?.[field];
        if (typeof value === 'string' && value) assertCredential(value);
      }
    }
  }
  if (table.get('webhook_endpoints')) {
    for (const row of db.prepare('SELECT secret FROM webhook_endpoints').iterate()) assertCredential(row.secret);
  }
}
