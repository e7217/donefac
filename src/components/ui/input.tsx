import * as React from 'react';
import { cn } from '@/src/lib/utils';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(
    'h-8 w-full min-w-0 rounded-md border border-input bg-surface-1 px-2.5 text-sm text-fg-primary outline-none transition-colors placeholder:text-fg-placeholder',
    'focus-visible:border-brand focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-55',
    'aria-invalid:border-danger aria-invalid:ring-danger/20',
    className)} {...props}/>;
}

export { Input };
