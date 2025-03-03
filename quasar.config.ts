/* eslint-env node */

// Configuration for your app
// https://v2.quasar.dev/quasar-cli-vite/quasar-config-js

import { defineConfig } from '#q-app/wrappers';
//import { exec } from 'child_process';
//import path from 'path';
//import fs from 'fs';

export default defineConfig((/* ctx */) => {
  return {
    // https://v2.quasar.dev/quasar-cli-vite/prefetch-feature
    // preFetch: true,

    // app boot file (/src/boot)
    // --> boot files are part of "main.js"
    // https://v2.quasar.dev/quasar-cli-vite/boot-files
    boot: ['axios', 'pinia-audio-system'],

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-js#css
    css: ['app.scss'],

    // https://github.com/quasarframework/quasar/tree/dev/extras
    extras: [
      // 'ionicons-v4',
      // 'mdi-v7',
      // 'fontawesome-v6',
      // 'eva-icons',
      // 'themify',
      // 'line-awesome',
      // 'roboto-font-latin-ext', // this or either 'roboto-font', NEVER both!

      'roboto-font', // optional, you are not bound to it
      'material-icons', // optional, you are not bound to it
    ],

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/quasar-config-js#build
    build: {
      target: {
        browser: ['es2022', 'firefox115', 'chrome115', 'safari14'],
        node: 'node20',
      },

      typescript: {
        strict: true,
        vueShim: true,
        // extendTsConfig (tsConfig) {}
      },

      vueRouterMode: 'hash', // available values: 'hash', 'history'
      // vueRouterBase,
      // vueDevtools,
      // vueOptionsAPI: false,

      // rebuildCache: true, // rebuilds Vite/linter/etc cache on startup

      publicPath: '/synth/',
      // analyze: true,
      // env: {},
      // rawDefine: {}
      // ignorePublicFolder: true,
      // minify: false,
      // polyfillModulePreload: true,
      // distDir

      // extendViteConf (viteConf) {},
      // viteVuePluginOptions: {},

      vitePlugins: [
        [
          'vite-plugin-checker',
          {
            vueTsc: true,
            eslint: { lintCommand: 'eslint "./**/*.{js,ts,mjs,cjs,vue}"' },
          },
          { server: false },
        ],
        {
          name: 'watch-worklet-reload',
          enforce: 'pre',
          apply: 'serve',
          handleHotUpdate({ file, server }) {
            const isWorkletFile =
              file.endsWith('.js') && file.includes('public/worklets');

            if (isWorkletFile) {
              console.log(`Worklet file changed: ${file}, triggering full page reload`);
              server.ws.send({
                type: 'full-reload',
                path: '*',
              });
            }
          },
        },
        {
          name: 'watch-wasm-reload',
          enforce: 'pre',
          apply: 'serve',
          handleHotUpdate({ file, server }) {
            const isWasmFile = file.includes('public/wasm');

            if (isWasmFile) {
              console.log(`WASM file changed: ${file}, triggering full page reload`);
              server.ws.send({
                type: 'full-reload',
                path: '*',
              });
            }
          },
        }
        // {
        //   name: 'watch-assemblyscript',
        //   enforce: 'pre',
        //   apply: 'serve',
        //   handleHotUpdate({ file, server }) {
        //     const isAssemblyFile =
        //       file.endsWith('.ts') && file.includes('src/assembly');

        //     if (isAssemblyFile) {
        //       console.log(
        //         `[AssemblyScript Watcher] Rebuilding WASM for ${file}`,
        //       );

        //       exec('npm run asbuild:release', (err, stdout, stderr) => {
        //         if (err) {
        //           console.error(
        //             `[AssemblyScript Watcher] Build error:\n${stderr}`,
        //           );
        //           return;
        //         }

        //         console.log(
        //           `[AssemblyScript Watcher] Build success:\n${stdout}`,
        //         );

        //         // Path to the generated WASM file
        //         const wasmFilePath = path.resolve(
        //           __dirname,
        //           'public/wasm/release.wasm',
        //         );

        //         // Wait for the WASM file to exist before triggering a reload
        //         if (fs.existsSync(wasmFilePath)) {
        //           console.log(
        //             `[AssemblyScript Watcher] Triggering reload for WASM file: ${wasmFilePath}`,
        //           );
        //           server.ws.send({
        //             type: 'full-reload', // Trigger a full page reload
        //             path: '*',
        //           });
        //         } else {
        //           console.error(
        //             `[AssemblyScript Watcher] WASM file not found: ${wasmFilePath}`,
        //           );
        //         }
        //       });
        //     }
        //   },
        // },
      ],

      extendViteConf(viteConf) {
        viteConf.assetsInclude = ['**/*.wasm'];

        // Add build configuration for worklets
        // viteConf.build = viteConf.build || {};
        // viteConf.build.rollupOptions = {
        //   output: {
        //     assetFileNames: (assetInfo) => {
        //       if (assetInfo.name?.endsWith('.ts') && assetInfo.name.includes('worklet')) {
        //         return 'worklets/[name].js';
        //       }
        //       return 'assets/[name].[hash].[ext]';
        //     },
        //   },
        // };

        // // Ensure worklet files are not inlined
        // viteConf.build.assetsInlineLimit = 0;
      },
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/quasar-config-js#devServer
    devServer: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      // https: true
      open: true, // opens browser window automatically
    },

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-js#framework
    framework: {
      config: {
        dark: true,
      },

      // iconSet: 'material-icons', // Quasar icon set
      // lang: 'en-US', // Quasar language pack

      // For special cases outside of where the auto-import strategy can have an impact
      // (like functional components as one of the examples),
      // you can manually specify Quasar components/directives to be available everywhere:
      //
      // components: [],
      // directives: [],

      // Quasar plugins
      plugins: [],
    },

    // animations: 'all', // --- includes all animations
    // https://v2.quasar.dev/options/animations
    animations: [],

    // https://v2.quasar.dev/quasar-cli-vite/quasar-config-js#sourcefiles
    // sourceFiles: {
    //   rootComponent: 'src/App.vue',
    //   router: 'src/router/index',
    //   store: 'src/store/index',
    //   pwaRegisterServiceWorker: 'src-pwa/register-service-worker',
    //   pwaServiceWorker: 'src-pwa/custom-service-worker',
    //   pwaManifestFile: 'src-pwa/manifest.json',
    //   electronMain: 'src-electron/electron-main',
    //   electronPreload: 'src-electron/electron-preload'
    //   bexManifestFile: 'src-bex/manifest.json
    // },

    // https://v2.quasar.dev/quasar-cli-vite/developing-ssr/configuring-ssr
    ssr: {
      prodPort: 3000, // The default port that the production server should use
      // (gets superseded if process.env.PORT is specified at runtime)

      middlewares: [
        'render', // keep this as last one
      ],

      // extendPackageJson (json) {},
      // extendSSRWebserverConf (esbuildConf) {},

      // manualStoreSerialization: true,
      // manualStoreSsrContextInjection: true,
      // manualStoreHydration: true,
      // manualPostHydrationTrigger: true,

      pwa: false,

      // pwaOfflineHtmlFilename: 'offline.html', // do NOT use index.html as name!

      // pwaExtendGenerateSWOptions (cfg) {},
      // pwaExtendInjectManifestOptions (cfg) {}
    },

    // https://v2.quasar.dev/quasar-cli-vite/developing-pwa/configuring-pwa
    pwa: {
      workboxMode: 'GenerateSW', // 'GenerateSW' or 'InjectManifest'
      // swFilename: 'sw.js',
      // manifestFilename: 'manifest.json'
      // extendManifestJson (json) {},
      // useCredentialsForManifestTag: true,
      // injectPwaMetaTags: false,
      // extendPWACustomSWConf (esbuildConf) {},
      // extendGenerateSWOptions (cfg) {},
      // extendInjectManifestOptions (cfg) {}
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/developing-cordova-apps/configuring-cordova
    cordova: {
      // noIosLegacyBuildFlag: true, // uncomment only if you know what you are doing
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/developing-capacitor-apps/configuring-capacitor
    capacitor: {
      hideSplashscreen: true,
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/developing-electron-apps/configuring-electron
    electron: {
      // extendElectronMainConf (esbuildConf) {},
      // extendElectronPreloadConf (esbuildConf) {},

      // extendPackageJson (json) {},

      // Electron preload scripts (if any) from /src-electron, WITHOUT file extension
      preloadScripts: ['electron-preload'],

      // specify the debugging port to use for the Electron app when running in development mode
      inspectPort: 5858,

      bundler: 'packager', // 'packager' or 'builder'

      packager: {
        // https://github.com/electron-userland/electron-packager/blob/master/docs/api.md#options
        // OS X / Mac App Store
        // appBundleId: '',
        // appCategoryType: '',
        // osxSign: '',
        // protocol: 'myapp://path',
        // Windows only
        // win32metadata: { ... }
      },

      builder: {
        // https://www.electron.build/configuration/configuration

        appId: 'synth',
      },
    },

    // Full list of options: https://v2.quasar.dev/quasar-cli-vite/developing-browser-extensions/configuring-bex
    bex: {
      // extendBexScriptsConf (esbuildConf) {},
      // extendBexManifestJson (json) {},

      extraScripts: [],
    },
  };
});
