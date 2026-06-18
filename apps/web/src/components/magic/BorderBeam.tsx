import { motion } from 'motion/react';
export function BorderBeam({ duration = 8, size = 80 }: { duration?: number; size?: number }) {
  return (
    <div className="pointer-events-none absolute inset-0 rounded-[inherit] [border:1px_solid_transparent] [mask-clip:padding-box,border-box] [mask-composite:intersect] [mask:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]">
      <motion.div
        className="absolute aspect-square"
        style={{
          width: size,
          offsetPath: `rect(0 auto auto 0 round ${size}px)`,
          background:
            'linear-gradient(to left, hsl(var(--primary)), hsl(var(--info)), transparent)',
        }}
        initial={{ offsetDistance: '0%' }}
        animate={{ offsetDistance: '100%' }}
        transition={{ repeat: Infinity, ease: 'linear', duration }}
      />
    </div>
  );
}
