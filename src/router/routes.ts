import type { RouteRecordRaw } from 'vue-router';
import { ahxSlotRedirect, slotOf } from './ahx-slot-guard';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/tracker' },
      {
        path: 'patch',
        name: 'patch-editor',
        component: () => import('pages/IndexPage.vue'),
        beforeEnter: (to) => {
          const slotQuery = to.query.editSongPatch;
          if (slotQuery) {
            const slotNumber = parseInt(slotQuery as string, 10);
            if (!Number.isNaN(slotNumber)) {
              // An AHX slot has no patch for the synth editor to open.
              const ahx = ahxSlotRedirect(slotNumber);
              if (ahx) return ahx;
              return {
                name: 'patch-instrument-editor',
                params: { slot: slotNumber },
              };
            }
          }
          return true;
        },
      },
      {
        path: 'patch/instrument/:slot(\\d+)',
        name: 'patch-instrument-editor',
        component: () => import('pages/IndexPage.vue'),
        // `#/patch/instrument/N` for an AHX slot: the AHX editor, never the synth's.
        beforeEnter: (to) => {
          const slotNumber = slotOf(to.params.slot);
          return (slotNumber === null ? null : ahxSlotRedirect(slotNumber)) ?? true;
        },
      },
      {
        // The AHX instrument editor (Task 5 B1 display, B2 editing). Its own
        // page: an AHX instrument is not a synth `Patch`, so it must not open
        // IndexPage.
        path: 'ahx/instrument/:slot(\\d+)',
        name: 'ahx-instrument-display',
        component: () => import('pages/AhxInstrumentPage.vue'),
      },
      {
        path: 'tracker',
        component: () => import('pages/TrackerPage.vue'),
        beforeEnter: (to) => {
          // If a song patch edit is requested (legacy query), forward to the instrument editor route.
          if (to.query.editSongPatch) {
            const slotNumber = parseInt(to.query.editSongPatch as string, 10);
            if (!Number.isNaN(slotNumber)) {
              const ahx = ahxSlotRedirect(slotNumber);
              if (ahx) return ahx;
              return {
                name: 'patch-instrument-editor',
                params: { slot: slotNumber },
              };
            }
          }
          return true;
        },
      },
      {
        path: 'jukebox',
        name: 'jukebox',
        component: () => import('pages/JukeboxPage.vue'),
      },
      { path: 'help', component: () => import('pages/HelpPage.vue') },
      { path: 'settings', component: () => import('pages/SettingsPage.vue') },
    ],
  },

  // Always leave this as last one,
  // but you can also remove it
  {
    path: '/:catchAll(.*)*',
    component: () => import('pages/ErrorNotFound.vue'),
  },
];

export default routes;
