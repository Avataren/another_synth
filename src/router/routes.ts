import type { RouteRecordRaw } from 'vue-router';

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
      },
      {
        path: 'tracker',
        component: () => import('pages/TrackerPage.vue'),
        beforeEnter: (to) => {
          // If a song patch edit is requested (legacy query), forward to the instrument editor route.
          if (to.query.editSongPatch) {
            const slotNumber = parseInt(to.query.editSongPatch as string, 10);
            if (!Number.isNaN(slotNumber)) {
              return {
                name: 'patch-instrument-editor',
                params: { slot: slotNumber },
              };
            }
          }
          return true;
        },
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
