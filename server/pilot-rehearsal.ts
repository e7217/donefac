import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export const PILOT_REHEARSAL_DIRECTORY = '.donefac-rehearsal';

export function assertPilotRehearsalWorkspace(dataDir: string, migrationRehearsal: boolean) {
  if (!migrationRehearsal && lstatSync(join(dataDir, PILOT_REHEARSAL_DIRECTORY), { throwIfNoEntry: false })) {
    throw new Error('이관 리허설 워크스페이스는 pilot:rehearsal review 명령으로 열어 주세요.');
  }
}
