import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/src/lib/utils';

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-2xs font-medium [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-layer-1 text-fg-secondary',
        brand: 'border-transparent bg-brand-subtle text-brand-fg',
        success: 'border-transparent bg-success-subtle text-success-fg',
        warning: 'border-transparent bg-warning-subtle text-warning-fg',
        danger: 'border-transparent bg-danger-subtle text-danger-fg',
        info: 'border-transparent bg-info-subtle text-info-fg',
        outline: 'border-border-default text-fg-secondary',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

function Badge({ className, variant, asChild = false, ...props }:
  React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span';
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props}/>;
}

export { Badge, badgeVariants };
