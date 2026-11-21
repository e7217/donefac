import { isCalendarDate } from '../../shared/calendar';
import { hasCustomValue } from '../../shared/issue-schema';
import type { CustomFieldDefinition, CustomFieldValue, User } from '../../shared/types';

export function isAvailableTemplateFieldValue(field: CustomFieldDefinition, value: CustomFieldValue, users: User[]): boolean {
  if (!hasCustomValue(value)) return true;
  const activeOption = (id: string) => field.options.some(option => option.id === id && !option.archived);
  switch (field.kind) {
    case 'select': return typeof value === 'string' && activeOption(value);
    case 'multi_select': return Array.isArray(value) && value.every(activeOption) && new Set(value).size === value.length;
    case 'user': return users.some(user => user.id === value);
    case 'checkbox': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'date': return isCalendarDate(value);
    case 'text': return typeof value === 'string' && value.length <= 20_000;
    case 'url': {
      if (typeof value !== 'string' || value.length > 4_000) return false;
      try {
        const url = new URL(value.trim());
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
      } catch { return false; }
    }
  }
}
