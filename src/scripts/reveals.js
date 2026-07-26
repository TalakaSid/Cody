import { animate, stagger, svg, text } from 'animejs';

// Native IntersectionObserver drives the trigger; anime.js only does the motion.
export function initReveals() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Blur filters are real GPU cost per frame, and they'd land exactly when a
  // section enters view — i.e. while the canvas scrubber is also busiest.
  // Skip blur (keep opacity/translateY) on touch devices and low-memory ones.
  const skipBlur =
    window.matchMedia('(hover: none) and (pointer: coarse)').matches ||
    (navigator.deviceMemory != null && navigator.deviceMemory <= 4);
  const targets = document.querySelectorAll('[data-reveal]');
  const seen = new WeakSet();

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || seen.has(entry.target)) continue;
        seen.add(entry.target);
        reveal(entry.target);
      }
    },
    { threshold: 0.35 }
  );

  targets.forEach((t) => io.observe(t));

  function reveal(section) {
    const textEls = section.querySelectorAll('[data-reveal-text]');
    textEls.forEach((el) => {
      if (reduce) {
        el.style.opacity = '1';
        return;
      }
      const split = text.split(el, { words: { class: 'word' } });
      split.words.forEach((w) => (w.style.willChange = 'transform, opacity' + (skipBlur ? '' : ', filter')));
      animate(split.words, {
        opacity: [0, 1],
        translateY: [24, 0],
        ...(skipBlur ? {} : { filter: ['blur(10px)', 'blur(0px)'] }),
        delay: stagger(28),
        duration: 900,
        ease: 'outQuart',
        onComplete: () => split.words.forEach((w) => (w.style.willChange = 'auto')),
      });
    });

    const lines = section.querySelectorAll('[data-reveal-line]');
    if (lines.length && !reduce) {
      const drawables = svg.createDrawable(lines);
      animate(drawables, {
        draw: ['0 0', '0 1'],
        opacity: [0, 1],
        duration: 1400,
        delay: stagger(150),
        ease: 'inOutQuad',
      });
    } else if (lines.length) {
      lines.forEach((l) => l.style.opacity = '1');
    }
  }
}
