export type SettingsSectionId = 'general' | 'work' | 'calendar' | 'integrations' | 'migration' | 'data';

export const SETTINGS_SECTIONS: readonly { id: SettingsSectionId; label: string }[] = [
  { id: 'general', label: '일반' },
  { id: 'work', label: '업무 구성' },
  { id: 'calendar', label: '업무 달력' },
  { id: 'integrations', label: 'API 키' },
  { id: 'migration', label: '이관' },
  { id: 'data', label: '데이터' },
];

export function readSettingsSection(value: string | null): SettingsSectionId {
  return SETTINGS_SECTIONS.find(section => section.id === value)?.id ?? 'general';
}
