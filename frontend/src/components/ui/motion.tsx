"use client";

/**
 * Motion primitives. One vocabulary for the whole product:
 *  - durations: fast 0.12s (micro feedback), base 0.2s (UI state), slow 0.32s (emphasis / page)
 *  - easing: `ease.out` for entrances, `ease.inOut` for continuous loops
 *  - everything degrades to an instant state under `prefers-reduced-motion`.
 */
import { animate, AnimatePresence, motion, useInView, useMotionValue, useReducedMotion, useTransform, type HTMLMotionProps, type Variants } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";

export const duration = { fast: 0.12, base: 0.2, slow: 0.32 } as const;
export const ease = {
  out: [0.22, 1, 0.36, 1] as [number, number, number, number],
  inOut: [0.65, 0, 0.35, 1] as [number, number, number, number],
  emphasized: [0.2, 0, 0, 1] as [number, number, number, number],
};
export const spring = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 } as const;

/** Fade + 6px rise on mount. */
export function FadeIn({ children, delay = 0, y = 6, className, as = "div", ...rest }: { children: React.ReactNode; delay?: number; y?: number; className?: string; as?: "div" | "section" | "li" | "span" } & Omit<HTMLMotionProps<"div">, "children">) {
  const reduce = useReducedMotion();
  const Comp = motion[as] as typeof motion.div;
  return (
    <Comp
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.slow, ease: ease.out, delay }}
      {...rest}
    >
      {children}
    </Comp>
  );
}

const HIDE_INSTANT = { duration: 0 };

/**
 * Progressive reveal: content is visible in server HTML (crawlers, link previews, no-JS, slow
 * hydration). Only elements that start *below the fold* on the client are hidden — invisibly to
 * the user — and then animate in when scrolled to. Nothing above the fold ever blinks.
 */
function useArmedReveal<T extends Element>(enabled: boolean) {
  const ref = React.useRef<T>(null);
  const reduce = useReducedMotion();
  const [armed, setArmed] = React.useState(false);
  const inView = useInView(ref, { once: true, margin: "0px 0px -60px 0px" });
  React.useLayoutEffect(() => {
    if (!enabled || reduce || !ref.current) return;
    if (ref.current.getBoundingClientRect().top > window.innerHeight) setArmed(true);
  }, [enabled, reduce]);
  return { ref, visible: !armed || inView };
}

const staggerParent: Variants = { hidden: { transition: HIDE_INSTANT }, show: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } } };
const staggerChild: Variants = {
  hidden: { opacity: 0, y: 8, transition: HIDE_INSTANT },
  show: { opacity: 1, y: 0, transition: { duration: duration.base + 0.1, ease: ease.out } },
};

/**
 * Staggered list reveal. Wrap children in <StaggerItem>. Without `inView` it animates on mount;
 * with `inView` it uses the progressive reveal above (visible by default, animates when scrolled to).
 */
export function Stagger({ children, className, as = "div", inView = false, ...rest }: { children: React.ReactNode; className?: string; as?: "div" | "ul" | "ol" | "section"; inView?: boolean } & Omit<HTMLMotionProps<"div">, "children">) {
  const reduce = useReducedMotion();
  const { ref, visible } = useArmedReveal<HTMLDivElement>(inView);
  const Comp = motion[as] as typeof motion.div;
  if (reduce) {
    const Plain = as;
    return <Plain className={className}>{children}</Plain>;
  }
  return (
    <Comp
      ref={ref}
      className={className}
      variants={staggerParent}
      {...(inView ? { initial: false, animate: visible ? "show" : "hidden" } : { initial: "hidden", animate: "show" })}
      {...rest}
    >
      {children}
    </Comp>
  );
}

export function StaggerItem({ children, className, as = "div", ...rest }: { children: React.ReactNode; className?: string; as?: "div" | "li" | "article" } & Omit<HTMLMotionProps<"div">, "children">) {
  const Comp = motion[as] as typeof motion.div;
  return (
    <Comp className={className} variants={staggerChild} {...rest}>
      {children}
    </Comp>
  );
}

/** Reveal-on-scroll for marketing sections (progressive: visible in server HTML). */
export function Reveal({ children, className, delay = 0, y = 14 }: { children: React.ReactNode; className?: string; delay?: number; y?: number }) {
  const { ref, visible } = useArmedReveal<HTMLDivElement>(true);
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={false}
      animate={visible ? { opacity: 1, y: 0, transition: { duration: 0.5, ease: ease.out, delay } } : { opacity: 0, y, transition: HIDE_INSTANT }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Animated number (KPI count-up). Formats with `format` (defaults to locale integer).
 * Animates from the previous value on change; renders the final value immediately under reduced motion.
 */
export function CountUp({ value, format, className, durationMs = 900 }: { value: number; format?: (n: number) => string; className?: string; durationMs?: number }) {
  const reduce = useReducedMotion();
  const ref = React.useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const mv = useMotionValue(reduce ? value : 0);
  const fmt = React.useCallback((n: number) => (format ? format(n) : Math.round(n).toLocaleString()), [format]);
  const text = useTransform(mv, (n) => fmt(n));
  React.useEffect(() => {
    if (reduce) {
      mv.set(value);
      return;
    }
    if (!inView) return;
    const controls = animate(mv, value, { duration: durationMs / 1000, ease: ease.out });
    return () => controls.stop();
  }, [value, inView, reduce, mv, durationMs]);
  return (
    <motion.span ref={ref} className={cn("tabular", className)} aria-label={fmt(value)}>
      {text}
    </motion.span>
  );
}

/** Route-level content transition (used by the app frame). */
export function PageTransition({ children, className, routeKey }: { children: React.ReactNode; className?: string; routeKey?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      key={routeKey}
      className={className}
      initial={reduce ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: duration.base + 0.04, ease: ease.out }}
    >
      {children}
    </motion.div>
  );
}

/** Height-animating collapse for disclosures. */
export function Collapse({ open, children, className }: { open: boolean; children: React.ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          className={cn("overflow-hidden", className)}
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ duration: duration.base, ease: ease.out }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Swap content with a short crossfade (e.g. status text that changes). */
export function Swap({ id, children, className }: { id: string | number; children: React.ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={id}
        className={cn("inline-block", className)}
        initial={reduce ? false : { opacity: 0, y: 3 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3 }}
        transition={{ duration: duration.fast + 0.03, ease: ease.out }}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  );
}

export { AnimatePresence, motion, useReducedMotion };
