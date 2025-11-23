import { defineStore } from 'pinia';
import { uid } from 'quasar';
import { useInstrumentStore } from './instrument-store';
import type { PortId } from 'app/public/wasm/audio_processor';

export interface MacroRoute {
  id: string;
  macroIndex: number;
  targetId: string;
  targetPort: PortId;
  amount: number;
}

export const useMacroStore = defineStore('macroStore', {
  state: () => ({
    routes: [] as MacroRoute[],
  }),
  getters: {
    routesForMacro: (state) => (macroIndex: number) =>
      state.routes.filter((r) => r.macroIndex === macroIndex),
  },
  actions: {
    addRoute(route: Omit<MacroRoute, 'id'> & { id?: string }) {
      const newRoute: MacroRoute = {
        id: route.id ?? uid(),
        macroIndex: route.macroIndex,
        targetId: route.targetId,
        targetPort: route.targetPort,
        amount: route.amount,
      };
      this.routes.push(newRoute);
      this.applyRoute(newRoute);
      return newRoute.id;
    },
    updateRoute(route: MacroRoute) {
      const idx = this.routes.findIndex((r) => r.id === route.id);
      if (idx !== -1) {
        this.routes[idx] = { ...route };
        this.applyRoute(route);
      }
    },
    removeRoute(id: string) {
      const existing = this.routes.find((r) => r.id === id);
      this.routes = this.routes.filter((r) => r.id !== id);
      if (existing) {
        this.applyRoute({ ...existing, amount: 0 });
      }
    },
    applyRoute(route: MacroRoute) {
      const instrumentStore = useInstrumentStore();
      instrumentStore.connectMacroRoute({
        macroIndex: route.macroIndex,
        targetId: route.targetId,
        targetPort: route.targetPort,
        amount: route.amount,
      });
    },
    reapplyAllRoutes() {
      const instrumentStore = useInstrumentStore();
      this.routes.forEach((route) => {
        instrumentStore.connectMacroRoute({
          macroIndex: route.macroIndex,
          targetId: route.targetId,
          targetPort: route.targetPort,
          amount: route.amount,
        });
      });
    },
    reset() {
      this.routes = [];
    },
  },
});
