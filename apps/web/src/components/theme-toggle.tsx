'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from '@/components/theme-provider';
import { Segmented } from '@/components/ui/segmented';
import { THEMES, type Theme } from '@/lib/theme';

const OPTIONS = [
  { value: 'system' as const, label: 'Match system', icon: Monitor },
  { value: 'light' as const, label: 'Sepia light', icon: Sun },
  { value: 'dark' as const, label: 'Dark', icon: Moon },
] satisfies { value: Theme; label: string; icon: typeof Sun }[];

/**
 * Appearance, as three icons.
 *
 * `system` is first and is the default, because sepia light is what the product
 * looks like and the OS is the only thing that should override it without being
 * asked. Each option carries a real label for the screen reader even though only
 * the icon is drawn.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <Segmented
      label="Appearance"
      iconOnly
      value={theme}
      onChange={setTheme}
      options={OPTIONS.filter((option) => THEMES.includes(option.value))}
    />
  );
}
