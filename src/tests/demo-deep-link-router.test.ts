import { describe, it, expect } from 'vitest';
import { createRouter, createWebHashHistory } from 'vue-router';
import { defineComponent } from 'vue';
import {
  buildDemoLink,
  readDemoLinkParam,
} from 'src/composables/demo-deep-link';

/**
 * The round trip is the feature: a link only works if the song it names is
 * still reachable after the production router has taken over the URL. The
 * app runs `vueRouterMode: 'hash'` with publicPath '/synth/', served as
 * plain static files — the only document the host serves is '/synth/'
 * itself. So the link must (a) be emitted as a search-on-base URL and
 * (b) land on that base path with the demo param still readable where
 * TrackerPage reads it: `window.location.search`.
 *
 * This drives createWebHashHistory('/synth/') exactly as the built app
 * does, seeding the document with the exact string buildDemoLink emits.
 *
 * The last block pins the path-style format this one replaced — it fails
 * both ways: '/synth/tracker' is no served document (static host 404s
 * before any code runs), and it is not the router base, so it relies on
 * browser-specific normalization to even reach the app. The pathname pin
 * is the differential jsdom reproduces faithfully; the exact-string pin
 * catches any regression back to a path-style emission.
 */

/** The two records the deep link's route rides on, as production shapes them. */
const routes = [
  { path: '/', redirect: '/tracker' },
  // The real TrackerPage is far too heavy for a jsdom test; the router's
  // URL normalization — the thing under test — never renders components.
  { path: '/tracker', component: defineComponent({}) },
];

async function navigateFromSeed(url: string): Promise<Location> {
  window.history.replaceState(null, '', url);
  const router = createRouter({
    history: createWebHashHistory('/synth/'),
    routes,
  });
  await router.push('/tracker');
  return window.location;
}

describe('demo link round trip through the hash router', () => {
  it('buildDemoLink emits a search-on-base URL, not a path-style one', () => {
    const link = buildDemoLink('amiga/12TH.MOD', {
      origin: 'https://another-synth.example',
      base: '/synth/',
    });
    expect(link).toBe('https://another-synth.example/synth/?demo=amiga%2F12TH.MOD');
  });

  it('the emitted link lands on the base document with the param readable', async () => {
    const link = buildDemoLink('amiga/12TH.MOD', { base: '/synth/' });
    const seeded = new URL(link);
    const location = await navigateFromSeed(seeded.pathname + seeded.search);
    // The static host serves exactly one document: the router base.
    expect(location.pathname).toBe('/synth/');
    expect(readDemoLinkParam(location.search)).toBe('amiga/12TH.MOD');
  });

  it('the param survives a shared URL that already carries the hash', async () => {
    const link = buildDemoLink('s3m/2nd_reality.s3m', { base: '/synth/' });
    const seeded = new URL(link);
    const location = await navigateFromSeed(
      `${seeded.pathname}${seeded.search}#/tracker`,
    );
    expect(location.pathname).toBe('/synth/');
    expect(readDemoLinkParam(location.search)).toBe('s3m/2nd_reality.s3m');
  });

  it('the old path-style format fails the base-document pin (why it was dropped)', async () => {
    const oldStyle = 'https://x.invalid/synth/tracker?demo=amiga/gone.mod';
    const seeded = new URL(oldStyle);
    const location = await navigateFromSeed(seeded.pathname + seeded.search);
    // Not the router base — no document serves this path in a hash-mode
    // static deployment, so the link 404s before the app can even run.
    expect(location.pathname).not.toBe('/synth/');
  });
});
