import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { usePatchStore } from 'src/stores/patch-store';

/**
 * Unit coverage for patchStore's dirty-tracking primitive: patchVersion /
 * lastSavedVersion / isDirty / notifyPatchChanged(). This is the mechanism
 * that replaced content-hashing (see TrackerSongBank.getPatchReuseKey and
 * IndexPage.vue saveSongPatch) for deciding "has the currently-loaded
 * patch actually changed since it was loaded or saved".
 *
 * Exercised directly against the store's state/getter/action rather than
 * through applyPatchObject()/serializePatch() (which pull in the full
 * instrument/layout/asset/macro store stack and a live instrument) --
 * those call sites' *use* of this primitive is covered by
 * tracker-song-bank-patch-signature.test.ts and the patch round-trip
 * tests instead.
 */
describe('patchStore dirty tracking', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('starts clean', () => {
    const patchStore = usePatchStore();
    expect(patchStore.isDirty).toBe(false);
  });

  it('becomes dirty after notifyPatchChanged()', () => {
    const patchStore = usePatchStore();
    patchStore.notifyPatchChanged();
    expect(patchStore.isDirty).toBe(true);
  });

  it('does not become dirty while a patch load is in progress', () => {
    const patchStore = usePatchStore();
    patchStore.isLoadingPatch = true;
    patchStore.notifyPatchChanged();
    expect(patchStore.isDirty).toBe(false);
    patchStore.isLoadingPatch = false;
    // Once loading finishes, still clean -- the mutation during load was
    // correctly suppressed, not merely deferred.
    expect(patchStore.isDirty).toBe(false);
  });

  it('becomes clean again once lastSavedVersion catches up (simulating a save)', () => {
    const patchStore = usePatchStore();
    patchStore.notifyPatchChanged();
    expect(patchStore.isDirty).toBe(true);

    // This is what saveSongPatch() does after successfully persisting a
    // serialized patch.
    patchStore.lastSavedVersion = patchStore.patchVersion;
    expect(patchStore.isDirty).toBe(false);
  });

  it('tracks a full load -> edit -> save -> edit cycle', () => {
    const patchStore = usePatchStore();

    // "Load": establishes a clean baseline (what applyPatchObject does at
    // the end of a successful load).
    patchStore.lastSavedVersion = patchStore.patchVersion;
    expect(patchStore.isDirty).toBe(false);

    // "Edit": a knob changes -- some mutation chokepoint calls this.
    patchStore.notifyPatchChanged();
    expect(patchStore.isDirty).toBe(true);

    // "Save": persisted, baseline realigned.
    patchStore.lastSavedVersion = patchStore.patchVersion;
    expect(patchStore.isDirty).toBe(false);

    // "Edit again": dirty again, independent of the previous cycle.
    patchStore.notifyPatchChanged();
    expect(patchStore.isDirty).toBe(true);
  });
});
