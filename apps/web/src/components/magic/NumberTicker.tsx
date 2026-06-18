import { useEffect, useRef, useState } from 'react';
import { useInView, useMotionValue, useSpring } from 'motion/react';

export function NumberTicker({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { damping: 60, stiffness: 120 });
  const inView = useInView(ref, { once: true, margin: '0px' });
  const [disp, setDisp] = useState('0');
  useEffect(() => {
    if (inView) mv.set(value);
  }, [inView, value, mv]);
  useEffect(
    () =>
      spring.on('change', (v) =>
        setDisp(
          Intl.NumberFormat('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          }).format(v),
        ),
      ),
    [spring, decimals],
  );
  return (
    <span ref={ref} className="num tabular-nums">
      {prefix}
      {disp}
      {suffix}
    </span>
  );
}
