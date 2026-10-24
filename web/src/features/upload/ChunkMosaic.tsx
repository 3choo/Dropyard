import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { PartState } from './uploader';

const MAX_CELLS = 240;

/**
 * The upload's instrument panel: one cell per multipart part, filling with
 * chartreuse as parts land on R2. Large files bucket several parts per cell.
 */
export function ChunkMosaic({ states, done }: { states: PartState[]; done: boolean }) {
  const reduceMotion = useReducedMotion();

  const cells = Math.min(states.length, MAX_CELLS);
  const perCell = states.length / cells;

  const cellState = (i: number): PartState => {
    const from = Math.floor(i * perCell);
    const to = Math.max(from + 1, Math.floor((i + 1) * perCell));
    let seenDone = 0;
    let seenUp = 0;
    let seenFailed = false;
    for (let j = from; j < to && j < states.length; j++) {
      const s = states[j];
      if (s === 'done') seenDone++;
      if (s === 'uploading') seenUp++;
      if (s === 'failed') seenFailed = true;
    }
    const total = to - from;
    if (seenFailed && seenDone < total) return 'failed';
    if (seenDone === total) return 'done';
    if (seenDone > 0 || seenUp > 0) return 'uploading';
    return 'pending';
  };

  const colors: Record<PartState, string> = {
    pending: 'bg-line-2',
    uploading: 'bg-accent/55',
    done: 'bg-accent',
    failed: 'bg-danger',
  };

  return (
    <AnimatePresence initial={false}>
      {done ? (
        <motion.div
          key="collapsed"
          className="flex h-8 items-center"
          initial={reduceMotion ? false : { opacity: 0, scaleY: 0.3 }}
          animate={{ opacity: 1, scaleY: 1 }}
          transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
            <motion.div
              className="h-full rounded-full bg-accent"
              initial={reduceMotion ? false : { width: '0%' }}
              animate={{ width: '100%' }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
            />
          </div>
        </motion.div>
      ) : (
        <motion.div
          key="mosaic"
          className="flex flex-wrap content-start gap-[3px]"
          exit={reduceMotion ? undefined : { opacity: 0, scaleY: 0.2, transition: { duration: 0.25 } }}
        >
          {Array.from({ length: cells }, (_, i) => {
            const state = cellState(i);
            return (
              <motion.span
                key={i}
                className={`h-[9px] w-[9px] rounded-[2px] ${colors[state]}`}
                initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  transition: { delay: Math.min(i * 0.004, 0.4), duration: 0.2, ease: [0.16, 1, 0.3, 1] },
                }}
              />
            );
          })}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
