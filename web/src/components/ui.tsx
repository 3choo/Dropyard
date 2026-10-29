import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { copyText } from '../lib/format';

// --- Button -------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }
>(function Button({ variant = 'secondary', loading, className = '', children, disabled, ...rest }, ref) {
  const styles: Record<ButtonVariant, string> = {
    primary:
      'bg-accent text-accent-ink font-medium hover:bg-accent-hi active:bg-accent-dim shadow-raised',
    secondary: 'bg-panel-2 text-ink border border-line hover:border-line-2 hover:bg-overlay',
    ghost: 'text-ink-2 hover:text-ink hover:bg-panel-2',
    danger: 'bg-danger-dim text-danger border border-danger/30 hover:bg-danger/15 hover:border-danger/50',
  };
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 ${styles[variant]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
});

// --- Inputs ---------------------------------------------------------------------

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className = '', ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`h-8 w-full rounded-lg border border-line bg-panel px-2.5 text-[13px] text-ink placeholder:text-ink-3 transition-colors focus:border-accent/60 focus:outline-none focus-visible:outline-none ${className}`}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = '', ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={`w-full rounded-lg border border-line bg-panel px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-3 transition-colors focus:border-accent/60 focus:outline-none ${className}`}
        {...rest}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = '', children, ...rest }, ref) {
    return (
      <select
        ref={ref}
        className={`h-8 rounded-lg border border-line bg-panel px-2 text-[13px] text-ink transition-colors hover:border-line-2 focus:border-accent/60 focus:outline-none ${className}`}
        {...rest}
      >
        {children}
      </select>
    );
  },
);

// --- Spinner ---------------------------------------------------------------------

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`h-3.5 w-3.5 animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Loading() {
  return (
    <div className="flex items-center gap-2 py-10 text-[13px] text-ink-3">
      <Spinner /> Loading…
    </div>
  );
}

// --- Chips ------------------------------------------------------------------------

export function Chip({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: 'neutral' | 'accent' | 'warn' | 'info' | 'danger';
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: 'border-line text-ink-2 bg-panel-2',
    accent: 'border-accent/40 text-accent bg-accent/10',
    warn: 'border-warn/40 text-warn bg-warn/10',
    info: 'border-info/40 text-info bg-info/10',
    danger: 'border-danger/40 text-danger bg-danger/10',
  } as const;
  return (
    <span
      className={`inline-flex h-5 items-center gap-1 rounded-md border px-1.5 font-mono text-[11px] leading-none ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

// --- Modal --------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="fixed inset-0 bg-black/60" onClick={onClose} aria-hidden />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={title}
            className={`relative w-full ${width} rounded-2xl border border-line bg-panel shadow-overlay`}
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <h2 className="px-5 pb-1 pt-4 text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
            <div className="px-5 pb-5 pt-2">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// --- Copy button ----------------------------------------------------------------------

export function CopyButton({ value, label = 'Copy', className = '' }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      className={`h-6 px-1.5 text-[11px] ${className}`}
      onClick={async () => {
        if (await copyText(value)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }
      }}
      aria-label={`${label} to clipboard`}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

// --- Empty state ------------------------------------------------------------------------

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-20 text-center">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl border border-line bg-panel-2 text-accent [&>svg]:h-5 [&>svg]:w-5">
        {icon}
      </div>
      <p className="text-[14px] font-medium">{title}</p>
      <p className="mb-5 mt-1.5 max-w-sm text-[13px] leading-relaxed text-ink-2">{body}</p>
      {action}
    </div>
  );
}

// --- Toasts ---------------------------------------------------------------------------------

type Toast = { id: number; kind: 'ok' | 'err'; text: string };
let pushToastImpl: ((t: Omit<Toast, 'id'>) => void) | null = null;

export function toast(text: string, kind: 'ok' | 'err' = 'ok') {
  pushToastImpl?.({ kind, text });
}

export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  useEffect(() => {
    pushToastImpl = (t) => {
      const id = ++nextId.current;
      setToasts((list) => [...list.slice(-3), { ...t, id }]);
      setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 4200);
    };
    return () => {
      pushToastImpl = null;
    };
  }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-80 flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, y: 10, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={`pointer-events-auto rounded-xl border px-3.5 py-2.5 text-[13px] shadow-overlay ${
              t.kind === 'ok'
                ? 'border-line bg-overlay text-ink'
                : 'border-danger/40 bg-overlay text-danger'
            }`}
          >
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
