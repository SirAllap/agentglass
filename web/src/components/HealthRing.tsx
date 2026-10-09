import { motion, useSpring, useTransform } from "motion/react";
import { useEffect } from "react";

/** Animated conic-gradient health ring (0–100). */
export function HealthRing({ value, size = 46 }: { value: number; size?: number }) {
  const spring = useSpring(value, { stiffness: 120, damping: 20 });
  useEffect(() => {
    spring.set(value);
  }, [value, spring]);

  const bg = useTransform(spring, (v) => {
    const color = v >= 80 ? "var(--success)" : v >= 50 ? "var(--warning)" : "var(--error)";
    return `conic-gradient(${color} ${v * 3.6}deg, color-mix(in srgb, var(--border) 40%, transparent) 0deg)`;
  });
  const label = useTransform(spring, (v) => `${Math.round(v)}`);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <motion.div className="rounded-full" style={{ width: size, height: size, background: bg }} />
      <div
        className="absolute rounded-full flex items-center justify-center"
        style={{ inset: 4, background: "var(--surface-card)" }}
      >
        <motion.span className="text-[12px] font-semibold" style={{ color: "var(--text)" }}>
          {label}
        </motion.span>
      </div>
    </div>
  );
}
