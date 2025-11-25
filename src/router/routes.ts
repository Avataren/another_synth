import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    children: [
      { path: '', redirect: '/tracker' },
      { path: 'patch', component: () => import('pages/IndexPage.vue') },
      {
        path: 'tracker',
        component: () => import('pages/TrackerPage.vue'),
        beforeEnter: (to) => {
          // If a song patch edit is requested, forward to the patch editor with the same query.
          if (to.query.editSongPatch) {
            return { path: '/patch', query: to.query };
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
