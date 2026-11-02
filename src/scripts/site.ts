import { gsap, initReveals, lenis, reducedMotion, refreshSoon, startSmoothScroll } from './motion';
import { cart, orderLink, savedFields, saveFields } from './cart';

const html = document.documentElement;
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const store = {
  get: (k: string) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { sessionStorage.setItem(k, v); } catch { /* blocked */ } },
  del: (k: string) => { try { sessionStorage.removeItem(k); } catch { /* blocked */ } },
};
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/* ---------- intro: preloader on first visit, curtain between pages ---------- */
function intro(): Promise<void> {
  const curtain = $('.curtain');
  if (html.classList.contains('is-first-visit')) {
    const pre = $('.preloader')!;
    const fill = $('.preloader-seal .fill', pre);
    const count = $('.preloader-count', pre);
    const n = { v: 0 };
    return new Promise((done) => {
      gsap.timeline({
        onComplete() {
          html.classList.remove('is-first-visit');
          store.set('beezy-visited', '1');
          done();
        },
      })
        .to(n, { v: 100, duration: 1.4, ease: 'power2.inOut', onUpdate: () => { if (count) count.textContent = `${Math.round(n.v)}%`; } }, 0)
        .fromTo(fill, { clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0% 0 0 0)', duration: 1.4, ease: 'power2.inOut' }, 0)
        .to(pre, { yPercent: -100, duration: 0.9, ease: 'expo.inOut' }, '+=0.15');
    });
  }
  store.set('beezy-visited', '1');
  if (html.classList.contains('is-arriving') && curtain) {
    store.del('beezy-nav');
    const c = curtainParts(curtain);
    return new Promise((done) => {
      // the logo keeps spinning (CSS) while the honey screen slowly fades away over the new page
      gsap.timeline({
        onComplete() {
          html.classList.remove('is-arriving');
          resetCurtain(curtain);
        },
      })
        .call(done, undefined, 0.15)
        .to(c.mark, { scale: 1.12, duration: 1, ease: 'power2.out' }, 0.15)
        .to(curtain, { autoAlpha: 0, duration: 1, ease: 'power2.inOut' }, 0.15);
    });
  }
  return Promise.resolve();
}

/* ---------- page-change screen: honey curtain, honeycomb and a spinning logo ---------- */
function curtainParts(curtain: HTMLElement) {
  return {
    comb: $('.curtain-comb', curtain),
    mark: $('.curtain-mark', curtain),
    front: $<SVGPathElement>('.curtain-front path', curtain),
  };
}

/** Leading edge while the screen rises: a honey dome that flattens as it fills (k = 1 dome, 0 flat) */
function frontPath(k: number) {
  const edge = 100 - 32 * k, peak = 100 - 128 * k;
  return `M0 100V${edge.toFixed(2)}C26 ${peak.toFixed(2)} 70 ${peak.toFixed(2)} 100 ${edge.toFixed(2)}V100Z`;
}

function resetCurtain(curtain: HTMLElement) {
  const c = curtainParts(curtain);
  html.classList.remove('is-leaving', 'is-nav-paused');
  gsap.set(curtain, { clearProps: 'transform,visibility,opacity' });
  gsap.set([c.comb, c.mark].filter(Boolean), { clearProps: 'all' });
  c.front?.setAttribute('d', frontPath(0));
}

function showCurtain(curtain: HTMLElement, then: () => void) {
  const c = curtainParts(curtain);
  const front = { k: 1 };
  const draw = () => c.front?.setAttribute('d', frontPath(front.k));
  draw();
  // start the CSS spin; its timing lands on a full turn at 0.9 s, where the new page's spin picks up
  html.classList.add('is-leaving');
  gsap.timeline()
    .set(curtain, { visibility: 'visible', y: 0, yPercent: 100 })
    .to(curtain, { yPercent: 0, duration: 0.75, ease: 'expo.inOut' }, 0)
    .to(front, { k: 0, duration: 0.45, ease: 'power2.in', onUpdate: draw }, 0.3)
    .fromTo(c.comb, { y: 40, opacity: 0 }, { y: 0, opacity: 0.1, duration: 0.9, ease: 'power2.out' }, 0.2)
    .fromTo(c.mark, { scale: 0.7, autoAlpha: 0 }, { scale: 1, autoAlpha: 1, duration: 0.6, ease: 'back.out(1.4)' }, 0.3)
    .call(() => { html.classList.add('is-nav-paused'); then(); }, undefined, 0.9);
}

function interceptLinks() {
  const curtain = $('.curtain');
  document.addEventListener('click', (e) => {
    const a = (e.target as Element).closest<HTMLAnchorElement>('a[href]');
    if (!a || !curtain || reducedMotion()) return;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download') || a.dataset.noTransition !== undefined) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.hash) return;
    if (/\.(pdf|jpg|png|webp)$/i.test(url.pathname)) return;
    e.preventDefault();
    showCurtain(curtain, () => {
      store.set('beezy-nav', '1');
      location.href = url.href;
    });
  });
  // back/forward from the page cache: make sure the curtain is out of the way
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && curtain) {
      html.classList.remove('is-arriving');
      resetCurtain(curtain);
    }
  });
}

/* ---------- header ---------- */
function headerState() {
  const update = () => html.classList.toggle('is-scrolled', window.scrollY > 40);
  update();
  window.addEventListener('scroll', update, { passive: true });
}

/* ---------- menu ---------- */
function menu() {
  const btn = $<HTMLButtonElement>('[data-menu-toggle]');
  const panel = $('#menu');
  if (!btn || !panel) return;
  const label = $('.pill', btn);
  const links = $$('.menu-list a, .menu-foot > *', panel);
  let open = false;
  let tl: gsap.core.Timeline | null = null;

  const set = (next: boolean) => {
    if (next === open) return;
    open = next;
    btn.setAttribute('aria-expanded', String(open));
    if (label) label.textContent = open ? 'Close' : 'Menu';
    html.classList.toggle('is-menu-open', open);
    tl?.kill();
    if (open) {
      lenis?.stop();
      panel.inert = false;
      tl = gsap.timeline()
        .set(panel, { visibility: 'visible' })
        .fromTo(panel, { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: reducedMotion() ? 0 : 0.8, ease: 'expo.inOut' })
        .fromTo(links, { yPercent: 105, opacity: 0 }, { yPercent: 0, opacity: 1, duration: reducedMotion() ? 0 : 0.9, ease: 'expo.out', stagger: 0.06 }, '-=0.35');
      links[0]?.focus({ preventScroll: true });
    } else {
      lenis?.start();
      tl = gsap.timeline({ onComplete: () => { panel.inert = true; gsap.set(panel, { visibility: 'hidden' }); } })
        .to(panel, { clipPath: 'inset(0 0 100% 0)', duration: reducedMotion() ? 0 : 0.6, ease: 'expo.inOut' });
      btn.focus({ preventScroll: true });
    }
  };
  panel.inert = true;
  btn.addEventListener('click', () => set(!open));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) set(false); });
}

/* ---------- cart drawer ---------- */
function cartDrawer() {
  const drawer = $('#cart');
  if (!drawer) return;
  const list = $('[data-cart-list]', drawer)!;
  const empty = $('[data-cart-empty]', drawer)!;
  const foot = $('[data-cart-foot]', drawer)!;
  const send = $<HTMLAnchorElement>('[data-cart-send]', drawer)!;
  const nameIn = $<HTMLInputElement>('#cart-name', drawer)!;
  const pinIn = $<HTMLInputElement>('#cart-pin', drawer)!;
  const counts = $$('[data-cart-count]');
  const saved = savedFields();
  nameIn.value = saved.name ?? '';
  pinIn.value = saved.pin ?? '';
  drawer.inert = true;

  const render = () => {
    const items = cart.items();
    const n = cart.count();
    counts.forEach((c) => { c.textContent = String(n); c.dataset.empty = String(n === 0); });
    empty.hidden = items.length > 0;
    foot.hidden = items.length === 0;
    list.innerHTML = items.map((it, i) => `
      <li>
        <span class="nm">${escapeHtml(it.name)}</span>
        <button type="button" class="rm" data-act="remove" data-i="${i}">Remove</button>
        <span class="pk">${escapeHtml(it.pack)}</span>
        <span class="qty" role="group" aria-label="Quantity for ${escapeHtml(it.name)}, ${escapeHtml(it.pack)}">
          <button type="button" data-act="dec" data-i="${i}" aria-label="One less">−</button>
          <output>${it.qty}</output>
          <button type="button" data-act="inc" data-i="${i}" aria-label="One more">+</button>
        </span>
      </li>`).join('');
    send.href = orderLink(items, nameIn.value, pinIn.value);
    send.setAttribute('aria-disabled', String(items.length === 0));
  };

  list.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button[data-act]');
    if (!b) return;
    const i = Number(b.dataset.i);
    const it = cart.items()[i];
    if (!it) return;
    if (b.dataset.act === 'remove') cart.remove(i);
    if (b.dataset.act === 'inc') cart.setQty(i, it.qty + 1);
    if (b.dataset.act === 'dec') cart.setQty(i, it.qty - 1);
  });
  [nameIn, pinIn].forEach((input) => input.addEventListener('input', () => {
    saveFields({ name: nameIn.value, pin: pinIn.value });
    send.href = orderLink(cart.items(), nameIn.value, pinIn.value);
  }));
  $('[data-cart-clear]', drawer)?.addEventListener('click', () => cart.clear());

  let lastFocus: HTMLElement | null = null;
  const setOpen = (open: boolean) => {
    html.classList.toggle('is-cart-open', open);
    drawer.inert = !open;
    $$('[data-cart-open]').forEach((b) => b.setAttribute('aria-expanded', String(open)));
    if (open) {
      lenis?.stop();
      lastFocus = document.activeElement as HTMLElement;
      $<HTMLElement>('[data-cart-close]', drawer)?.focus({ preventScroll: true });
    } else {
      lenis?.start();
      lastFocus?.focus({ preventScroll: true });
    }
  };
  document.addEventListener('click', (e) => {
    const t = e.target as Element;
    if (t.closest('[data-cart-open]')) setOpen(true);
    else if (t.closest('[data-cart-close]') || t.closest('.scrim')) setOpen(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && html.classList.contains('is-cart-open')) setOpen(false); });
  window.addEventListener('cart:open', () => setOpen(true));
  window.addEventListener('cart:change', render);
  render();
}

/* ---------- photo sliders ---------- */
function sliders() {
  $$('[data-slider]').forEach((slider) => {
    const track = $('.slider-track', slider)!;
    const step = (dir: number) => {
      const first = track.querySelector('figure');
      const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
      track.scrollBy({ left: dir * ((first?.getBoundingClientRect().width ?? 400) + gap), behavior: reducedMotion() ? 'auto' : 'smooth' });
    };
    $('[data-prev]', slider)?.addEventListener('click', () => step(-1));
    $('[data-next]', slider)?.addEventListener('click', () => step(1));
    track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    });
  });
}

/* ---------- boot ---------- */
startSmoothScroll();
headerState();
menu();
cartDrawer();
sliders();
interceptLinks();
intro().then(() => {
  html.classList.add('motion-ready');
  initReveals();
  refreshSoon();
  window.dispatchEvent(new CustomEvent('beezy:ready'));
});
