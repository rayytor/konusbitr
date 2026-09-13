'use client';

import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/utils';

/** Beyond this the field scrolls instead of growing, in CSS pixels. */
const MAX_HEIGHT = 200;

/**
 * The chat composer, per `design.md` §9: a refined writing field, not an
 * application panel.
 *
 * Enter sends and Shift+Enter breaks the line, which is the convention every
 * reader already has. The send control is an icon because the arrow is
 * unambiguous, and it turns into a stop control while an answer is streaming
 * rather than sitting disabled next to a new one — there is only ever one thing
 * to do with that corner of the field.
 */
export function Composer({
  onSend,
  onStop,
  busy,
  disabled = false,
  placeholder = 'Ask about this document',
  autoFocus = false,
  inputRef,
}: {
  onSend: (message: string) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [value, setValue] = useState('');
  const own = useRef<HTMLTextAreaElement>(null);
  const field = inputRef ?? own;

  // Grow with the content up to a ceiling. Measured from `scrollHeight` after
  // resetting the height, which is the only way to let it shrink again.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the trigger, not a read — the measurement comes from the DOM after React has committed the new text.
  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [value, field]);

  function submit() {
    const trimmed = value.trim();
    if (trimmed === '' || busy || disabled) return;
    onSend(trimmed);
    setValue('');
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className={cn(
        'flex items-end gap-2 rounded-[var(--radius-md)] border border-border bg-surface px-3 py-2',
        'focus-within:border-accent',
        disabled ? 'opacity-60' : '',
      )}
    >
      <textarea
        ref={field}
        // biome-ignore lint/a11y/noAutofocus: the workspace exists to be asked questions, and ⌘/ focuses this field from anywhere; landing the caret here on open is the behaviour a reader is already expecting.
        autoFocus={autoFocus}
        rows={1}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label="Ask a question about this document"
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        className={cn(
          'min-h-6 flex-1 resize-none bg-transparent py-1 text-[15px] leading-relaxed',
          'text-foreground placeholder:text-foreground-subtle focus-visible:outline-none',
        )}
      />

      {busy ? (
        <IconButton
          variant="secondary"
          icon={Square}
          label="Stop generating"
          side="top"
          onClick={onStop}
        />
      ) : (
        <IconButton
          type="submit"
          icon={ArrowUp}
          label="Send"
          side="top"
          disabled={value.trim() === '' || disabled}
        />
      )}
    </form>
  );
}
