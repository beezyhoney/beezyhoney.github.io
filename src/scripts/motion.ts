import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import Lenis from 'lenis';

gsap.registerPlugin(ScrollTrigger, SplitText);

export { gsap, ScrollTrigger };
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export let lenis: Lenis | null = null;

export function startSmoothScroll() {
  if (reducedMotion() || document.body.dataset.page === 'home') return null;
  lenis = new Lenis({ lerp: 0.1, anchors: { offset: -110 } });
  lenis.on('scroll', ScrollTrigger.update);
  gsap.ticker.add((time) => lenis?.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);
  return lenis;
}

/** Text and image reveals, driven by data attributes:
 *  data-split="chars|lines"  text rises out of a mask (data-now: on load instead of on scroll)
 *  data-fade                 fade up on scroll
 *  data-parallax="12"        image drifts inside its frame
 *  data-hero-card            rounded photo card opens up as it scrolls into view */
export function initReveals(root: ParentNode = document) {
  const reduce = reducedMotion();

  root.querySelectorAll<HTMLElement>('[data-split]').forEach((el) => {
    el.style.visibility = 'visible';
    if (reduce) return;
    const chars = el.dataset.split === 'chars';
    const now = el.hasAttribute('data-now');
    SplitText.create(el, {
      type: chars ? 'lines,chars' : 'lines',
      mask: 'lines',
      autoSplit: true,
      onSplit(self) {
        return gsap.from(chars ? self.chars : self.lines, {
          yPercent: 118,
          duration: chars ? 1.25 : 1.1,
          ease: 'expo.out',
          stagger: chars ? 0.032 : 0.09,
          delay: now ? Number(el.dataset.delay ?? 0.1) : 0,
          scrollTrigger: now ? undefined : { trigger: el, start: 'top 88%', once: true },
        });
      },
    });
  });

  root.querySelectorAll<HTMLElement>('[data-fade]').forEach((el) => {
    if (reduce) { el.style.visibility = 'visible'; return; }
    gsap.fromTo(el, { autoAlpha: 0, y: 48 }, {
      autoAlpha: 1, y: 0, duration: 1.2, ease: 'expo.out',
      delay: Number(el.dataset.delay ?? 0),
      scrollTrigger: { trigger: el, start: 'top 90%', once: true },
    });
  });

  if (reduce) return;

  root.querySelectorAll<HTMLElement>('[data-parallax]').forEach((el) => {
    const amount = Number(el.dataset.parallax || 8);
    gsap.fromTo(el, { yPercent: -amount }, {
      yPercent: amount, ease: 'none',
      scrollTrigger: { trigger: el.parentElement, start: 'top bottom', end: 'bottom top', scrub: true },
    });
  });

  root.querySelectorAll<HTMLElement>('[data-hero-card]').forEach((card) => {
    gsap.fromTo(card, { clipPath: 'inset(9% 7% 0% 7% round 48px)' }, {
      clipPath: 'inset(0% 0% 0% 0% round 28px)', ease: 'none',
      scrollTrigger: { trigger: card, start: 'top 92%', end: 'top 12%', scrub: true },
    });
  });
}

/** Run once the preloader or page curtain has cleared */
export function onReady(fn: () => void) {
  if (document.documentElement.classList.contains('motion-ready')) fn();
  else window.addEventListener('beezy:ready', fn, { once: true });
}

/** Re-measure after images and fonts settle */
export function refreshSoon() {
  window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
}
