import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teamspace replaces Tailwind's default type scale (see app/globals.css), so
// tailwind-merge must know these names are font sizes, not text colors.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ['2xs', 'xs', 'sm', 'base', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'],
      shadow: ['xs', 'sm', 'md', 'lg', 'focus'],
      radius: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl'],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
