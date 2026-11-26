import * as React from 'react';
import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/src/lib/utils';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-brand-hover',
        destructive: 'bg-destructive text-fg-on-color hover:bg-danger-hover',
        outline: 'border border-input bg-surface-1 text-fg-primary hover:bg-layer-1-hover hover:border-border-strong',
        secondary: 'bg-brand-subtle text-brand-fg hover:bg-brand-subtle-hover',
        ghost: 'text-fg-secondary hover:bg-layer-1-hover hover:text-fg-primary',
        link: 'text-brand-fg underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-8 px-3 text-sm',
        sm: 'h-7 gap-1 px-2.5 text-xs',
        lg: 'h-9 px-4 text-base',
        icon: 'size-8',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

function Button({ className, variant, size, asChild = false, ...props }:
  React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props}/>;
}

export { Button, buttonVariants };
