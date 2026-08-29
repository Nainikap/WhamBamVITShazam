import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-muted-foreground',
        primary: 'border-primary/30 bg-primary/15 text-primary',
        added: 'border-added/40 bg-added-soft text-added',
        removed: 'border-removed/40 bg-removed-soft text-removed',
        retimed: 'border-retimed/40 bg-retimed-soft text-retimed',
        edited: 'border-edited/40 bg-edited-soft text-edited',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
